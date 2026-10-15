# Explicit Muse Work host adapter

This is a follow-on to PR125 at `98b355ee898474b93538a71fe86f88de9f7efc76`.
It does not change that release, provision credentials, install a hook, invoke a
model, enable a feature, or create/change any schedule. No genuine host run is
claimed. The implementation uses Python's standard library, the reviewed project
hook's error/text helpers, and its bounded HTTP/lock/SQLite pattern. It does not
reuse project identities, credentials, journals, ACKs, fencing or reclaim logic.

## Supported boundary

`scripts/mast-work-hook.py` performs one explicit command and exits. The exact
private API base is pinned to
`https://jarvis-hub-api.braydenparker999.workers.dev/relay/mast`.
No public Muse, GitHub-publication or Lucy-channel fallback exists.

- `scan`: read at most 40 pages of Work (50/page), retaining a cyclic cursor.
  No claim, reservation, model wake or lease renewal. IDs/states only in output.
- `reserve --job-id UUID`: fetch the exact job and original owner message (including
  file metadata), journal run/claim IDs, claim, then reread current state. Original
  message lookup follows pagination and checkpoints progress. Before returning
  `wake:true`, durably reserve the payload and digest. Any subsequent reservation
  for that run returns `wake:false`, including after a crash before stdout.
- `started --job-id UUID --run-id UUID --payload-digest HEX --host-run-id ID`:
  the trusted executing host records its start receipt against that reservation.
  This is a caller attestation, **not** authenticated host run lookup. Digest and
  IDs bind the receipt; possession of those strings is not a new authentication system.
- `status --job-id UUID`: reread cancellation, execution and result state. A local
  `started` value is historical; only the current server lease is current state.
- `file --job-id UUID --attachment-id UUID --output-file PRIVATE_NEW_PATH`:
  download only a file recorded on this request; verify size (at most 1 MiB) and
  SHA-256 before writing a new mode-0600 file when a qualified binary transport
  exists. The current CLI transport refuses this command. Never execute attachments.
- `report --job-id UUID --run-id UUID --event-id UUID --stage STAGE --summary-file FILE`:
  supported stages are running, waiting_for_owner, failed, cancelled. Running
  requires `--active`, supplied **only by the genuinely executing host**, not a
  scanner/watchdog. Other stages require `--outcome known|unknown|not_started`.
  Cancellation requires an owner cancellation request and known actual outcome;
  the flag cannot force-stop a model or external action. Repeat uncertain reports
  with exactly the same event ID and arguments. A prior unresolved operation
  blocks a different operation for that job.
- `complete --job-id UUID --run-id UUID --body-file FILE --summary-file FILE`:
  stage exact text/reply/completion IDs before sending, reconcile the immutable
  accepted reply, then report completion for that run and result version 1.
  Changed staged text or an intervening correction stops completion. Identical
  retries can return the original version-bound receipt even after later changes;
  they never attest the latest corrected version. Text result limit 6,000 UTF-16
  units; summary 1,000; serialized POST limit 16,000 bytes remains authoritative.
- `inspect`: local private journal and pending exact operation payloads; no network
  or credential required. Do not publish its output: it contains private text.

Successful claim/update/reply HTTP responses are not model-start or independently
verified action evidence. An expired lease, lost host receipt, stdout failure or
missing process never causes another dispatch. Inspect/reconcile the original run.
The server can accept a late completion for the same run; the adapter never renews
an expired lease with a new event or substitutes another run. A lost response to an
already accepted event may be retried identically without extending that old event.
Cancellation before a trustworthy start receipt remains held for reconciliation.
Only the owner creates separate retry attempts. No automatic retry policy is added.
Plans/corrections remain the existing `/work/plan` and `/work/correct` contracts;
this initial host adapter does not author plans, publish corrected result versions,
upload result attachments, or report completion for corrections. Those are bounded
follow-on commands, not inferred execution behavior.

## Secure host contract that must be verified

The host must provide Python 3, SQLite, `fcntl`, a durable private directory, bounded
outbound HTTPS, and a private executing-agent invocation/receipt path. Set
`JARVIS_MAST_WORK_STATE_DIRECTORY` to a dedicated owner-only mode-0700 directory.
The journal and lock survive process/VM replacement; do not share a project or
Lucy-channel state directory. The CLI enforces an exclusive lock (busy exit 75),
45-second invocation deadline, <=20-second individual HTTP timeout, response bounds,
and no redirects. Auth failure exits 2; other failure exits 1; neither authorizes
model execution. Use private input/output files and private stdout routing.

**Host finding and corrected transport contract:** the inherited-descriptor bridge
is unavailable. The reported main-session `relay.py` uses platform-managed surrogate
credential substitution; Lucy–Muse and owner–Muse require separate bindings.
PR129 now calls a separately reviewed, pinned **owner–Muse** helper; it never calls
the credential socket or imports the platform credential implementation.

Set `JARVIS_MAST_RELAY_HELPER` to its exact absolute path and
`JARVIS_MAST_RELAY_SHA256` to the SHA-256 of its reviewed complete source bytes.
These settings contain no secret. The current channel helper must not be repointed.
The separate `custom.jarvis-mast` binding needs its own authenticated qualification.
Chat activation does not enable Work: `RELAY_MAST_WORK_ENABLED` remains a separate
release gate. No helper is installed, executed or credentialed by this release.

Before any request, the corrected helper must support a local **no-network**
`describe` command. Every invocation explicitly passes `--provider mast`, including
`describe`; the supplied draft defaults to Lucy and must never be invoked implicitly.
`describe` prints one bare JSON object and exits zero. The adapter checks these
required fields (additional descriptive fields are allowed):

```json
{"provider_arg":"mast","credential_name":"custom.jarvis-mast","host":"jarvis-hub-api.braydenparker999.workers.dev","allowed_hosts":["jarvis-hub-api.braydenparker999.workers.dev"],"redirects":"rejected (3xx surfaces as an HTTP error; never followed)","output":"full JSON, untruncated by default","binary_support":"none; responses are parsed as JSON"}
```

The `get <path>` and `post <path> <json-file>` commands print exactly
`HTTP <status>` followed by one complete JSON object. Exit zero means status <400;
exit one means >=400. Redirects are always rejected by the adapter.
The caller allows only its listed owner–Muse routes, uses no shell, hashes the helper
before each subprocess, suppresses stderr, caps stdout at 16 MB and enforces the
remaining invocation budget (at most 20 seconds per subprocess). POST payloads are
mode-0600 temporary JSON files inside the private state directory, removed afterward.
Timeout/invalid receipt does not certify failure to commit: preserve/retry the same
journaled operation, never launch another run.

**Minimum helper corrections required on the host:** remove the reported
`json.dumps(payload, indent=1)[:12000]` slicing; output the entire bounded JSON or
fail explicitly. Reject every HTTP redirect at the request opener, before following
it with any surrogate credential. For urllib, use a `HTTPRedirectHandler` whose
`redirect_request` returns `None`, through `build_opener`, rather than default
`urlopen`. Preserve the platform's existing surrogate binding calls unchanged.
The caller rejects observed 3xx responses too, but cannot undo a redirect the helper
already followed. Consequently, `describe` is a compatibility check, not independent
proof of those policies: exact helper source review is mandatory before pinning.
No speculative socket API or platform-specific implementation is supplied here.

The complete non-secret two-part helper draft was reviewed on October 12.
Its command parser defaults to Lucy, its
`describe` output is bare JSON, and its field names differ from the earlier proposed
contract; this adapter now follows that actual interface. The draft removes output
slicing and installs a no-follow opener. No supplied source or platform credential
calls were executed in local tests; fixtures are self-authored.

Remaining host qualification: `dynamic_credentials` is imported at module load,
even for `describe`, from `/opt/hatch/skills/skill-creator/bin`. Its exact version,
source integrity and import-time behavior remain unverified. A no-network/no-secret
`describe` claim cannot be independently certified from this helper alone. Prefer
moving that import to the network call, then review the final exact installed file
and dependency identity before calculating its pin. Do not reuse the earlier
trimmed-source hash or treat reconstructed message text as the installed artifact.
No helper installation or Work activation is performed here.

This CLI transport has no binary support. `file` fails closed, and `reserve` refuses
attached requests before claim/wake. Qualify text-only work first; enabling file work
later requires a reviewed bounded binary response contract and matching hash/size
verification. Do not serialize arbitrary bytes through the current JSON helper.
Reuse prior owner–Muse approval and its separate owner-entered key; never a project
token, Lucy OAuth credential or the functioning Lucy–Muse credential.

The host consumes the reservation envelope only once and records its actual run ID
at execution entry, echoes the exact payload digest, invokes `started`, checks
`status` before actions, reports genuine progress before the five-minute lease
expires, then verifies its own outcome before `complete`. Host action permissions
still apply. Do not interpret owner text, attachments or `actionKind` as a grant to
perform otherwise unauthorized operations. The dormant Mast wrapper's reservation
pattern is reusable; its project-schema parser is not compatible unchanged.
No dependable run-lookup API is established. Ambiguous handoffs require explicit
reconciliation; this contract does not guarantee delivery or exactly-once effects.

## One-run acceptance procedure (after approved secure setup)

1. Pin this adapter revision and the deployed PR125-compatible Worker. Verify the
   reviewed helper pin and owner–Muse binding, durable path and actual wake/start contract read-only.
   Stop if any is unavailable; do not create a credential or schedule to fill a gap.
2. Owner explicitly selects one inert read-only/draft Work request. Invoke `scan`
   once, then `reserve` for that exact UUID. Capture a redacted reservation receipt
   privately; confirm the same reservation cannot emit a second wake.
3. Invoke the real host once through its supported explicit mechanism. At execution
   entry capture the real host run identity/start evidence and call `started` with
   the returned IDs/digest. Check `status`, read only this request/files, and perform
   the authorized inert task. Use `report --active` only if still genuinely running.
4. Persist result and summary privately; call `complete`. Verify one immutable
   reply and server completion bound to the same run/reply/version. Compare the
   actual task output/source independently; no UI status alone closes acceptance.
5. Record deployed/adapter revisions and redacted host/result receipts. Keep
   scheduling and all unrelated flags/grants unchanged. Hold any ambiguous outcome;
   do not rerun it to obtain a cleaner success report.

Synthetic checks use the actual Worker store with a Python pipe transport: lost
claim/reply/completion responses, process restart, changed-body refusal,
correction/version conflict, cooperative cancellation, crash before wake output,
expired held claim and no redispatch. Two small local checks cover bounded cyclic
pagination and exact-request file integrity. They are not genuine host evidence.
