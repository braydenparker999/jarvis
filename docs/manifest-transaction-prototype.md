# Offline manifest transaction prototype

This is a storage prerequisite, not a throughput optimization or installed worker fix. No runtime source was executed or replaced. Source comparison uses reported [manifest functions](https://github.com/braydenparker999/jarvis/issues/2#issuecomment-6102682701), [worker](https://github.com/braydenparker999/jarvis/issues/2#issuecomment-6102678396), and [uploader](https://github.com/braydenparker999/jarvis/issues/2#issuecomment-6102674725). Their hashes and 22:04:38 UTC observation are self-reports; excerpts contain omissions and do not establish loaded process identity.

| Supplied function | Hazard in supplied control flow | Isolated replacement |
| --- | --- | --- |
| `_locked_json(path)` | Locks manifest inode. `_write_locked` replaces that inode; newcomers lock a different inode and existing waiters read stale content. Exists/create also races. | `Transaction(path)` locks permanent `path + '.lock'`, then opens current manifest. Missing state stops; initialization is separate. |
| `_read_locked(f)` | Every exception returns `{}`, allowing a later mutation to erase state. | Strict bounded UTF-8 JSON, duplicate/nonfinite rejection, object/entries/entry-object checks. Preserve unknown fields; invalid bytes remain untouched. |
| `_write_locked(f,obj)` | Fixed `.tmp` can collide when serialization fails. Lock remains on old inode after rename. | Unique same-directory temporary, fsync file, replace, fsync directory under sidecar lock. Explicit single commit; failure never triggers automatic retry. |
| `_fsync_dir` | Open failure silently ignored. | Propagate failure. Once rename is attempted, conservatively raise `CommitUncertain`; new state may already be visible. |
| `claim_next()` | Same-worker claims always eligible; other workers' stale claims eligible without generation fencing. | Policy deliberately unchanged/unimplemented. Stable storage does not prove old upload writers terminal. |
| `set_status(sha, **fields)` | No expected owner/generation check before update. | Requires separate ownership fencing design; transactional storage alone cannot prevent stale worker completion. |

Smallest call-site seam, once all writers are known:

```python
with Transaction(MANIFEST) as tx:
    m = tx.value
    # Existing claim/status mutation and _recompute_stats, with reviewed ownership checks.
    tx.commit(m)
```

This deliberately is not a drop-in file object shim. Migrate every manifest reader/writer that needs consistency, including heartbeat, enqueue/reconcile and external scripts. Never replace/unlink the sidecar. All participants must use the same canonical local path and lock protocol. Legacy writers do not honor this lock. A separately authorized stop/join and reviewed process transition is required; no flag-only/no-restart activation. Confirm filesystem flock/rename/fsync semantics, manifest size/schema, and intended file access mode (prototype temporary replacements are owner-only 0600). No permission changes have been performed on real state.

The helper assumes trusted local paths and cooperating writers; no hostile path/symlink hardening, cross-host coordination, claim lease recovery, initialization, or garbage collection is included. Interrupted writes may leave an orphan unique temporary; never promote it automatically. Process-exit fixtures prove syscall-boundary behavior on the test filesystem, not physical power-loss durability. The persisted 16 MiB bound is not a peak JSON serialization memory limit; it is a prototype limit to verify against actual manifests.

Further excerpt findings: uploader hashes and sends the same `body`, skips zero-byte covers, and signs each call, but discards raw response provenance. Its `started_utc` / `started_monotonic` are undefined in the shown body; omitted code may differ. Analysis request/result handling, replaygain, setup and result augmentation remain incomplete. Worker `decode_check` returns false on exceptions and records `registered` regardless; registration and local decode must remain distinct evidence. `run_attempt` can concatenate `TimeoutExpired.stdout` bytes with a string and raise TypeError. The shown `process` retry loop has no STOP/AUTH_STOP check; main only checks before pacing/claim. Recheck durable holds and claim ownership after waits and before each outbound attempt in a future reviewed adapter. Do not classify timeout/5xx as safe replay solely from regex: ambiguous server writers may still commit.

Validation: locally authored tests, no execution of supplied snippets or external calls:

```
python -m unittest discover -s tests -p 'test_r2_manifest_transaction.py' -v
python -m unittest discover -s tests -p 'test_r2_*.py' -v
node --test tests/native-r2.test.js
```

The ten storage fixtures exercise four parallel writers (80 retained updates), waiting on stable lock versus stale data inode, child-process death on both sides of rename, malformed/duplicate/nonfinite state preservation, missing state, pre/post-rename fsync errors, interruption after replacement, and no implicit commit. Existing checkpoint fixtures cover ambiguous outcomes and existing completion fixture demonstrates decode false with registered status. No live speed gain measured; no network/provider concurrency changed.

Correction from [22:19 source report](https://github.com/braydenparker999/jarvis/issues/2#issuecomment-6102795755): Mast says the runtime temporary filename already uses PID+sequence, while the earlier published artifact used fixed `.tmp`. The comparison table above describes that earlier artifact, not a verified current runtime collision. Mast acknowledges the inode-lock bug remains. Truncated new worker hash is insufficient to verify source or loaded identity. The stable-sidecar prototype remains isolated.
