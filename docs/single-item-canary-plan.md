# Proposed single-item live canary — not authorized or executed

This narrows the next step to one useful outcome: register one explicitly approved, already-prepared Opus item using the existing authorized uploader, then verify its exact identity and local decode. It does not install the prototype into the fleet, modify the shared manifest, exercise retry reuse, enable analysis, or establish an upload speed gain. The draft's composed fixtures are not represented as production hooks.

The [latest writer response](https://github.com/braydenparker999/jarvis/issues/2#issuecomment-6104105316) remains partial: queue-append contains omitted validation and undefined locals, and runner/builder sections are prose. It reports legacy runner/builder inactive. That is enough to identify a narrow operational check, not to certify fleet migration. **Do not request another broad source package for this canary.**

## Go/no-go: facts needed from the owner/host

The parent must approve the exact scope before any live command below. Host owner must supply/confirm only:

1. One approved local item: path/basename, SHA256, byte size (1–32 MiB), expected title/artist and expected cover presence. It is already prepared, must remain unchanged, and is absent from pending/claimed shared work and any other submitting job. Prefer a SHA not already present in the catalog, verified by a bounded read-only preflight, so first registration has an unambiguous expected result. If testing an existing duplicate instead, explicitly approve its current first-wins metadata/cover expectations; do not assume the new local tags replace them. Owner excludes this SHA from enqueue/resubmission for the canary window. Do not remove it from a live queue to make it eligible. If no eligible item exists, stop and select another.
2. The existing uploader path and SHA256, existing authorized key path/public signer identity, exact public origin, existing shared upload token path/device/inode and STOP/AUTH-STOP paths. No key bytes, new key, permission change or credentials setup is requested. Expected supplied uploader SHA256 is `7cb0a7b9015dc1a536a3365f7e1a4d0c1c9b305cda4a2e9c02e5eb3ccd135c4c`; a mismatch requires review of that file, not a fleet source request.
3. A current host check that every other process capable of remote upload/register uses this exact token; the legacy tokenless runner is inactive and will not be started for the window. Manifest-only appends need no migration for this separate namespace. If a remote writer can bypass the token, **no-go**.
4. A single responsible operator can keep the token-holding shell alive on uncertainty and refrain from exit, timeout wrappers, terminal closure, host replacement or forced termination. A canary-only disk hold cannot stop legacy workers once the token is released. If this supervision cannot be assured, **no-go** until the host provides an existing suitable lock keeper or separately approved containment. Do not build another service here.
5. Existing pacing admits this one additional attempt, including a token-held cooldown afterward: the operator chooses an allowed upload opportunity and observes the current effective rest before it. No value/configuration is changed; no concurrent provider work or accelerated schedule is created. Allowing a canary to bypass an unsatisfied rest interval is **no-go**.

No original/shared queue mutation is needed. The full writer implementations, claim migration and shared preparation coordinator are not prerequisites for this isolated one-shot baseline; they remain prerequisites for fleet optimization adoption.

## Exact owner-run transition

These are an operator procedure using existing tools, not an automatically installed runner. Symbols below are owner-supplied paths/identities, never secret contents. Run **only after the parent authorizes the concrete item and window**.

1. Create a fresh owner-only `CANARY_ROOT` outside the shared queue/report directories and outside the repository. It must not already exist. Put these artifacts only there: `manifest.json`, `checkpoint.json`, `source/<original-basename>.opus`, `transport.py`, `raw-report.json`, `catalog-receipt.json`, and bounded local diagnostics. Never copy the private key. Preserve the original filename in the media snapshot so registration naming is unchanged.
2. Copy the prepared item and uploader into that directory, then verify the copies against the approved audio SHA/size and uploader SHA. Do not execute/import the uploader during this preflight. Keep the original file untouched. Snapshot the expected identity and operator-approved destination/public signer into `manifest.json`; initialize `checkpoint.json` as **not-started**, not as an acknowledged upload. Flush/fsync the files and directory before proceeding. Use no synthetic receipt or prior prototype test receipt.
3. Decode the local snapshot with the existing bounded check before spending a network attempt:

   ```sh
   timeout 300 ffmpeg -v error -i "$SNAPSHOT" -f null -
   ```

   Require exit0 and empty stderr; verify snapshot SHA/size again afterward. Failure is pre-send **no-go**, with no shared state change. Do not enable optional analysis or modify tags/cover.
4. In a dedicated supervised shell, open and acquire the **existing** token. Confirm the path exists, is not a symlink and has the owner-approved device/inode before opening. Do not create a new token:

   ```sh
   test -f "$EXISTING_TOKEN" && test ! -L "$EXISTING_TOKEN" || exit 1
   exec 9< "$EXISTING_TOKEN" || exit 1
   flock --exclusive 9 || exit 1
   token_fd_identity=$(stat -Lc '%d:%i' /proc/$$/fd/9) || exit 1
   token_path_identity=$(stat -Lc '%d:%i' "$EXISTING_TOKEN") || exit 1
   test "$token_fd_identity" = "$APPROVED_TOKEN_IDENTITY" || exit 1
   test "$token_path_identity" = "$APPROVED_TOKEN_IDENTITY" || exit 1
   ```

   `APPROVED_TOKEN_IDENTITY` is the owner-confirmed `device:inode` string. All explicit failure exits above are before dispatch; never reuse that exit-on-error pattern after dispatch. Keep this shell and descriptor9 alive through validation or reconciliation. Recheck STOP/AUTH-STOP after acquisition and immediately before dispatch; if either exists, do not start. Reverify item exclusion, pacing eligibility, pinned snapshots and signer/origin. Any mismatch before dispatch permits closing descriptor9 without a remote rollback.
5. Durably replace `checkpoint.json` with **in-flight, one attempt, retry forbidden**, including audio SHA/size and pinned transport identity, then fsync its parent directory. This is an uncertainty marker, not a blob receipt. Do not create or reuse a shared queue entry. Invoke the existing transport exactly once, in the same token-holding shell:

   ```sh
   python "$CANARY_ROOT/transport.py" "$SNAPSHOT" \
     --key "$EXISTING_AUTHORIZED_KEY" --report "$CANARY_ROOT/raw-report.json"
   canary_exit=$?
   ```

   No `--analyze`, loop, `|| retry`, background process or automatic requeue. **Do not wrap the token-holding shell in timeout, `set -e`, or an automatic restart mechanism.** The pinned uploader has its existing per-request timeout and error handling. Its signing/key checks are retained. If a STOP arrives after dispatch, do not launch further attempts or assume the already-started chain was cancelled; this one-shot procedure does not retrofit mid-chain stop hooks into the wrapper.
6. With the token still held, validate all evidence before release. Require exit0, a newly created bounded regular report file, registered=true, audioSha256/audioBytes matching the approved snapshot, and a valid returned ID. For this no-analysis invocation require analysisStatus=not-requested; preserve playbackVerified=false. Verify expected cover presence/hash and exact source/snapshot hashes. Fetch `/music/library.json` **read-only through the already approved origin** with HTTPS/no redirects, 30s timeout and 16 MiB+1 sentinel bound; require exactly one matching ID and identical SHA256/integer size, valid R2 identity and expected cover. Preserve that catalog entry as evidence. A matching catalog alone is insufficient if the original request timed out or failed.
7. Decode the same immutable local snapshot again with the bounded command and recheck its hash. Require clean decode. Durably record **verified one-shot completion** in the separate manifest/checkpoint and preserve the raw report/catalog evidence. Still holding descriptor9, observe at least the host-confirmed current effective rest interval after the canary completion; re-read the effective rest before release and honor any widening, never shorten it. This compensates for the canary not updating shared pacing timestamps. Only after that cooldown close descriptor9 and leave the supervised shell. The fleet can naturally reacquire its original token; no restart/configuration change is needed.

The operator should record start/end and phase timestamps from existing output where available, but this sample proves only an end-to-end item/receipt boundary. It does not quantify optimization savings, live throughput, remote playback or retry safety. No additional telemetry framework is required.

## Rollback / stop criteria

| Outcome | Action while original token remains held | Release criterion |
| --- | --- | --- |
| Pre-send failure or withdrawn authorization | Mark aborted-before-send in separate namespace; retain or quarantine snapshots; originals/shared queue untouched | No request was dispatched; close descriptor9 |
| Clean exit + validated report/catalog + unchanged bytes + clean decode | Record one-shot completion; retain evidence; no requeue | All checks and the host-confirmed cooldown pass; close descriptor9 |
| HTTP/auth error, timeout, interruption, nonzero exit, stale/invalid report, changed identity, readback failure or decode failure after sending | Mark **held for review**, preserve diagnostics and namespace, do not resend or delete remote objects; keep supervised shell/descriptor alive; notify parent/owner | A separately reviewed decision establishes a safe terminal outcome. Elapsed time, catalog appearance, duplicate registration or a local checkpoint file alone do not authorize release/retry |
| Token keeper/shell/host dies after dispatch | Treat canary as uncertain immediately; a disk marker does not protect old workers | No automatic recovery or retry. Owner must obtain separate approval for any fleet admission containment needed; cannot promise the unchanged fleet stayed serialized after loss of its lock keeper |

Rollback never deletes a newly registered server object or edits existing metadata/library state. Registration is an external side effect, not something a local file rollback can undo. If a failure would require stopping the fleet, that is outside this canary authorization and must be escalated with the exact proposed action.

## Current decision

**No live go yet:** no specific approved item/window and no owner commitment/evidence for token participation, pacing eligibility and uncertainty supervision have been supplied in this task. Those are the actual canary blockers. The next owner/host response should provide those facts, not another broad queue source dump.

No new upload implementation was added: the canary deliberately uses the pinned existing CLI once. The proposed readback/evidence steps must be run by the host owner with the approved item; they have not been executed here. The draft PR remains an offline candidate. No live uploads, original/shared-manifest changes, worker restarts, credentials, permissions or scheduling changes were performed.
