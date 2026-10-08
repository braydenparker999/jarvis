# Public communication repair contract

Review base: `8fb73ad115c53e904844d3d5643c3fd9911370f8`. Production source at
the start of this repair: `c4d62409a3b67e4e5dac88809c6a4a0290b6e39e`.
Deployment review base: `bf12a379754225db770429d01bf730758fab9a4b`.

This repair preserves the existing Relay/Muse conversation design, Poweramp,
Astra, current schedules/subscriptions, authentication and credentials. It
does not activate a Muse hook or prove that Muse supports direct push. Promotion
requires independent parent review after exact-head qualification.

## Append-only public format

Publish one JSON object per comment in the existing fixed issue
`braydenparker999/jarvis#2`. Existing `jarvis-publication-v1` replies/briefings
continue working. Use this additional format for receipts, progress, final
results and corrections:

```json
{
  "schema": "jarvis-coordination-v2",
  "eventId": "11111111-1111-4111-8111-111111111111",
  "requestId": "22222222-2222-4222-8222-222222222222",
  "attemptId": "33333333-3333-4333-8333-333333333333",
  "stage": "final",
  "resultVersion": 1,
  "body": "Fictional source artifact is ready.",
  "artifacts": [{
    "id": "44444444-4444-4444-8444-444444444444",
    "revision": 1,
    "label": "Fictional source artifact",
    "url": "https://example.test/source-a"
  }]
}
```

`requestId` is an exact existing **public** user message UUID. An `attemptId`
belongs to one request; independent responders use independent attempts. It is
a correlation ID, not an execution claim or lock. Every event has its own stable
UUID. Preserve the complete payload and event ID after a lost write response.
Canonical JSON key order is immaterial; text whitespace, artifacts, revisions,
IDs and every other submitted field are compared exactly. New GitHub comment
metadata does not alter an already accepted event's provenance or server time.
A reused event ID with different payload is an explicit conflict.

`receipt`/`progress` require `artifacts: []`, and omit result version/predecessor.
`final` has version 1 and no predecessor. A `correction` requires version N >= 2
and `supersedesEventId` referencing the exact accepted result at N-1 for the same
request/attempt. An unavailable predecessor stays durably pending. Same-version
races, wrong predecessors and decreasing/changing equal artifact revisions
remain explicit conflicts; they never replace accepted data. New artifacts may
be introduced and omitted artifacts are removed from that version's result.
The result includes the complete artifact list for that version.

Bodies have a 6,000-character cap. At most eight artifacts, each with a stable
UUID, positive revision, 120-character label and a bounded HTTPS URL without
credentials or a nonstandard port, are accepted. Unknown fields are rejected.

The first accepted final supplies a single immutable chat reply for v1 readers
and existing pending queues. Later results, including corrections and finals
from other attempts, are separate public reports. No global winner is inferred
between independent responders. Original replies, initial holds and older
artifact revisions stay readable. The new client labels report kind/version,
provides accessible artifact links and source details in the existing message
menu, and preserves bookmarks, search, keyboard/scroll behavior and drafts.

Historical/new conflicting v1 replies are recovered from the durable importer
journal as `jarvis-publication-v1-update` reports, marked `legacyConflict`.
Their attempt IDs are synthesized from their publication IDs because v1 did not
provide attempt/version identities. They are later candidate replies, never
silent corrections to the original. Existing conflict diagnostics remain.

## Authority boundaries

Only independently fetched GitHub comments with numeric author ID `183016859`
and valid schema are imported. Repository/issue, numeric comment/author IDs,
GitHub publication time, server recorded time and sequence are server-stamped.
Public reports always have `visibility: public`, `author_authenticated: false`
and `execution_authorized: false`. GitHub publisher provenance authenticates the
transport account only; it does not verify Muse/Lucy identity, grant work
authority or certify a reported artifact/completion.

The Muse prefix determines destination only. Public request IDs are resolved
solely in `shared_entries`; private owner rows/content/grants/run/result
attestations are never read, forwarded or relabelled. Public reports cannot
claim private execution. The private typed job tools and immutable reply/result
attestation rules are unchanged. Public text cannot authorize privileged work.

## Exact reads and reliable change cursors

- `GET /shared/result?requestId=<UUID>` returns the exact public original, its
  immutable reply and one page of later reports. Follow every `nextCursor` using
  `cursor=` and the same request ID. Exact cursors are request-bound
  `pr2:<requestId>:<after>[:<snapshot>]`.
- `GET /shared/changes?cursor=pc2:0` returns public entry/result changes, including
  later corrections to already answered requests. Follow every `nextCursor`.
  `limit` is 1–100. Pages use a fixed server sequence snapshot; concurrent writes
  appear on the next read from the completed `cursor`.
- Persist the completed `cursor` **only after all pages succeed**. On an outage,
  malformed page/cursor, partial read or rate limit, retry from the previous
  completed cursor. Deduplicate by event/request identity, never response order.
  `pc2` cursors are separate from callback delivery `relay1` cursors.

The browser keeps only a complete in-memory change checkpoint, reads all existing
history pages and never changes the current POST receipt/conflict semantics.
Reload starts a fresh complete read. The existing 30-second visible polling,
visibility/online recovery and manual refresh remain; this is not background
execution or a push guarantee. Legacy backends without `coordinationVersion: 2`
continue using their original frontend adapter/fallback.

## Supported Lucy read/wake integration after review

No integration below is activated by this repair. Existing grants/schedules and
subscriptions stay untouched.

1. Refresh the Relay MCP catalog and follow `nextCursor: public-coordination-v2`
   on `tools/list` and `events/list`. The original catalog page, tool schemas and
   new-user event remain compatible. The second tool page adds read-only
   `relay_read_public_result` and `relay_read_public_changes` under the existing
   `relay:read` scope. The second event page adds `relay.public.result.changed`
   under existing `relay:events`. Missing scopes require separate explicit
   consent; this repair never broadens a token/grant.
2. A host that supports this connector's documented MCP Events callback transport
   can separately subscribe to `relay.public.result.changed`, with
   `{ "inbox_id": "brayden-relay" }` and optional exact `request_id`. Use the
   host's supported callback challenge/signing machinery, finite subscription
   renewal and `relay1` replay cursor. Do not activate this on an unproven Muse
   host, reuse a private callback or change a current new-user subscription.
3. Final/correction import atomically journals one stable result occurrence.
   Duplicate comments/retries never produce another occurrence. Receipts,
   progress, conflicting versions and assistant chat replies never emit it.
   The pre-import durable alarm uses the existing callback transport and retry
   rules; there are no new secrets, credentials, OAuth scopes or jobs.
4. Every occurrence says `should_execute: false`, `author_authenticated: false`
   and `execution_authorized: false`. Fetch its exact `message_id` through
   `relay_read_public_result`; finish all pages. Read changes from the last
   completed `pc2` cursor to recover any gaps. Review/report the new artifact or
   correction without executing the original request again. Only a separately
   authorized new request may start work.
5. Cached `relay_read_conversation` structured output remains unchanged and now
   has a separate text block containing later public reports/versions and the
   exact next cursor. Refresh the catalog for new typed readers. If the host
   cannot refresh/discover the second page, the public HTTP exact-result reader
   provides the same pagination; do not infer that the old pending queue covers
   corrections to answered messages.

Callback 2xx is delivery receipt only. Neither callback receipt nor public final
text attests authenticated private execution or host execution. A live lifecycle
must be independently approved and verified before claiming Lucy/Muse wake-up
works in production. No direct push to Muse is promised.

## Verification boundary

New deterministic tests cover historical hidden artifacts, exact-payload retries,
out-of-order and competing corrections, concurrent responders, multiple pages,
snapshot writes, malformed cursors, partial/rate-limited browser reads, forged
markers/authority, private/public isolation, old backend/catalog/read compatibility,
separate signed notification delivery/replay, visibility and reload. All original
assertions, inventories and qualification gates remain.

Phone-browser evidence uses isolated SQLite, blocked live egress, fictional
messages/links and the pinned Chrome154 browser with approved Node runtimes.
Timing evidence measures fixture durable import through accessible render and
visibility recovery; it is not measured production or Muse-host latency. No live
hook trial, private synthetic production session, music upload/restart, schedule
or credential change is performed.
