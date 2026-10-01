# Read-only R2 music delivery

## Readiness versus execution

The owner approved playback by anyone with a music link on 2026-10-01.
`backend/music.js` implements the delivery endpoint; it is disabled unless
`MUSIC_PUBLIC_READ` is exactly `true`, `MUSIC_ROOT_ID` is configured and the
`MUSIC_R2` bucket binding exists. This commit does not add the binding, deploy
the Worker, turn on bucket public access, or update the live frontend.

The transfer remains incomplete: the last saved report verified 270 of 1,287
tracks (1,079,269,863 of 4,989,786,207 bytes). Google explicitly refused further
automated downloads. No full canonical mapping was published. Neither this
endpoint nor Poweramp treats that partial report as a complete library.

## Endpoint contract

- Worker: `jarvis-hub-api`
- Manifest: `/music/manifest.json`
- Audio: `/music/audio/<Drive ID>/<content hash>.<extension>`
- `GET`, `HEAD` and `OPTIONS` only; no upload, deletion, bucket listing or
  administration endpoints
- Only objects listed in the complete byte-verified canonical map can be read
- Manifest URLs are generated on the Worker origin; stored blank/private URLs
  do not need to be rewritten in R2
- Exact Azure-origin CORS; middle, suffix, open-ended and bounded byte ranges;
  proper 206/416 responses, ETag validation and HEAD metadata
- Object metadata, ETag and upload timestamp must still match the identity of
  the original byte-verified GET. Older reports without that identity fail
  closed until reverified. An ETag condition also pins each read to its HEAD
  result to reject concurrent replacement
- `private, no-store` responses avoid shared-cache exposure and make disabling
  the endpoint effective immediately. R2's original stored cache metadata is
  not copied into responses
- S3 credentials stay in the migration workflow. The Worker uses the binding,
  and the browser receives no storage credentials

The bucket binding technically permits reads and writes. This Worker route
implements reads only. CORS is not access control: the chosen public policy
also permits people to open audio links directly outside the Azure player.

## Deployment gates

1. Obtain approval to bind `jarvis-music` to `jarvis-hub-api` and deploy the
   tested change. Add a `MUSIC_R2` R2 binding to that bucket while preserving
   the existing `HUBS` Durable Object binding and migrations.
2. Use an approved deployment identity. Cloudflare documents Workers Editor
   for code deployment; a Worker Editor can deploy bindings without separate
   R2 permissions. Scope it to this Worker if the account supports that scope.
   The owner must enter any new token directly into the CI secret form.
3. Set Worker variables `MUSIC_PUBLIC_READ=true` and
   `MUSIC_ROOT_ID=1VlEUztloW5saoM7iF11fodDKSmCGP2ZZ`. Keep R2 bucket public
   access disabled; the Worker is the only intended music delivery route.
4. Resume the Drive copy only after the provider restriction is resolved by a
   supported process. Require full count/byte/hash verification and stable
   inventory before publication.
5. Verify the deployed endpoint's 200/206/416/HEAD/CORS behavior and sampled
   bytes against the saved SHA-256 hashes. Verify existing Worker inbox routes.
6. Set the Azure frontend's `r2ManifestURL` to
   `https://jarvis-hub-api.braydenparker999.workers.dev/music/manifest.json`,
   deploy the tested source pin and test playback/seek/fallback. Keep the
   frontend at `https://missionarytube.z13.web.core.windows.net/drawercast/`.
   Actual Android/background behavior still requires a physical-device check.

Rollback: clear `r2ManifestURL` to use Drive again. Disable `MUSIC_PUBLIC_READ`
to stop Worker delivery. Preserve original Drive files and R2 objects.

## Muse continuity

Keep the existing external Muse → Drive upload path. The existing catalog
publisher can continue supplying stable IDs, metadata and artwork. The opt-in
incremental mirror can reconcile new/changed Drive tracks after a complete
baseline exists, without giving Muse an R2 write credential. Scheduling the
mirror is a separate activation step; this change activates no recurring job.

## Supported recovery and references

Google's documented response to its automated-query message is its own
verification/troubleshooting flow and escalation to the site/network
administrator when the problem persists. The observed failure occurred on a
GitHub-hosted runner, so fixing a phone CAPTCHA is not evidence that this runner
has recovered. There is no documented guaranteed clearance time. Do not rotate
networks, impersonate another client or retry indefinitely to evade the refusal.

- Google: https://support.google.com/recaptcha/answer/6081888?hl=en
- Google: https://support.google.com/websearch/answer/86640?hl=en
- R2 Worker API: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- Worker permissions: https://developers.cloudflare.com/workers/authorization/#bindings
- CI deployment: https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/

Offline tests: `node --test tests/music-delivery.test.js`; full JavaScript
regression: `npm test`. These tests do not imply a deployed endpoint or a
completed transfer.
