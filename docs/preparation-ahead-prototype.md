# Bounded immutable preparation ahead — offline candidate 2

This is an isolated admission/ownership helper, not Mast's private wrapper or an
installed queue. It overlaps LOCAL preparation of at most one next track with
one existing serialized upload chain. Provider downloads retain their existing
pacing and concurrency. No provider fetch, HTTP request, signature, worker,
schedule, credential or FFmpeg process is created by this module.

## Implemented invariants

`scripts/prototypes/preparation_ahead.py` exposes one shared `Pool` owned by one
proposed coordinator. It admits at most one active lease and one next reservation
or artifact. Three concurrent producer fixture threads share that same pool;
only one obtains the next slot. A reservation is required before source read or
preparation. **One Pool per Mast worker would violate the global bound and is
not an integration option.** Multi-process IPC/coordinator integration is absent.

Artifacts are frozen records of immutable audio/cover/serialized metadata bytes.
The extractor receives the same audio bytes later returned to the consumer;
SHA256 is computed from those bytes. The consumer must hash/sign/PUT those same
bytes with a fresh signature through the existing single chain. No path reread
may supply different upload bytes. The metadata serialization must come from
that snapshot and the reviewed preparation recipe. A mutable buffer is rejected.
Empty picture bytes become no cover; no artwork PUT or registration reference
may be emitted for them. This does not replace Mast's reported extraction guard.

An opaque token identifies each reservation; a stale or cancelled producer cannot
publish into a replacement slot. Cancellation of running preparation retains its
slot until local work finishes. Failure/cancellation discards payload references
before another producer can enter; sanitized exceptions do not retain abandoned
media via their traceback/context. Closing rejects new work but retains the
active lease. Release requires the exact active token.

Before upload, the coordinator rechecks current stable job ID, revision,
preparation recipe/options/version, destination, source snapshot SHA256 and age.
Mismatch discards the queued result. TTL includes preparation and waiting time;
it is NOT permission to cancel an upload or reclaim an ambiguous request. TTL
does not forcibly interrupt a hung callback. Unstarted reservations need explicit
coordinator cancellation; hung work needs a separately reviewed bounded process
termination/join path before freeing its slot. No overlapping replacement work.

## Resource model and precise limit

Per artifact: audio <=32 MiB, cover <=2 MiB, serialized metadata <=16 KiB.
Two artifacts retain at most **71,335,936 payload bytes (68.03125 MiB)**. Admission
reserves a full artifact budget before local work. Oversize reads request only
32 MiB plus one sentinel byte and are rejected before extraction. This API cannot
force a malicious reader to obey its requested limit; the reviewed local reader
must obey it. Retained prepared payload and reserved slot ceilings are separate
from total RSS. A bounded reader may temporarily allocate the sentinel byte.

Python objects/allocator copies, parsing workspace, callback-owned buffers,
FFmpeg memory and any consumer reference retained after release are additional
costs. The coordinator must drop consumer references before releasing the active
slot. It must enforce a separate process memory/CPU/temp-disk/time budget for
real parsers or optional analysis, including cancellation cleanup; this prototype
does not claim a hard process-RSS ceiling. Provider buffers must not be duplicated
into a third unaccounted prepared artifact. In-memory state is disposable after
restart; it never supplies a receipt or proof that a remote mutation finished.

## Synthetic comparison (ten tracks, seconds)

Reproduce with `python scripts/prototypes/preparation_model.py`. Assumed provider
input-availability timestamps are identical in each pair, and network chains
never overlap. The model has one next slot and includes no real network, CPU,
FFmpeg, rest/backoff or target-memory measurements. The exact Mast per-worker
adaptive rest schedule must remain unchanged; it is not inferred by this model.

| Assumed local prep / upload | Other constraint | Serial | Ahead | Difference |
| --- | --- | ---: | ---: | ---: |
| 0.2 / 20 | None | 202 | 200.2 | 1.8 saved |
| 10 / 20 | None | 300 | 210 | 90 saved |
| 10 / 20 | Inputs available every 40s | 390 | 390 | Zero |
| 0.2 / 20 | 3s added prep overhead | 202 | 203.2 | 1.2 slower |

These are illustrative schedules, not measured service times or live throughput
claims. Unlike checkpoints (which save acknowledged blob re-sends on eligible
retries), prep-ahead can reduce serial local work on first attempts, but only if
that work currently occupies the upload token and overlaps useful work. Mast's
lock-held preparation/analysis timing is still unverified. Its upload path has no
per-track model invocation and no per-upload playback check to eliminate.

## Exact blocked integration seams / proposed safe rollout

1. Refresh current Mast uploader/worker/watchdog source hashes and process binding
   after the reported VM restart. Obtain the pending four-bundle contract in
   `mast-checkpoint-adapter-contract.md`, including where local preparation and
   optional analysis occur relative to the actual shared token.
2. Select one global coordinator with IPC/ownership for the existing three workers.
   Preserve current provider admission and completion order; prepare only an
   already downloaded, validated local snapshot. No extra download is launched
   just because a prep slot is available. Decide stable job/revision/recipe fields
   from real code rather than inventing a second manifest schema.
3. Adapt snapshot-based tag/cover extraction, metadata and optional analysis to
   immutable bytes or a protected bounded snapshot file. Confirm callbacks have
   no network calls. Enforce and test real parser/analysis resource limits, cleanup,
   byte ownership, freshness recheck and shutdown/join behavior.
4. The existing whole-chain flock stays around every network mutation and all
   existing completion/duplicate-correction obligations. Move only proven-pure
   local work outside it after wrapper review. Queue availability cannot shorten
   provider pacing, adaptive rest, backoff or bypass AUTH-STOP/validation stops.
   Ambiguous upload/analysis outcomes remain quarantined; releasing a lease or
   losing the queue on VM replacement is not reconciliation.
5. Run offline fixtures against the actual adapter/supervisor, independently review
   the resulting exact diff, then bring one coordinated process-transition plan
   to the parent. Drain/join old producers and ensure no overlapping old/new upload
   chains; retain unresolved-job state. Rollback disables new prep admission,
   cancels/joins local prep, and drains any active chain without deleting journals.
   No current flag activates this helper; no live cutover was performed.
6. Only after the coordinated plan is approved, measure actual service-time and
   resource effects with existing safety gates. Publication as a draft PR is
   development review, not authorization for this agent to restart workers.

Tests: `python -m unittest discover -s tests -p test_r2_preparation_ahead.py -v`.
Evidence: `docs/evidence/preparation-ahead/`. This candidate does not install the
checkpoint candidate or assume any previous design is running.
