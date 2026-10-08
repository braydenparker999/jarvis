# Durable private owner jobs

Each private owner request has a durable job in the existing SQLite Durable
Object. The job ID and request ID are the same UUID. The request remains an
ordinary private owner message, delivered by the existing owner event path.
Existing event responders and hourly fallback tasks are unchanged.

A normal authenticated `relay_owner_reply` saves the immutable plain-text result
and completes the associated queued or active job in the same synchronous
transaction. It requires no new tool catalog, execution claim, reply-body marker
or callback receipt. The accepted reply is the completion evidence. An explicitly
failed or cancelled job keeps that terminal state when a later explanatory reply
is saved. Identical reply retries preserve the original reply, completion time
and lifecycle event; conflicting replies return 409.

These records track the evidence Relay receives. They do not start an executor,
create new schedules, forward private text to Muse or public services, or establish
the identity of a particular assistant persona. Publishing new MCP tool schemas
does not prove that a connected host has discovered or can call those tools.

## Browser API

The existing authenticated phone bearer and exact allowed Origin protect writes.
OAuth tokens cannot be used as phone sessions. Successful `/session`, approved
`/pair/status`, and successful `/login` responses advertise `jobs_enabled: true`.
An older service without that field can continue ordinary private chat without
speculative job API calls. All job responses use `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`.

| Method and route under `/relay/owner` | Input | Response |
| --- | --- | --- |
| POST `/jobs` | `id`, `title`, `body`, `action_kind` | `job`, ordinary `entry`, `newWrite` |
| GET `/jobs` | Optional `after` creation-sequence cursor and `limit` | `jobs`, `nextCursor` |
| GET `/jobs/detail` | Exact `job_id` | `job`, chronological `events` |
| POST `/jobs/cancel` | Exact `job_id` | `job`, `newWrite` |
| POST `/jobs/retry` | Parent `job_id`, separate attempt `id`, optional `confirm_duplicate_risk: true` | New attempt `job`, ordinary `entry`, `newWrite` |

The title is 1–120 characters, body is 1–4,000 characters, and action kind is
`unclassified`, `read_only`, `draft`, or `consequential`. The classification is
owner-supplied data; it grants no permission and does not waive action-specific
confirmation. Extra identity, stage, artifact, result or credential fields are
rejected. Duplicate query parameters and token-bearing queries are rejected.

The browser generates the UUID before its first send and retains that exact
request ID and payload for an ambiguous-response retry. Reusing an ID with a
different body, explicit title, classification or submitting device fails with
409. A successful identical retry does not create another request or event.
Creating a job, normal request, existing private event and daily rate accounting
is atomic; an event failure rolls all of them back. The existing Durable Object
wake is persisted before creation and separate retry insertion.

Every newly saved ordinary private message also gets a job with title **Owner
request** and kind `unclassified`. Its body is never parsed to infer intent,
authorization, command markers, stage or safety. Historical private messages
materialize only when selected in a job page or exact job read. Their existing
immutable private replies project completed results using the actual saved reply
time. This metadata projection does not replay events or claim execution. Replies
accepted by a temporarily restored older Worker reconcile the same way.

The job sequence is its immutable user-message sequence. Pages preserve strict
creation order, with a default limit of 20 and maximum of 50. Status changes do
not advance this cursor. Refresh active jobs by exact ID or read all pages again
to observe completion, cancellation acknowledgement or failure.

## Stages and execution evidence

| Stage | Server evidence |
| --- | --- |
| `queued` | The private request is saved; no authenticated execution claim exists. |
| `running` | The owner-connected assistant explicitly claimed it, and its five-minute grant/run lease is current. |
| `outcome_unknown` | A previously running lease expired without final evidence. This is a read projection; it does not assert execution stopped or failed. |
| `waiting_for_owner` | The matching execution recorded a blocker and explicit outcome. |
| `completed` | The normal immutable private reply was accepted and linked as the final result. |
| `failed` | The matching current execution recorded an explicit failure summary and outcome. |
| `cancelled` | An authenticated execution acknowledged the owner's cancellation request with a known or not-started outcome. |

Callback acceptance remains in the separate existing `delivery` diagnostics. A
2xx callback never claims, renews, runs or completes a job. `running` means an
execution acknowledgement within the current lease; it is not continuous CPU,
model or external-service monitoring. The `execution` object contains only a
noncredential `runId`, last `acknowledgedAt`, and `leaseExpiresAt`. The OAuth
grant binding stays server-side. A run UUID alone cannot claim or change a job.

The optional MCP tools `relay_owner_jobs_list`, `relay_owner_job_read`,
`relay_owner_job_claim`, and `relay_owner_job_update` use only the existing live
`relay:owner` scope. They revalidate both OAuth token and grant inside the same
synchronous transaction as the operation. Public read/reply/event scopes, a
claimed principal, device bearers, or public Muse-prefixed messages provide no
job authority.

Claim accepts `inbox_id`, `job_id`, `run_id`, and `event_id`. The queued job can
have one claim; competing executions fail. Progress accepts `inbox_id`, `job_id`,
`event_id`, optional matching `run_id`, and `stage`. Running progress renews the
lease. Waiting or failed progress additionally requires a plain-text `summary`
and explicit `outcome` (`not_started`, `known`, or `unknown`). A globally unique
event UUID is bound to the exact normalized event payload and OAuth grant.
Identical event retries succeed without renewing leases or duplicating events;
different payloads, targets or grants fail with 409. Progress is bounded to 100
events per job, with cancellation acknowledgement and final reply still allowed.

Expired claims cannot be silently reclaimed. An active lease also prevents a
different grant from writing a competing normal final reply. The first accepted
immutable reply remains authoritative. A waiting job has no automatic resumption
or approval protocol in this slice: the owner can send a separate private message
with a decision, and a final normal reply can finish the waiting request. Message
or reply text is never interpreted as machine-readable permission.

For a cached host, the existing `relay_owner_read_conversation` retains its exact
structured result and original serialized content. A fourth separately labeled
**Private job lifecycle** text block supplies redacted server lifecycle evidence.
The earlier private delivery and subscription diagnostic blocks remain intact.
This block contains no private body, device credential, OAuth grant, hidden
command, synthetic conversation entry or execution instruction.

## Cancellation and separate attempts

Browser cancellation records `cancelRequested` and a durable cancellation-request
event. It leaves the execution stage unchanged. Claiming and further running
progress are blocked. A request is never displayed as cancelled merely because
the owner clicked Cancel or a callback was accepted.

Only authenticated `relay_owner_job_update` with `stage: "cancelled"`, an explicit
summary, and `outcome: "not_started"` or `"known"` can acknowledge cancellation.
A claimed job requires the owning OAuth grant and matching run ID, even after
lease expiry; another host cannot assert the original execution stopped. A
never-claimed job can be acknowledged by current owner OAuth only after verifying
that the request will not execute. An unknown outcome cannot claim cancellation.
The cancellation request remains historical evidence after acknowledgement.
An ordinary final reply may instead complete a request while preserving its
cancellation-request fact; it does not fabricate a cancellation acknowledgement.

Retry creates a new private request with a distinct immutable UUID, linked parent
and root job IDs and incremented attempt number. The original request, final
state and result stay intact. Each parent has at most one child; a logical lineage
has at most five attempts. Identical retry sends return the same child, while
different child IDs or submitting devices fail with 409.

Completed, queued, running and waiting requests cannot be retried. Failed,
cancelled, or outcome-unknown requests may be eligible, with these further guards:

- Consequential or unclassified requests are unavailable for retry when their
  outcome is unknown or possibly performed (`known`), even with a duplicate-risk
  checkbox. The authenticated terminal execution must specifically attest
  `not_started` before another attempt becomes eligible.
- Read-only or draft requests with an unknown outcome require the owner's explicit
  `confirm_duplicate_risk: true` before a separate attempt is created.
- Eligible consequential or unclassified requests still require that explicit
  confirmation. The field acknowledges duplicate-request risk; it is not an
  approval for external actions or data sharing.

Relay cannot guarantee exactly-once external side effects. An execution must
still use the destination's actual idempotency mechanism or reconcile the action
before claiming it did not start. Stable root job IDs are correlation IDs, not
proof that an external API deduplicates requests. This slice does not introduce
automatic retries of consequential actions or an external action executor.

## Private results and verification

Final results expose `format: "plain_text"`, body, immutable reply ID and saved
time. HTML-looking input is data. Render titles, progress, request and result
bodies with text nodes, and allow only independently checked safe links. The API
accepts no interactive HTML, iframe, credential-bearing artifact URL, browser
execution command or token property. Private content remains in owner tables;
public inbox routes, publications and Muse integrations never read these jobs.

Run the focused lifecycle, adversarial, compatibility, owner and OAuth checks
with the repository's pinned Node 22.23.3 and additional Node 24.21.0 owner
security coverage. Browser and complete release qualification remain mandatory
under [the release recipe](release-qualification.md). Fixture completion evidence
does not claim a live host run; release reporting must separately record the
actual accepted private request, available callable tools and immutable result.
