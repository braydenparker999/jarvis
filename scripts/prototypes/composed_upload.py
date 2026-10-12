"""Narrow offline bridge: one shared preparation Pool into existing worker seam.

No provider acquisition, scheduling loop, runtime discovery or recovery API.
"""
import json
from pathlib import Path

from scripts.prototypes import worker_boundary as worker
from scripts.prototypes.artifact_budget import ArtifactBudget
from scripts.prototypes.upload_checkpoints import encode, sha, unique


def run_prepared(pool, context, manifest, claim, token, stops, command, decoder, *,
                 destination, recipe, timeout=900, decoder_timeout=300, budget=None):
    """command(report, attempt, claim, audio_path, prepared_path) returns child argv.

    revision is the claim generation; caller must preserve that binding when
    preparing ahead. Only already downloaded local bytes may enter the Pool.
    """
    if (context.job != claim.job or context.revision != claim.generation
            or context.destination != destination or context.recipe != recipe):
        raise worker.BoundaryError('Preparation context does not match current claim/recipe/destination')
    selected = {}
    def admit():
        taken = pool.take(context, claim.sha256)
        if taken is None:
            raise worker.BoundaryError('No current prepared artifact; no request made')
        lease, artifact = taken
        selected.update(lease=lease, artifact=artifact)
        try:
            tags = json.loads(artifact.metadata.decode('utf-8'), object_pairs_hook=unique)
            encode(tags)
            if type(tags) is not dict: raise ValueError('Metadata must be object')
        except Exception:
            raise worker.BoundaryError('Invalid immutable prepared metadata') from None
        selected['tags'] = tags
        return artifact.audio, 'audioAnalysis' in tags

    def child_command(report, attempt, current_claim, audio_path):
        artifact = selected['artifact']
        payload = {'metadataSha256': sha(artifact.metadata),
                   'context': {'job': context.job, 'revision': context.revision,
                               'recipe': context.recipe, 'destination': context.destination},
                   'cover': None}
        # Exact metadata bytes are retained, not regenerated from source/tag paths.
        metadata_path = Path(report).parent/'prepared-metadata.json'
        metadata_path.write_bytes(artifact.metadata)
        if artifact.cover is not None:
            cover_path = Path(report).parent/('cover.' + artifact.cover_ext)
            cover_path.write_bytes(artifact.cover)
            payload['cover'] = {'file': cover_path.name, 'sha256': sha(artifact.cover),
                                'size': len(artifact.cover), 'ext': artifact.cover_ext}
        prepared_path = Path(report).parent/'prepared.json'
        prepared_path.write_bytes(encode(payload))
        return command(report, attempt, current_claim, audio_path, prepared_path)

    def release_completed():
        lease = selected['lease']
        selected.clear()  # Drop payload before pool/token can admit replacements.
        pool.release(lease)

    # Audio+cover+metadata/report allowance; no change to the two-artifact Pool.
    budget = budget or ArtifactBudget(Path(manifest).resolve().parent, attempt_bytes=35*1024*1024)
    try:
        outcome = worker.run_attempt(manifest, claim, token, stops, child_command, decoder, None,
                    require_analysis=True, timeout=timeout, decoder_timeout=decoder_timeout,
                    budget=budget, prepared_admission=admit, prepared_completion=release_completed)
    except BaseException:
        pool.close()  # Drop next; preserve active lease and all durable holds.
        raise
    if outcome != 'completed':
        pool.close()  # Decoder failure is not permission to consume next track.
    return outcome
