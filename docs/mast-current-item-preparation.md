# Mast current-item preparation: incremental review candidate

Review [the three-file patch](patches/mast-current-item-preparation.patch) as the proposed first increment. The larger offline prototype remains reference material. The earlier baseline-upload canary is not the activation path for this change. This document authorizes no installation, upload, merge or process change.

## What changes

For the already-claimed item, the worker snapshots and prepares local audio before waiting for the existing upload lock. The uploader then consumes the hash-pinned snapshot under that same lock. No next-item claim, provider download, receipt reuse or network concurrency increase is added. Existing metadata extraction, zero-byte-cover guard, network/register sequence and fresh signing remain intact.

The patch changes `relay-worker.py` and `upload-music-r2.py`, and adds `prepared_handoff.py` beside them. It leaves manifest writers and UI code unchanged. Preparation uses a 60-second limit, 32 MiB audio limit, 2 MiB cover limit and 16 KiB descriptor limit. Two shared artifact slots bound disk use; occupied slots cause waiting outside the upload lock. Failure evidence is retained. Successful matching reports and clean decode permit cleanup of prepared files only; originals remain untouched. The current worker does not enable optional analysis.

Expected benefit is overlapping preparation with another worker's network chain and avoiding repeated preparation on retry. There is no measured live speed gain. Snapshot I/O and another local process can make an uncontended upload slower.

## Source identity

Apply this diff to the source-pinned Mast pair, not the older public uploader. Do not install a redacted source snapshot as a runnable worker.

| File or artifact | SHA256 |
| --- | --- |
| Existing uploader | `7cb0a7b9015dc1a536a3365f7e1a4d0c1c9b305cda4a2e9c02e5eb3ccd135c4c` |
| Existing unredacted worker, owner-reported; not independently verified | `75b00f687efba00e8c14db33694cb524c6301b05ac5ec52f9ee516790ea9377f` |
| Redacted worker block used to construct diff | `7c9231f78973814ec54d0f185ac129870734cbf6b07181846b8699529f0912e9` |
| Patched uploader | `f4fa1fd2ff8a532a0c50a2d3cc5633baf5bc442e027a26350a18bdf7597bd19a` |
| New helper | `4554f4d82e4b6178f94b675711c5123c6624d0c39e311b4437c17c5f94d4ffb1` |
| Patch | `d7710f21114e8f711c8a2b506c35e78b2a76dc1afc1b9b3103c19bb6bc6a9b44` |

The host must record the patched unredacted worker's hash after applying the diff to its verified original. Patch hunks do not replace private configuration.

## Focused evidence and limits

One focused local test passed. It executed only newly authored helper/test code with synthetic fixtures: exact audio/metadata/cover/analysis round trip, changed original after snapshot, empty cover, descriptor/corruption rejection, bounded reads, two-slot admission and original-preserving cleanup. Static AST/text checks established preparation-before-lock ordering, local-only return before network calls, and unchanged extraction/request functions and network tail. The patch also passed a clean application check against the pinned source blocks.

Neither supplied worker/uploader module was executed. Mutagen, FFmpeg, signing and network transport were not exercised by this test. This is not a runtime integration or throughput result; the larger prototype's test count does not validate this smaller integration.

Unchanged baseline risks include manifest inode-replacement locking, stale claims and missing generation fencing, timeout retries without terminality proof, and registered status despite decode failure. The patch does not certify or repair those behaviors. New tradeoffs include extra local CPU/disk work, preparation timeout/metadata limits and backpressure when failure evidence occupies both slots. Retained artifacts are not server receipts or permission to retry.

## Minimum compatible transition — requires separate owner approval

1. **Stage and verify.** Confirm host source hashes; apply the patch to private staged copies and retain backups of the original pair. Confirm helper import location and space for two approximately 34 MiB artifacts plus small reports. Preserve the worker's real private configuration. Mast supplies the actual existing launcher maintenance/restart commands before approval; no service name or command is assumed here.
2. **Pause new launches and drain.** During an approved window, use the existing launcher's maintenance control and existing STOP mechanism. Do not kill uploads or hold the upload lock. The old worker checks STOP only at its outer loop: a pacing worker may claim another item, and an active item may finish its existing retries before exit. Wait for all workers and uploader children to finish and establish terminal outcomes for outstanding requests. An unlocked token, process exit or timeout alone is insufficient. Ambiguity blocks restart pending reconciliation.
3. **Install the compatible set while stopped.** Install both patched scripts and the helper. Preserve the existing token file/inode, credentials, worker IDs, manifest, report paths, pacing state and launcher configuration. Do not clear AUTH-STOP. Remove only the maintenance STOP created for this approved transition after checks pass.
4. **Resume existing workers.** Use the existing launcher, same worker population, IDs and arguments. Do not start an extra uploader. Confirm loaded revisions and retained pacing state. This requires a process transition; it is not flag-only/no-restart activation.
5. **Rollback future attempts if needed.** Repeat the admission pause and terminal-outcome drain, restore the backed-up pair, then resume through the same launcher. Preserve prepared slots and uncertain evidence. Do not reset claims, replay items, clear authentication stops or delete remote objects. Rollback cannot undo registrations or resolve ambiguous requests.

Approval scope: this three-file installation and one controlled drain/restart window, with unchanged credentials, worker count, pacing and manifest writers. No baseline canary, indefinite lock hold, receipt reuse or broader prototype adoption is included.
