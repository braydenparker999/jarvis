# Shared-project inbox local qualification

Base: `release/astra-live-backport-20261009` at
`97b048abfde97426da7b5eb3a310964631ce724c`. No production activation occurred. A read-only aggregate owner subscription
status check at18:50:51UTC confirmed existing owner authorization; no message
history was read and no grant or subscription was changed.

## Results

- Final focused suite: **21 passed, 0 failed, 0 skipped**, including **16 Python
  adapter cases** under its Node test wrapper. See [focused.tap](focused.tap).
- Existing Relay + public/shared/Hub/origin qualification with pinned runtimes:
  **1,335 passed, 0 failed, 0 skipped**. See
  [summary](relay-regressions-summary.txt). The final reply-timeout recovery
  guard and strict admin validation were also independently checked against the
  final focused suite; the aggregate was already running while those small
  project-only changes were finalized. CI must qualify the final committed tree.
- Before installing the repository-pinned runtimes, the nonbrowser Relay set
  passed **1,163/1,163**. An initial aggregate attempt used Node24.19/Chromium151 and
  failed the repository's exact-runtime browser gate; this was resolved using the
  approved Node24.21.0 and archive-verified Chrome154.0.8037.97, not by changing
  test assertions or disabling browser checks.
- Actual workerd HTTP and SQLite disk persistence tested across isolate restart;
  no outbound service calls allowed. Python-generated HTTP JSON exercised valid
  3,000-emoji and 6,000-escaped-control-character replies through actual workerd.
- `git diff --check`, Python compile checks, and production Worker esbuild bundling
  passed. The workerd integration also bundles all production Worker imports.

Commands (local runtime paths are execution-environment artifacts):

```sh
/tmp/node-v24.21.0-linux-x64/bin/node --test tests/relay-projects.test.js tests/relay-project-hook.test.js tests/relay-project-workerd.test.js tests/relay-project-hook-integration.test.js
JARVIS_CHROME=/tmp/jarvis-qualification-browser/installed/chrome-linux64/chrome CHROMIUM_PATH=/tmp/jarvis-qualification-browser/installed/chrome-linux64/chrome REQUIRE_RELAY_OWNER_BROWSER=1 /tmp/node-v24.21.0-linux-x64/bin/node --test tests/relay-*.test.js tests/publications.test.js tests/shared.test.js tests/hub.test.js tests/origins.test.js
python3 -m py_compile scripts/project-inbox-hook.py scripts/lib/project_hook.py
```

The existing pinned-browser installer verified official archive SHA-256 before
execution. The official Node archive was checked against its published SHA-256.
`validation.json` records runtime identities, implementation hashes and log hashes.
Full local aggregate log: `/tmp/project-relay-qualified-final.tap`.

## Independent review

A separate review agent inspected the implementation and management tools,
ran focused tests, and used independent SQLite/slow-transport reproductions.
Its final review reported **no remaining blocking findings** in this scope.
It did not edit repository files or contact external services.

| Finding | Resolution / evidence |
| --- | --- |
| Replies/notes ACKed without reaching host | Durable notification dispatch keys plus separate local consumption receipts; replay after journal loss. |
| History limit could strand an accepted request's reply | Reserve one answer slot per unfinished request; actual 20,000-row boundary test. |
| Python/JS Unicode length and whitespace mismatch | UTF-16 and ECMAScript whitespace validation before staging. |
| Valid escaped JSON exceeded request byte limit | 40k streamed cap, UTF-8 encoding, real Python/workerd boundary tests. |
| Uncertain final result left local journal unresolved | Durable completed receipts and server terminal-result reconciliation. |
| Long polls blocked renewal; socket timeout was not a total deadline | Hard SIGALRM deadline, bounded per-request timeout, mutation contention exit75. |
| Slow notification hydration retried same page forever | Persist each hydrated body; independent 50-event interrupted-poll reproduction passes. |
| Interrupted work scans could starve later work | Durable cyclic work-page checkpoint independent of event ACKs. |
| Ambiguous host expiry could trigger another model run | Persist unknown, require explicit outcome reconciliation, and always hold unverified result reports. |
| Timeout after accepted reply over-held safe reconciliation | Permit report-only recovery using the immutable reply; no replacement or model rerun. |
| Rollback revocation order was ambiguous | Document revocation before transport disable or approved maintenance before reactivation. |

The final independent review re-ran all 21 focused Node tests, including the
16 Python cases, and reproduced accepted-reply timeout reconciliation. The tests
also cover streamed revocation and reverse-direction requests. The independent SQLite probe is available locally at
`/tmp/jarvis-project-review.mjs`.

## Remaining live gates

Use [the exact activation and rollback plan](../../relay-shared-project-inbox.md).
Parent must verify both hosts' authenticated HTTP and durable model-dispatch
contracts, approve each project credential/grant at action time, integrate the
reviewed release, and coordinate deployment/cutover. Existing owner OAuth may
administer grants through the separately enabled management tools; project agents
never receive owner tokens or owner-private history. Transport acceptance is not
model wake, execution success, or proof of external side effects. No true inbound
host push or exact billing has been established by these local tests.
