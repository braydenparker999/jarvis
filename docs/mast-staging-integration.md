# Mast upload speed and reliability: staged integration

This staging work preserves the full goal. It supersedes the preparation-only patch as the proposed integration path; that smaller patch remains historical review material. Nothing here is installed or running. Launcher and worker entrypoints refuse this generated package's **blocked** qualification marker.

## Implemented call sites

- `relay-worker.py`: existing pending selection order and worker IDs, now generation-fenced. No age-based/same-owner reclaim. A lifetime per-job lease covers preparation, lock wait, network and retry backoff. Status changes validate owner, generation, immutable identity and attempt. Network admission persists a global hold before a child can exist.
- `upload-music-r2.py`: local preparation before lock wait, then the existing fresh signer/no-redirect transport feeding validated raw-response checkpoints. A stable journal per logical SHA job preserves acknowledged audio/art receipts across attempts. Reuse requires exact destination, signer, object key, SHA256, size and immutable bytes. Registration and optional duplicate-analysis proof checks still run. The current worker does not enable analysis.
- Retry: only the exact bounded HTTP 409 registration-library-CAS rejection can clear its pending phase. After confirmed child exit, a fresh fenced retry report and clean journal permit the existing exponential backoff. A timeout, malformed response, authentication error, interruption or other child failure retains the durable global hold. A successful catalog lookup never resolves ambiguous writes.
- Completion: fresh attempt-specific report, same-byte bounded decode, compatibility-report publication and pacing persistence precede the fenced completion commit that clears admission. Decode failure is held, not registered. Original media is never deleted. Prepared artifacts are removed only after verified completion; uncertain evidence remains.
- `queue-append.py`: retains its complete original insert-if-absent callback, including validation and duplicate behavior, with explicit configuration/qualification checks. The transactional helper checks STOP/AUTH-STOP/DRAIN before mutation and again before commit.
- `queue-runner.py`: the reported inactive tokenless runner now refuses its mutation/upload entrypoints and main invocation. It does not become a fourth worker or bypass relay pacing.
- `build-queue-manifest.py`: retains scanning/validation but merges only new entries into current state under the shared transaction. Concurrent appends, claims, generations, holds, existing registered entries and first-wins metadata survive. Historical plain reports alone produce `held_import_review`; they do not prove completion or authorize another upload. Both append and builder reject mismatched configured/shared manifest paths.
- `manifest_lib.py`: reuses the stable-sidecar transaction for current-state append mutations; existing entry or admission changes are rejected. Whole-snapshot `save()` is disabled. Worker mutations and pacing also use stable sidecars; corrupt/missing JSON is not silently replaced with `{}`. Active appends can remain concurrent once all participants are qualified.
- `relay-uploader.py`: singleton startup, unresolved-state checks, DRAIN admission closure, no automatic respawn after unexpected worker death, and no SIGTERM fallback. A drain timeout reports failure and retains markers/processes. Child process groups use existing bounded containment; killing/reaping a local process does not prove remote terminality.

Network concurrency, three-worker population, credentials, source paths and pacing formulas are unchanged. New conservative holds/backpressure reduce admission after faults. The two prepared-slot bound and 256 MiB checkpoint/report budget are explicit operational limits, not unlimited retention. Snapshot I/O adds overhead; no live throughput gain is claimed.

## Reproduce the staging package

Supply all seven canonical source files in a private input directory, then run:

```sh
python scripts/staging/build_mast_package.py INPUT_DIRECTORY NEW_STAGING_DIRECTORY
```

The builder refuses mismatched hashes or an existing output directory. It transforms source as text/AST and copies the already-tested support modules; it does not execute supplied modules, upload, install or migrate state. The output preserves the host's real configuration. Never substitute the earlier redacted worker for a runnable source file. For the supplied redacted writer bodies, add `--redacted-writers` to produce **review-only** output. Never install that output or replace real host configuration with placeholders. The default host-build mode requires the reported raw writer hashes and matching AST control flow outside only the declared top-level `WS`, `KEY`, and `REPORT_DIRS` configuration assignments. All other statements/functions must match; the builder never reconstructs private configuration. Both modes remain admission-blocked pending transition qualification. Exact input/output hashes and static binding checks are in [qualification.json](evidence/mast-staging/qualification.json). The [call-site diff](patches/mast-fenced-call-sites.patch) covers all seven supplied files; the generated package also includes the support modules named in that qualification record.

The complete worker supplied in comment 6103981264 independently hashes to `75b00f687efba00e8c14db33694cb524c6301b05ac5ec52f9ee516790ea9377f`; the launcher body hashes to `7e25140df4f072ef7c1b9a7c03008483827fa90cae3144479b2f97be9033d6b6`. These are source-package identities, not proof of currently loaded runtime code.

## Focused qualification

```sh
python -m unittest tests.test_mast_staging_calls tests.test_r2_manifest_transaction -v
```

[Recorded result](evidence/mast-staging/focused-tests.txt): the single staged call-site matrix covers 13 synthetic transport/fault rows, with additional admission/writer/drain assertions; the 10 existing transaction tests also pass. In the CAS-conflict row, audio and artwork PUT occur once each while registration occurs twice. Covered faults include ambiguous artwork outcome, interruption, authentication, corrupt journal, stale generation, changed snapshot, decode failure and failed report publication. No broad full-suite rerun was used.

The authored runtime's process and uploader entrypoints execute through an authored subprocess CLI fixture using the staged argument contract. Actual supplied worker/uploader/launcher modules are inspected only as AST/text; they are not executed. HTTP/signing and FFmpeg are faked in this matrix. This is therefore integration evidence for the new call sites, not a live-wrapper, real-decoder or throughput qualification. Existing process-group and receipt fixtures remain reusable evidence, not newly claimed live coverage.

Focused review found and corrected two issues: a lease filename collided with artifact-directory accounting, and completion initially released admission before compatibility-report/pacing persistence. No remaining concrete replay flaw was identified in that review's scope; that earlier review preceded the now-completed writer integration; host qualification remains open.

## Reconciliation with Mast's sidecar proposal

[Comment 6104750454](https://github.com/braydenparker999/jarvis/issues/2#issuecomment-6104750454) independently confirms the replaced-inode race and the need to transition every writer together. This package already consolidates locking through the existing stable-sidecar transaction; no second wrapper is added. The proposed unchanged `save(snapshot)`, parse-error recovery and unfenced claim/status paths would still be unsafe. Prior source evidence says the builder writes directly, so changing `manifest_lib.py` alone cannot qualify it. The three supplied writer bodies have now been integrated as described below; no duplicate locking implementation is added.

## Writer source package validity — no bodies remain missing

[Comment 6104903813](https://github.com/braydenparker999/jarvis/issues/2#issuecomment-6104903813) supplies the three executable bodies. All parse; the append validation/assignments, runner mutation/upload paths and builder's direct-write tail are present. No executable ellipsis omission was found. The runner has 244 supplied versus 318 reported lines; builder has 176 versus 221, with report-directory configuration collapsed to placeholders. These are accepted executable-body evidence, not verified replicas of the private originals.

[Source validity record](evidence/mast-staging/writer-source-validity.json) separately records the reported original hashes, independently computed redacted-body hashes, declared redactions, function inventory and control-flow hashes. Redacted hashes do not equal or prove the original hashes. No additional full-source request is needed. At adoption Mast must validate the real on-host files/configuration against both checks and preserve those real settings. Any mismatch requires reviewing the precise differing code/configuration, not guessing or dropping the check.

## Newly targeted writer qualification

```sh
python -m unittest tests.test_mast_writer_integration tests.test_mast_staging_calls -v
```

[Recorded result](evidence/mast-staging/writer-tests.txt): five focused writer tests plus the existing staged call-site matrix/admission tests pass. They cover interleaved append/claim/scan preservation, duplicate append behavior, invalid-scan atomicity, historical-report review holds, late drain checks, configuration binding and redaction equivalence. Supplied modules remain inspection-only; tests execute authored transaction/integration code against temporary manifests.

Review found and fixed late-drain commit checking and mismatched builder/shared-manifest routing. Qualified-stage `request_drain()` writes/fsyncs DRAIN under the manifest sidecar, serializing marker creation with claim, writer and child-admission checks. An independently touched marker has precommit checks but is not an atomic marker/commit transaction; use the coordinated path for the new stage. This does not retrofit safe drain into the old launcher.

## Compatible transition and rollback — not yet approved

The previously described old-launcher STOP procedure is **not a safe drain guarantee**: it terminates workers after 180 seconds while a child timeout is 900 seconds. Do not use that procedure to claim safe activation.

Before any live transition, qualify the host's exact dependencies/source identities, reconcile existing claimed/ambiguous work, and obtain one concrete approval for the complete compatible writer/uploader/launcher set. Do not manually change the qualification marker to bypass these prerequisites.

For the old-to-new transition, Mast must identify and explicitly approve a supervisor-only maintenance control that prevents both respawn and its 180-second termination fallback while leaving existing uploader children alone. If no such control is available, transition remains no-go. Then close admission with the existing worker stop mechanism, observe all workers/children and establish terminal remote outcomes. Old workers may finish another claimed item or their current retries before exiting. A dead PID, released token, timeout, elapsed time or duplicate registration alone is not terminality evidence. No indefinite upload-token hold is proposed.

Only after that verified drain may the complete qualified set be installed together, with original credentials, worker IDs, token inode, manifest contents and pacing state preserved. Stable sidecars must be shared by every writer and never replaced. Any state migration or reconciliation needs its own concrete reviewed scope; the builder performs none. Resume exactly the existing worker population through the qualified launcher. New DRAIN closes admission while already-admitted chains can finish; incomplete/held claims prevent restart until reconciled.

Rollback changes future attempts only. Use the new non-terminating drain, preserve checkpoints/reports/snapshots, and establish that no active lease, claimed/held generation or ambiguous request remains. Restore a compatible whole writer/uploader/launcher set together. Restoring an old unfenced writer while new holds or claims exist is forbidden. Do not reset claims, delete journals, clear AUTH-STOP or requeue uncertain items to force rollback. If these preconditions cannot be established, leave admission closed for explicit reconciliation.
