# Mast upload speed and reliability: staged integration

This staging work preserves the full goal. It supersedes the preparation-only patch as the proposed integration path; that smaller patch remains historical review material. Nothing here is installed or running. Launcher and worker entrypoints refuse this generated package's **blocked** qualification marker.

## Implemented call sites

- `relay-worker.py`: existing pending selection order and worker IDs, now generation-fenced. No age-based/same-owner reclaim. A lifetime per-job lease covers preparation, lock wait, network and retry backoff. Status changes validate owner, generation, immutable identity and attempt. Network admission persists a global hold before a child can exist.
- `upload-music-r2.py`: local preparation before lock wait, then the existing fresh signer/no-redirect transport feeding validated raw-response checkpoints. A stable journal per logical SHA job preserves acknowledged audio/art receipts across attempts. Reuse requires exact destination, signer, object key, SHA256, size and immutable bytes. Registration and optional duplicate-analysis proof checks still run. The current worker does not enable analysis.
- Retry: only the exact bounded HTTP 409 registration-library-CAS rejection can clear its pending phase. After confirmed child exit, a fresh fenced retry report and clean journal permit the existing exponential backoff. A timeout, malformed response, authentication error, interruption or other child failure retains the durable global hold. A successful catalog lookup never resolves ambiguous writes.
- Completion: fresh attempt-specific report, same-byte bounded decode, compatibility-report publication and pacing persistence precede the fenced completion commit that clears admission. Decode failure is held, not registered. Original media is never deleted. Prepared artifacts are removed only after verified completion; uncertain evidence remains.
- `manifest_lib.py`: reuses the stable-sidecar transaction for current-state append mutations; existing entry or admission changes are rejected. Whole-snapshot `save()` is disabled. Worker mutations and pacing also use stable sidecars; corrupt/missing JSON is not silently replaced with `{}`. Active appends can remain concurrent once all participants are qualified.
- `relay-uploader.py`: singleton startup, unresolved-state checks, DRAIN admission closure, no automatic respawn after unexpected worker death, and no SIGTERM fallback. A drain timeout reports failure and retains markers/processes. Child process groups use existing bounded containment; killing/reaping a local process does not prove remote terminality.

Network concurrency, three-worker population, credentials, source paths and pacing formulas are unchanged. New conservative holds/backpressure reduce admission after faults. The two prepared-slot bound and 256 MiB checkpoint/report budget are explicit operational limits, not unlimited retention. Snapshot I/O adds overhead; no live throughput gain is claimed.

## Reproduce the staging package

Supply the four canonical source files in a private input directory, then run:

```sh
python scripts/staging/build_mast_package.py INPUT_DIRECTORY NEW_STAGING_DIRECTORY
```

The builder refuses mismatched hashes or an existing output directory. It transforms source as text/AST and copies the already-tested support modules; it does not execute supplied modules, upload, install or migrate state. The output preserves the host's real configuration. Never substitute the earlier redacted worker for a runnable source file. Exact input/output hashes and static binding checks are in [qualification.json](evidence/mast-staging/qualification.json). The [call-site diff](patches/mast-fenced-call-sites.patch) covers the four supplied files; the generated package also includes the support modules named in that qualification record.

The complete worker supplied in comment 6103981264 independently hashes to `75b00f687efba00e8c14db33694cb524c6301b05ac5ec52f9ee516790ea9377f`; the launcher body hashes to `7e25140df4f072ef7c1b9a7c03008483827fa90cae3144479b2f97be9033d6b6`. These are source-package identities, not proof of currently loaded runtime code.

## Focused qualification

```sh
python -m unittest tests.test_mast_staging_calls tests.test_r2_manifest_transaction -v
```

[Recorded result](evidence/mast-staging/focused-tests.txt): the single staged call-site matrix covers 13 synthetic transport/fault rows, with additional admission/writer/drain assertions; the 10 existing transaction tests also pass. In the CAS-conflict row, audio and artwork PUT occur once each while registration occurs twice. Covered faults include ambiguous artwork outcome, interruption, authentication, corrupt journal, stale generation, changed snapshot, decode failure and failed report publication. No broad full-suite rerun was used.

The authored runtime's process and uploader entrypoints execute through an authored subprocess CLI fixture using the staged argument contract. Actual supplied worker/uploader/launcher modules are inspected only as AST/text; they are not executed. HTTP/signing and FFmpeg are faked in this matrix. This is therefore integration evidence for the new call sites, not a live-wrapper, real-decoder or throughput qualification. Existing process-group and receipt fixtures remain reusable evidence, not newly claimed live coverage.

Focused review found and corrected two issues: a lease filename collided with artifact-directory accounting, and completion initially released admission before compatibility-report/pacing persistence. No remaining concrete replay flaw was identified in that review's scope; missing writers remain unqualified.

## Reconciliation with Mast's sidecar proposal

[Comment 6104750454](https://github.com/braydenparker999/jarvis/issues/2#issuecomment-6104750454) independently confirms the replaced-inode race and the need to transition every writer together. This package already consolidates locking through the existing stable-sidecar transaction; no second wrapper is added. The proposed unchanged `save(snapshot)`, parse-error recovery and unfenced claim/status paths would still be unsafe. Prior source evidence says the builder writes directly, so changing `manifest_lib.py` alone cannot qualify it. The missing source request below is unchanged.

## Exact source gap — already requested once through the parent

The coordinator needs complete current source bodies and SHA256 hashes for:

1. `queue-append.py` (119 lines): the supplied excerpt omits validation and local assignments.
2. `queue-runner.py` (318 lines): only prose was supplied; its tokenless legacy behavior must be prevented from bypassing the new contract.
3. `build-queue-manifest.py` (221 lines): only prose was supplied; it directly replaces the manifest and cannot safely coexist with transactions/fencing without a compatible change.

The first is reported active on demand. The other two are reported inactive, which is not a substitute for qualifying their restart/manual-write paths. The package deliberately does not invent these bodies or mark all-writer migration complete. The complete launcher body is available; Mast still needs to attest its current host hash. No additional broad source inventory was requested.

## Compatible transition and rollback — not yet approved

The previously described old-launcher STOP procedure is **not a safe drain guarantee**: it terminates workers after 180 seconds while a child timeout is 900 seconds. Do not use that procedure to claim safe activation.

Before any live transition, finish the three writer integrations, qualify the host's exact dependencies/source identities, reconcile existing claimed/ambiguous work, and obtain one concrete approval for the complete compatible writer/uploader/launcher set. Do not manually change the qualification marker to bypass these prerequisites.

For the old-to-new transition, Mast must identify and explicitly approve a supervisor-only maintenance control that prevents both respawn and its 180-second termination fallback while leaving existing uploader children alone. If no such control is available, transition remains no-go. Then close admission with the existing worker stop mechanism, observe all workers/children and establish terminal remote outcomes. Old workers may finish another claimed item or their current retries before exiting. A dead PID, released token, timeout, elapsed time or duplicate registration alone is not terminality evidence. No indefinite upload-token hold is proposed.

Only after that verified drain may the complete qualified set be installed together, with original credentials, worker IDs, token inode, manifest contents and pacing state preserved. Stable sidecars must be shared by every writer and never replaced. Any state migration or reconciliation needs its own concrete reviewed scope; the builder performs none. Resume exactly the existing worker population through the qualified launcher. New DRAIN closes admission while already-admitted chains can finish; incomplete/held claims prevent restart until reconciled.

Rollback changes future attempts only. Use the new non-terminating drain, preserve checkpoints/reports/snapshots, and establish that no active lease, claimed/held generation or ambiguous request remains. Restore a compatible whole writer/uploader/launcher set together. Restoring an old unfenced writer while new holds or claims exist is forbidden. Do not reset claims, delete journals, clear AUTH-STOP or requeue uncertain items to force rollback. If these preconditions cannot be established, leave admission closed for explicit reconciliation.
