# Relay and Muse adversarial QA

The independent QA fixtures use the real Worker routes, SQLite implementation,
OAuth registry and owner controller. Every account, credential, request, reply and
correction is fictional and ephemeral. Browser contexts are offline; CDP forwards
only approved fixture requests with the browser's original Azure Origin and
CORS behavior. Unexpected egress, browser exceptions and origin failures fail the
checks. No production message is sent or replayed.

The approved toolchain is Node 22.23.3 or 24.21.0 and Google Chrome for Testing
154.0.8037.97. The browser helper checks both identities and does not substitute
another browser or change security settings. Release qualification requires the
browser and includes every `tests/relay-*.test.js` file automatically.

| QA deliverable | Behavior exercised |
| --- | --- |
| `tests/relay-conversation-adversarial-browser.test.js` | Scope switches, expiry, reload, late responses, separate drafts, Back, keyboard, reading anchors, inert attacker text, save uncertainty, actual cancellation acknowledgement, callback versus linked retry, corrected private results and offline execution evidence. |
| `tests/relay-owner-jobs-adversarial.test.js` | Public/Muse authority denial, grant-bound execution, duplicate callbacks and events, expiry, cancellation, duplicate-risk retry limits, racing attempts and immutable public publication. |
| `tests/relay-owner-jobs-ui-adversarial.test.js` | Strict private provenance, bounded associated correction history, stale-response rejection, retained send UUIDs, mutable job refresh, network failures and local validation. |
| `tests/relay-public-delivery-adversarial-browser.test.js` | Held initial reads, lost accepted/unreceived POST receipts, rejection, stale paginated history, more than 250 online rows, exact UUID collisions, independent tabs, blocked draft storage and partial enqueue recovery. |
| `tests/relay-public-store-adversarial.test.js` | Full board history across tab writes, failed independent draft persistence, a deterministic 49-to-51 queue admission race and exact-acceptance journal draining. |
| `tests/helpers/relay-conversation-browser-fixture.js` | Qualified browser, real authenticated routes, fail-closed CDP routing, held/aborted requests, storage inspection and synthetic evidence capture. |
| `tests/helpers/relay-conversation-evidence.mjs` | Reproducible baseline/current owner, public and Muse captures at four viewport sizes. |

Existing owner UI and browser assertions retain authentication and private-content
persistence requirements while allowing only the exact safe `owner`/`public`
scope preference. Page-only access, expiry and disconnect stay in the private
sign-in-required view until an explicit Public chat choice. The password-browser
CDP helper ignores an invalid interception only when that exact Network request
was proven cancelled, or the page is explicitly closing. Other fulfillment,
Origin and security errors remain fatal.

The visual matrix covers 360×800, 390×844, 412×915 and 1280×900. Captures record
viewport width, document width and visible control geometry. Main controls meet
48×48px targets, and the inspected views have no horizontal overflow. Short-height
checks reduce the viewport by 320px and confirm the composer remains visible;
they model available space and do not establish physical phone keyboard behavior.
Enter inserts a newline and Ctrl+Enter sends one request. Private reading anchors
are memory-only and remain stable across in-page scope changes and new progress.
An open long inspector keeps disclosure state and its visible text through an
actual authenticated lifecycle or correction update.

The initial slow-read regression reproduces the reported missing Muse/Relay send
using fictional text: queue a request during a held initial GET, then release the
old snapshot. The prior implementation loses the visible row and queued body
without a POST. The fixed path must retain the original UUID and payload until an
exact accepted entry proves acceptance. Pending-queue absence alone is never used
as proof. Public and Muse fixtures also preserve accepted immutable entries when
a later paginated response is stale.

Corrections retain the original accepted private chat reply and original job
result. The latest correction has an exact original-reply association, distinct
record ID, bounded ordered history, explanation and authenticated private
provenance. Tests reject malformed or forged projections and verify inert unsafe
links/text. Authentication identifies the publisher; the UI does not claim that
it verifies the correction's factual content. A public Muse correction using the
same reply target cannot replace the first accepted public reply or finalize a
private job.

An offline private refresh displays retained evidence as Last known. A locally
elapsed execution window becomes acknowledgement expired with outcome unconfirmed;
it does not mutate the server stage or create retry permission. A callback receipt
cannot establish execution or acknowledge cancellation. Cancellation remains
requested until the matching authenticated assistant acknowledgement. Retrying
delivery keeps the request UUID, while an allowed work retry creates one distinct
linked child and preserves duplicate-risk restrictions.

Final validation passed **757/757 tests**, with no failures, cancellations or
skips, using Node 24.21.0 and Chrome 154.0.8037.97. This includes the existing
owner/password browser journeys and all final recovery/security regressions.
The five new QA test files contribute 38 top-level cases and 62 counted tests,
including each Relay/Muse child journey. The full mandatory Relay command was:

```sh
REQUIRE_RELAY_OWNER_BROWSER=1 JARVIS_CHROME="$QUALIFIED_CHROME" \
CHROMIUM_PATH="$QUALIFIED_CHROME" PLAYWRIGHT_CHROMIUM_EXECUTABLE="$QUALIFIED_CHROME" \
"$QUALIFIED_NODE" tests/helpers/ci-test-inventory.mjs run relay --require-browser
```

The final log is `relay-final-inventory-node24.tap` in the synthetic evidence
directory `/tmp/jarvis-relay-qa`. The QA manifest records toolchain identity,
source and artifact SHA256 hashes, viewport geometry and the separate earlier
failing baseline proofs. All 310 recorded implementation/test/toolchain source
files remained unchanged during and after the final run. This establishes the
tested working-tree content; the release owner's committed-head qualification
remains the publication proof. The earlier 738/738 Relay run predates the
additional storage and offline regressions and is superseded.

Final recovery checks prove that a durable journal followed by a failed per-tab
draft clear is recovered under its original UUID without offering that submitted
intent for another Send. A separately edited draft survives. A permanent pending
UUID conflict retains its original unsaved payload and visible attention state
while a different intent is accepted once. Previously accepted immutable-content
divergence still fails closed. Synthetic credential-bearing HTTP(S) links in
saved private results and corrections retain their text without becoming anchors.

Synthetic screenshots and fixture results do not establish live assistant tool
availability, production deployment, physical phone keyboard behavior or
owner-phone acceptance. No product failure remains in the qualified fixture run.
