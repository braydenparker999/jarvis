# Drive to R2 music migration

## Status and ownership

This is a **clone**, followed by a separately verified playback cutover. Do not
delete or change sharing on the Drive originals. The frontend must remain at
`https://missionarytube.z13.web.core.windows.net/drawercast/` for Android access.

- Source: the configured `goated` Drive root, under `music-new`
- Source code: `braydenparker999/jarvis`
- Orchestration and Azure deployment: `braydenparker000/Missionarytube-`
- Manual workflow: `.github/workflows/migrate-music-r2.yml`
- Migration script: `scripts/migrate-drive-to-r2.py`
- Optional playback adapter: `public/drawercast/r2-api.js`

Checkpoint, 2026-10-01: the live catalog has 1,287 tracks / 4,989,786,207
bytes, all with source MD5s. The catalog's generation and shard hashes were
verified; metadata was ready for 1,281 tracks, with 1,274 prepared covers.
Re-inventory at transfer time; these counts are a checkpoint, not hard-coded
acceptance values. The earlier 1,286-track estimate is stale.

At this checkpoint no R2 transfer has been run or playback cutover deployed.
The successful migration-named Actions run at 02:49 UTC only syntax-checked the
script; its transfer job was skipped. R2 credentials and bucket variables were
absent in the orchestration repository. Cloudflare account/bucket/subscription
state could not be inspected because its dashboard security check blocked the
cloud browser. Existing Drive playback was smoke-tested successfully.

## Setup boundary

1. Select or create a **private, Standard-storage** R2 bucket. Leave its public
   access disabled for the clone. Do not enable a new subscription or change
   billing without the owner's approval. R2 has monthly usage charges; its
   Standard free allowance is not a spending cap.
2. The owner creates a bucket-scoped **Object Read & Write** R2 S3 credential
   (prefer an appropriate expiry) and enters it directly into GitHub Actions
   secrets. Never paste credentials into chat, code, commits, or logs.
3. Required repository secrets: `GOOGLE_DRIVE_API_KEY` (already configured),
   `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
4. Required repository variable: `R2_BUCKET`. Optional `R2_PUBLIC_BASE_URL`
   stays unset for a private clone. No public-domain setting is needed to copy.
5. The script currently uses the default R2 jurisdiction endpoint. A bucket in
   a special jurisdiction requires explicit endpoint support before running.

Verified setup pages:

- https://github.com/braydenparker000/Missionarytube-/settings/secrets/actions
- https://github.com/braydenparker000/Missionarytube-/settings/variables/actions
- https://developers.cloudflare.com/r2/get-started/s3/
- https://developers.cloudflare.com/r2/pricing/

## Transfer gates

1. Run the source JavaScript regression suite and Python migration tests. The
   orchestration workflow must use the exact source commit validated by its
   validation job, not a second mutable `main` checkout.
2. Dispatch `Clone Drive music to Cloudflare R2` with `limit=5` and
   `concurrency=4`. Confirm all five files pass source size/hash checks and a
   complete R2 GET size/hash readback. Inspect the report; HEAD metadata alone
   is not byte-integrity proof. Smoke output cannot enable playback.
3. Dispatch the same tested revision with `limit=0`. Allow it to finish; safe
   reruns check existing content bytes rather than trusting object metadata.
4. Require `mode=full`, `complete=true`, zero failures, matching selected,
   inventory and verified counts, and exact inventory byte totals. The source
   is re-listed before canonical publication; a changed inventory fails closed.
5. Save the report and review the canonical map. A private clone has blank
   playback URLs and remains unusable by the browser until delivery is approved.

Audio keys preserve the Drive ID and content version:
`audio/<drive-id>/<md5>.<extension>`. When no Drive MD5 exists, the version uses
the downloaded content's SHA-256, not file name or modification time.
Each verified file reports MD5, SHA-256, verified byte count and
`verification: r2-get-hash-v1`. The full report carries the same marker.

## Playback cutover

The browser keeps its Drive catalog, stable `gd_` track IDs, prepared artwork,
ratings, play counts, playlists and local/server sources. R2 changes only the
audio delivery URL. `r2ManifestURL` in `drive-config.json` defaults to an empty
string, so merely deploying this code cannot switch the live library.

Choose the delivery/privacy model with the owner before publishing files. An
R2 public development URL is public access and is not an authenticated private
delivery solution. Private playback needs a separately implemented authorized
delivery endpoint. The current optional adapter accepts credential-free HTTPS
manifest/media URLs; it does not add authentication, signed-URL refresh, or a
Worker by itself. Do not put R2 S3 keys in the frontend.

Before filling `r2ManifestURL`:

- Require a complete current-library map; no smoke, partial, stale, private,
  malformed or unverified map may switch playback
- Verify `GET`, `HEAD`, and byte `Range` reads, including a seek near the middle
  and end; require correct 206/Content-Range behavior and byte counts
- Configure/verify CORS for the exact Azure frontend origin, GET/HEAD, and
  `Range`; expose `Content-Length`, `Content-Range`, `Accept-Ranges`, and `ETag`
- Verify MIME types and existing catalog metadata/covers in Poweramp
- Verify repeat, shuffle, previous/next, pause/resume, seek, track switching,
  slow/failed R2 media, and recovery to Drive without losing position
- Verify the deployed source commit and CI before claiming a release
- Verify actual restricted Android/network and screen-lock/background behavior
  on the physical device; cloud-browser results do not establish that

The map is loaded in memory and does not rewrite exported track records. An
R2 media failure uses one bounded fallback to Drive and suppresses that failed
R2 revision for the current session. All library records must match Drive
ID, size and source MD5; records without source MD5 remain on Drive.

## Rollback and continuing work

Set `r2ManifestURL` back to empty and redeploy the previous known-good release
pin to return to Drive delivery. Azure's deployment workflow preserves existing
website bytes/properties before overwrites. Keep the prior Drive catalog,
source files and R2 generations until the owner explicitly approves cleanup.

For the next maintainer, including Muse: distinguish prepared code, successful
unit tests, actual copy completion, browser playback verification and device
verification. None implies the next stage. Check current Actions runs before
starting a duplicate transfer. Never infer credentials, approval, billing or
public-sharing permission from this document.
