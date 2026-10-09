# Original YouTube dates: ingestion and backfill review

My Media reads an optional `jarvis-video-metadata.json` at the configured Drive
root. The media listing remains available when metadata is missing, invalid,
ambiguous or inaccessible; the returned inventory includes `metadataStatus`
for diagnostics. No page layout, styling, controls or playback flow changes.
The listing includes file MD5 checksums when Drive supplies them, for scope
comparison. Date provenance survives ingestion and validated browser caching.
Duplicate or contradictory metadata identities do not silently pick a row.
Sparse metadata rows retain already known dates and other known fields.

`upload_date` / `youtubeUploadDate` identifies an original date in UTC.
`timestamp` / `youtubePublishedAt` identifies publication and remains distinct.
Drive creation/modification, yt-dlp extraction `epoch`, filename dates and
unproven archive `published_at` are never treated as original upload dates.
Provenance records its source and kind, the YouTube ID, a sidecar SHA-256 when
available, and separately labeled extraction time. Raw yt-dlp payloads, URLs,
cookies and credential fields never enter prepared metadata.

## Preparing a review

Take a complete, read-only My Media inventory snapshot using `createVideoApi.list`
with the existing authorized public configuration. Save the returned object
locally, outside the repository. Include the current manifest separately if
`metadataStatus` is anything except `missing`. An unreadable current manifest
must be recovered and reviewed before it can be used as the baseline.

Run the planner using existing `.info.json` sidecars:

```sh
node scripts/backfill-video-dates.mjs \
  --inventory /tmp/mymedia-inventory.json \
  --existing /tmp/current-jarvis-video-metadata.json \
  --sources /path/to/existing-sidecars \
  --out /tmp/mymedia-date-review-1
```

Omit `--existing` only when the complete inventory confirms the manifest is
missing. An optional `--archive-state /path/to/archive.json` accepts only valid
`youtube_upload_date` with explicit `youtube_date_source: "yt-dlp.upload_date"`.
No new credentials or YouTube requests are performed. Only JSON metadata is
read; media bytes and remote files remain untouched. Every invocation is a
dry run and requires a new output directory; there is no apply/upload mode.

The directory contains `video-date-backfill-plan.json` and
`jarvis-video-metadata.candidate.json`. The plan binds review scope to a hash of
the exact folder/media identities, sizes, modification times and checksums,
and hashes the current and proposed manifests. Per-video statuses distinguish
`would_add_upload_date`, `already_dated`, `needs_upload_date_source`,
`no_youtube_id`, `invalid_existing_date`, `existing_identity_conflict` and
`source_date_conflict`. Existing valid dates, newer unrelated metadata and
orphaned manifest records remain unchanged. Candidates add only the date and
provenance to an existing row, or a minimal row identifying the existing file.

After owner review, any separately authorized publication must reread the
complete live inventory and current manifest and stop if either hash changed.
Uploading even an unchanged candidate, collecting source metadata in a batch,
or altering sharing/settings is a separate action needing exact scope review.
The planner does not implement or trigger that action.

## Local metadata builder

`node scripts/build-video-metadata.mjs /path/to/downloaded-videos` still creates
a first local manifest from existing sidecars. When a manifest already exists,
it preserves all nonempty existing fields and orphaned rows and emits the
exclusive `jarvis-video-metadata.candidate.json` instead of replacing it. A
malformed baseline or preexisting candidate stops the command. Source scanning
is deterministic and does not follow symlinks. Conflicting sidecar dates or
duplicate existing identities are reported and preserved for review.

`node --test tests/mymedia-backfill.test.js tests/mymedia-metadata.test.js
tests/mymedia.test.js tests/media-discovery.test.js` covers provenance, calendars,
identity conflicts, idempotency, preserved metadata, dry-run artifacts,
fingerprint changes, builder safety and optional-manifest failures. The full
repository suite should also pass before integration. None of these tests
claim that the live library has been migrated.
