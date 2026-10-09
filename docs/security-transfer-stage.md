# Podcasts and Quick AI transfer stage

This branch starts at Jarvis `ea9c09c1ddb172c1f0d668b58a5e7066f1c8318f`,
the merged PR73 release. It preserves the accepted page design and does not
modify origins, bearer credentials, session lifetimes, grants, OAuth scopes,
security settings, deployments, subscriptions, schedules or media uploads.
There is no evidence of compromise in this review.

## Deployable code

Podcasts fetches JSON through the existing Worker and the two existing Apple
search endpoints. It retains the independent gpodder Worker fallback. Client
requests omit credentials and referrers, reject redirects, enforce a response
size/time bound and never request callbacks or evaluate a response. Apple
currently returns ordinary JSON with a `text/javascript` MIME and wildcard
CORS; requiring an `application/json` MIME would incorrectly reject those
real responses. Two read-only response snapshots from 2026-10-09 are committed
under `tests/fixtures/podcasts`. They contain public directory data only. The
gpodder endpoint returned403 during this environment's probe; its existing
server fallback remains available but live success here is unverified.

Apple's [provider documentation](https://performance-partners.apple.com/search-api)
defines the existing query parameters and JSON result fields. Provider CORS
availability is an observation of the captured responses, not a permanent
provider guarantee. If a browser cannot read Apple JSON, the real Worker
search remains available; complete provider failure yields the existing retry
state. The service-worker shell revision includes the new directory module
and removes the old shell on activation.

Quick AI asks the user to choose **Owner chat · private** or **Public Relay ·
shared** before preparing a transfer. The tab-local v2 envelope binds that
destination to its visibility and never contains a credential. A remembered
mode cannot override that choice. Legacy text-only transfers require an
explicit destination. Transfers only prepare a composer; no transfer handler
calls a send, creates a job, changes a grant or makes an execution claim.

An existing destination draft is retained and separated from the incoming text.
If the combined text exceeds4,000 characters, both drafts remain saved and
the user can shorten the existing draft and retry. Long Quick AI answers keep
the existing bounded transfer behavior with an explicit shortening notice;
the complete source chat and its unsent draft remain in Quick AI. A pending
transfer cannot be overwritten by another one. A write-ahead before/after
record makes interrupted draft adoption recoverable without appending twice.
If text changed after an interrupted write, the transfer remains pending for
manual review rather than overwriting the edit.

Unsent private composer text now survives navigation and confirmed session
expiry in **sessionStorage for this tab**, under a separate owner-draft key.
Only its body is saved; authenticated history, device metadata, passwords,
failed-send credentials and bearer tokens are not copied there. Expiry still
clears authenticated history and removes access; the private composer remains
unavailable until successful sign-in or pairing. Drafts never enter the public
store or public composer. Revocation, deliberate disconnect and a credential
replacement reported by another tab clear the private draft and history.
Successful explicit sending clears the draft. Closing the tab ends ordinary
tab storage; browser session restoration behavior is browser-controlled.

## Security decisions requiring separate approval

Remembered owner bearers still use localStorage on the shared origin. Any
script executing in that origin can access them. Removing Podcasts JSONP
closes this unnecessary provider execution path; it does not isolate all
sibling applications or address every executable dependency on that origin.
Tab-local draft storage likewise is not an origin isolation boundary.

Current device sessions can list other devices and revoke them, and can
prepare account credential changes; the existing credential change path also
requires current-password verification and explicit consent. Those runtime
capabilities are unchanged. `security/relay-owner-capability-plan.js` prepares
a pure, tested proposal: device capabilities for private chat/work and self
revocation, with separate fresh owner administration for device enumeration,
other-device revocation, pairing approval and credential management. It is
absent from both deployed dependency graphs and cannot authorize anything.

The project owner must separately approve the concrete owner-origin/storage migration,
any CSP restriction (including removal of the now-unused Apple script source),
and any device administration/step-up policy change before runtime enforcement.
Session durations and existing grants must not change as a side effect. Decide
how pending drafts and ambiguous failed-send IDs should migrate if that later
policy changes. Draft persistence here does not persist an execution retry ID
or authorize retrying consequential work.

## Integration and verification

The core owner integrates the narrow `public/assets/app.js` transfer hunks;
polling, jobs and event logic belong to that owner. No Poweramp/Astra files or
CSS are changed. MissionaryTube main still pins an earlier source; release
pinning and promotion require separate approval after integration and the required
qualification. Draft source PRs provide code for review; merging and deployment
are separate release actions.

Run the targeted transfer/provider suites, the existing owner isolation
journeys, the complete repository tests and a Worker bundle. The local
environment provides Node24.19.0 and Chromium151.0.7922.173. Results with those
tools are local regression evidence; they do not replace the exact hosted
qualification recipe requiring Node22.23.3/24.21.0 and Chrome154.0.8037.97.
