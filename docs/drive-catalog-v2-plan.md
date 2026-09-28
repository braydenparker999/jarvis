# Poweramp Drive catalog v2 — implementation plan

Status: design, not implemented. This replaces the v1 `drive-prepared.json` metadata hint and the browser's recursive folder walker. The Drive folder remains the audio store. A separate, trusted online publisher owns the catalog.

## Why v1 still scans

`drive-prepared.json` v1 maps Drive file IDs to size, MD5, duration and some tags. It has no required filename, MIME type, folder path, deletion record or completeness guarantee. The checked-in `scripts/prepare-drive.py` only lists direct children of the chosen folder, although the player follows nested folders. The player therefore treats a `files.list` walk as authoritative on a new browser, on manual refresh and when the manifest signals an added or changed file. The last scheduling fix postponed that work during playback; it did not eliminate it.

## Ownership and boundaries

1. **Drive** stores music and the published catalog. The user may add, move, replace and delete music in the chosen root and its subfolders.
2. **Catalog publisher** is the only writer of catalog files. Run it online in a dedicated GitHub Actions workflow in the existing project, with an owner-authorized Drive OAuth credential kept in Actions secrets. A Muse upload may trigger the same workflow after its batch is complete; a 30-minute schedule and a manual workflow dispatch cover uploads made outside Muse. Serialize runs with workflow concurrency. Store the Drive changes token and last committed generation in Drive's private `appDataFolder` under the publisher account, not in the public catalog or an expiring Actions artifact. A daily complete reconciliation detects missed changes; an invalid changes token triggers a complete rebuild. Scheduled timing is best effort, so the UI displays the catalog's actual generation time.
3. **Browser** has read-only access to the public catalog and media IDs. It never calls recursive `files.list`, including on cold start or Refresh. It keeps the last verified catalog in IndexedDB. No OAuth refresh token enters the static site. The existing API key remains scoped to public reads.
4. **Audio engine** streams the selected Drive file by ID. Catalog publication, artwork preparation and listing are never dependencies of an already selected song's playback.

The publisher is the only component that may recursively list folders. Initial enrollment, recovery after a lost changes token and periodic reconciliation require that work. Those jobs run away from the listening phone. Google Drive's changes feed is the incremental input, with special handling when a whole folder moves into or out of the music tree. A publisher must have sufficient account scope to observe manual changes, not only files created by its own uploader. Google's changes feed and pagination are documented at https://developers.google.com/workspace/drive/api/guides/manage-changes and https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list.

## Published format

`assets/drive-config.json` gains a `catalogPointerId` for this managed root. The publisher updates the contents of that one stable Drive file only after an entire new generation is verified. The pointer is small:

```json
{
  "version": 2,
  "rootId": "ROOT_ID",
  "generation": "2026-09-28T19:00:00Z-unique",
  "publishedAt": "2026-09-28T19:00:00Z",
  "complete": true,
  "count": 1287,
  "shards": [
    {"fileId": "IMMUTABLE_SHARD_ID", "sha256": "64-lowercase-hex-characters", "bytes": 250000, "count": 400}
  ],
  "previous": {"generation": "PREVIOUS_GENERATION", "pointerFileId": "PREVIOUS_SNAPSHOT_POINTER_ID"}
}
```

Each immutable shard contains an array of tracks. Every track must include `id` (Drive ID), `name`, `relativePath`, `mimeType`, positive `size`, revision fingerprint (`md5` where available, otherwise a documented revision/size/modified-time fallback), `modifiedTime`, and `availability` (`ready`, `processing` or `blocked`). Prepared tags (`title`, `artist`, `album`, duration, codec, sample rate) and a prepared cover file ID/hash are optional. There are no arbitrary media URLs, API keys or private paths. Paths are relative to the configured root. The selected track remains usable if artwork is missing; a blocked track remains visible with a specific reason instead of failing mysteriously on Play.

Use bounded shards (target at most 512 KiB each) for 10,000+ tracks. Hash the exact uploaded bytes and include the count and length. The publisher validates unique IDs, valid parent paths, known audio types, nonnegative duration, bounded strings and total count before upload. It does not publish a partial scan. New tracks may first appear with filename-derived labels; tag and cover preparation can publish a later generation. The publisher deduplicates album covers and creates small thumbnails, so the phone no longer probes every visible audio file for embedded artwork.

## Publish transaction

1. Read the previous committed generation and Drive changes cursor. Gather all pages or complete a full reconciliation; fail the run if any page fails. Include nested folder moves and explicit deletions. Do not interpret an incomplete response or a timeout as mass deletion.
2. Merge by Drive ID, preserving unchanged prepared metadata only when the file revision matches. Obtain upload metadata directly from Muse when available; prepare manual uploads asynchronously with bounded media ranges.
3. Check public readability for newly added media before marking them `ready`. If a new file is private or still processing, publish it as `blocked` or `processing` and report the ID to the owner; do not present it as playable or silently omit it. Build every shard locally, validate the full snapshot, upload each shard as a new immutable Drive file, then read it back through the **public reader path** and check byte length and SHA-256. Never overwrite the current shards in place.
4. Write an immutable snapshot pointer with generation, root, shard hashes and previous generation. Read it back through the public reader path and verify it. Update the stable pointer file **last**, then verify its public read. Only after that succeeds, advance the private changes cursor. A crashed or incomplete run leaves the previous pointer valid; orphan shards can be cleaned later.
5. Keep at least two previous complete generations for rollback. A scheduled reconciliation compares the published IDs to a complete Drive listing; it publishes only a changed snapshot. Alerts report failed jobs and staleness, without embedding credentials or song URLs.

One publisher run at a time is essential. If an upload happens while a snapshot is being built, replay changes after the snapshot or process them in the next run. The pointer is the commit marker; a shard existing in Drive does not make it live.

## Browser state machine

1. **Boot:** load the last committed catalog and user data from IndexedDB immediately. Fetch the stable pointer by its configured ID; never enumerate folders. If its generation equals the cached one, stop with no track writes or redraw.
2. **Stage:** fetch the indicated immutable shards with at most four concurrent reads. Validate schema, root ID, generation, byte length, SHA-256, count, unique IDs, path bounds and revision fields. A malformed or missing shard rejects the entire generation. Retry transient errors with bounded exponential backoff and jitter.
3. **Commit:** in one IndexedDB transaction, write the new Drive tracks and committed generation, then remove only Drive tracks absent from a *fully verified* generation. Preserve ratings, playlists and play counts by stable ID. Preserve embedded art/tags only for the same revision. Moves update paths without changing identity. A newly uploaded replacement with a new Drive ID is a new song unless the publisher supplies an explicit `replacesId` mapping; do not guess based on title.
4. **Render:** swap library indexes after the transaction commits. Do not tear down the current audio element for a metadata-only update. If the selected file was deleted, let the current buffered play finish when possible and show that it is unavailable for the next selection; avoid surprising mid-song stop.
5. **Refresh:** poll the small pointer on visibility and a relaxed timer (for example five minutes with jitter), or on manual Refresh. Manual Refresh asks the publisher to reconcile if an authenticated control endpoint exists; it does not start a browser folder walk. Poll only when online and avoid work while audio is acquiring a buffer.

If the pointer or a shard is unavailable, corrupt, or temporarily unpublished, retain the last committed catalog and show `Saved catalog · update delayed`. If the browser is new and there is no valid catalog, show `Catalog temporarily unavailable` with Retry; never present a partial library as authoritative. On version mismatch, keep the cache and request a compatible client update. Browser storage failure should leave the in-memory library usable for that session and report that it will need another catalog load next time.

## Playback and failure policy

- Priority: current media request, then an explicitly selected next song, then cover work, then catalog polling. The publisher runs independently and cannot take the phone's network slots with a folder walk.
- Direct `files.get?alt=media` remains the primary stream. A play failure retains the playhead, retries a fresh request with a small bounded backoff and does not auto-skip an entire queue. Distinguish browser media error codes, offline state and persistent permission errors in user-visible diagnostics. Never expose the API key in logs or diagnostics.
- A manifest cannot make an unavailable Drive file stream. Drive may return a rate limit or a transient server error; Google recommends exponential backoff for 403 rate-limit and 429 errors. See https://developers.google.com/workspace/drive/api/guides/handle-errors and https://developers.google.com/workspace/drive/api/guides/limits. The browser media element does not reliably expose the underlying HTTP response status, so claim only the cause it can actually observe.
- Optional offline guarantee: explicitly cache chosen playlists or recent songs as complete verified files within a user-selected storage budget. Only those cached bytes can play without Drive or internet. Do not claim general offline availability from cached metadata alone. A15 playback remains a separate source and is not a silent substitute for a missing Drive file.

## Migration and acceptance gates

1. Build a v2 publisher against a test folder with nested albums and manually changed files. Do one publisher-side full walk and validate its exact ID set against Drive. Confirm the OAuth scope can see manual additions and deletions.
2. Publish a complete v2 generation for the real root **before** shipping the v2-only reader. Compare ID count, paths, size and a sample of media/cover reads to the current library; record the generation and rollback pointer. Keep v1 untouched during this check.
3. Release a reader that uses the v2 pointer and cached snapshot. Remove the browser recursive `api.list` path and its automatic/background calls. If v2 is not ready, show cached v1 songs and a clear migration status; do not silently perform another phone scan.
4. Test cold browser, warm reload, 10,000-song catalog, slow and corrupt shard, partial publish, pointer race, invalid changes token, a moved folder, deletion, replacement, offline state, 403/429/5xx, pause/resume, next/seek, screen lock and storage exhaustion. Verify that the browser sends **zero** folder-list requests in normal use and that a failed update never removes saved tracks.
5. Test actual playback and background behavior on the restricted Galaxy A15. The cloud browser verifies desktop routing only. Roll back by restoring the previous stable pointer or deployment pin; never delete the last good browser snapshot on a failed migration.

This design removes repeated phone-side scanning and makes catalog failures non-destructive. It cannot make a third-party stream literally always available. To promise playback without a working Drive connection, the audio bytes must also be cached locally or available from the A15 source.
