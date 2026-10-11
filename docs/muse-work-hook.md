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
  SHA-256 before writing a new mode-0600 file. Never execute attachment contents.
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

**Indispensable unanswered host fact:** can Muse's approved hosted `jarvis-mast`
credential be supplied to this Python process via a host-managed inherited readable
file descriptor >=3, without token disclosure to the model/logs? The host must set
`JARVIS_MAST_TOKEN_FD` to that descriptor number; the descriptor contains only the
existing bare bearer and reaches EOF. Each invocation needs a fresh readable
credential descriptor. No raw secret is accepted in command-line arguments or an
environment value, and this adapter does not generate/store/export credentials.
Availability of `credentials.request_api_access` does not establish this bridge.
If the host supports only vault-backed HTTP tools, the coordinator must obtain that
actual callable contract and adapt the transport to it; do not invent secret injection.
Reuse prior owner–Muse approval, never a project token or Lucy OAuth credential.

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
   secure descriptor bridge, durable path and actual wake/start contract read-only.
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
