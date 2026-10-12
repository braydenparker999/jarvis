> Historical review chronology: earlier publication and missing-source statements describe their review dates. The latest source-pinned review below supersedes them; draft publication is now authorized, production activation is not.

# Latest PUT adapter review — local follow-up to f9b012c

Mast's comment 6100847903 reports that the active uploader accepts any HTTP 2xx
plus parseable JSON without PUT field validation. Raw-response validation is now
implemented only in the offline `ValidatedPutSender`; the runtime is unchanged.

An independent reviewer found one low-severity MIME grammar weakness (internal
token spaces were removed too permissively). Fixed with anchored grammar and
malformed-token regression cases. No further substantiated offline defect found.

Both primary and independent reviewer ran 148 Python R2 tests (29 checkpoint,
14 preparation), plus 14 server tests: 162 total, zero failures/skips/cancellations.
The preparation admission fixture now models four concurrent producers sharing
one pool, matching the reported count without changing actual workers.

The adapter checks expected status 200, exact response URL, allowed JSON MIME,
UTF-8, bounded raw body, duplicate fields and exact PUT identity/proof fields.
Invalid responses leave durable pending state. It cannot authenticate fabricated
callback metadata or detect hidden callback retries; the reviewed real transport
must provide actual TLS/HTTP provenance, read to EOF or sentinel, disallow
redirects, sign freshly and perform exactly one HTTP attempt.

Latest report places worker-local decode after registration before the manifest
registered write; standalone playbackVerified remains false. Current source
hash/process binding, actual PUT bodies and analysis mutation/completion tail are
still missing. Claimed/rest/backoff and stale reclaim remain incompatible with
unresolved mutation stops. No speedup, worker count, pacing, upload, process or
schedule changes occurred. This follow-up remains uncommitted/unpublished; draft
publication is still blocked and was not retried.


## Later 18:50 report / analysis guard

Four supplied source SHA256 strings were checked for lowercase-hex length: all
four are 64 characters. No source bytes or loaded-process binding was provided,
so none was verified. The changed three-worker claim remains a reported snapshot.
The new report supplies sequence prose, not the executable classifier/call site.

A conservative Session.analysis guard persists intent, sends the exact bytes,
checks identity/R2 proof structure/prior-CAS field presence, and validates the
separate analysis acknowledgement. The server validates actual analysis/CAS
semantics. All HTTP errors and ambiguous outcomes hold. A valid acknowledgement
also holds as analysis_acknowledged_completion_pending until a real local
completion transition can be reviewed. There is no finalize/reset API or claim
that catalog observation proves the remote writer terminal.

New fixtures cover matching catalog/age without release, repeated blocked reopen,
invalid acknowledgements, 401/409, missing proofs and acknowledgement persistence
failure before/after the write. Independent review found no new substantiated
safety defect. Actual transport, job binding and completion remain unverified.
Current primary suite: 153 Python (34 checkpoint,14 preparation) +14 server =167.
Earlier counts above are historical; adjacent logs contain the latest run.

Independent final rerun also passed 34 checkpoint tests, 153 total Python R2
tests and 14 native server tests. The new before/after acknowledgement-save
failure regression was separately verified; no further findings.

## Partial-excerpt boundary hazards

Public comment 6102590119 remains non-executable/abbreviated. Three new local
fixtures reproduce the shown ignored-False decode branch and conditional
manifest-inode replacement locking risk, with a stable-sidecar positive control.
One new native server test covers both audio and registration storage committing
then throwing; real repository handler code returns 503 despite the committed
fake-storage state. This is not an observed production event.

Independent review found no defect/material overclaim in these scoped fixtures.
Both runs passed 156 Python +15 native server tests =171, zero failures/skips/
cancellations. No runtime or prototype helper behavior changed in this increment.
Complete current functions and source-to-process binding remain missing. Nothing
was published or deployed, and no rejected publication action was retried.


### Manifest prerequisite review (offline follow-up)

An independent reviewer ran 10 manifest fixtures and the full suite: **168 Python + 15 native-server = 183**, no failures. Two medium findings fixed and independently verified: numeric exponent overflow could parse as infinity; interruption after rename before a success flag could escape uncertain-commit classification. Added finite float parsing and conservative rename-attempt classification plus regressions. No further substantiated defect within trusted local filesystem/cooperating writer scope. The class docstring was corrected to describe attempted rename. No runtime approval, live identity verification or speed measurement.


### Duplicate-analysis sequence review

An independent reviewer found one medium compatibility defect: sorted JSON reordered previousAnalysis and broke the real server's order-sensitive CAS hash. Fixed by preserving catalog property order in network correction bytes. The new cross-language fixture invokes only locally authored Python and the repository server handler with fake storage; it verifies HTTP200 and unchanged original metadata/R2 identity. Independent totals: **177 Python + 16 server = 193**, zero failures/skips/cancellations. Nine duplicate-sequence fixtures verify ordering, identity/proof preservation, raw response validation, ambiguous outcomes, interruption and durable holds. No further substantiated defect found within documented assumptions. Real transport, report/decode completion, recovery and process transition remain unimplemented; no production source identity verified.


### Parent/child worker boundary review

An independent reviewer verified **17 worker tests, 194 total Python tests, and 16 native server tests (210 total)**. Three defects fixed: Boolean report size accepted as integer; unbounded/blocking snapshot reread; empty attempt-directory creation before rejected admission. Regressions cover typed identity, FIFO/symlink/1GB sparse snapshot rejection, and no directory allocation on rejected retry. Retained attempt artifacts, durable global holds, stale-completion fencing, stop-after-token-wait and stop-before-request checks all pass in locally authored subprocess fixtures. Parent os._exit and child timeout/crash preserve holds. No further substantiated defect within documented cooperative filesystem/synchronous callback/trusted child assumptions. Actual wiring, bounded decoder/diagnostics/artifact lifecycle, descendant qualification and reconciliation remain unresolved. Review performed no edits or external actions.


### Final local resource and identity review

An independent reviewer confirmed **204 Python tests (including 10 resource and 17 worker tests) + 16 native server tests = 220**, zero failures in the final run. Fixed launcher minimum argv length so an executable without arguments works. An earlier full run exposed a test race: SIGKILL delivery to descendants is asynchronous. The fixture now polls for absent/zombie state with a bounded deadline, matching the guard's documented leader-reaping guarantee. No claim of immediate descendant or remote-request termination.

Artifact admission/runtime accounting, decoder deadline/diagnostics, cooperating process-group cleanup and inherited per-file size limits are implemented locally. Aggregate accounting is not a hard filesystem/RSS quota and allows transient excess; process-group escapes/abrupt supervisor death need host containment qualification. No further substantiated defect under documented cooperative-process assumptions. The identity update records a full reported on-disk hash and worker-local manifest helpers, but loaded worker bytes remain unknown because source mtime and process starts are only timing evidence. No edits or external actions by reviewer.


### Four-component composition review

The earlier 220-test candidate did not connect preparation-ahead into its child worker flow. The new composed_upload bridge and fixture now do. An independent reviewer verified **213 Python tests (including 9 composition tests) + 16 native server tests = 229**. Two ownership/concurrency defects were found and fixed: selected Artifact references outlived Pool release; upload token release preceded active-lease release and could cause a second consumer to close the shared Pool. Worker/consumer payload references now drop before lease release, and the release occurs while the token remains held. Deterministic weakref and two-consumer/flock-barrier tests verify ordering. Fixture child context tampering is rejected before PUT. No further substantiated defect under documented assumptions. This is local composition, not qualification of actual Mast extraction, transport, shared preparation ownership or runtime hooks. No edits/publication/production action by reviewer.

### Canonical source and public draft review

An independent reviewer reproduced the canonical package hashes using the documented final-LF convention and verified static inode-lock/stale-save findings. The supplied uploader differs from the repository only by the zero-byte-cover guard; no supplied source was imported, compiled or executed. The new locally authored stale-snapshot fixture shows why sidecar locking alone cannot repair save(snapshot). Final independent results: **214 Python + 16 native server tests = 230**, all pass. Public draft audit removes internal reviewer/workspace identifiers; no credentials, private user paths, raw runtime logs or external source artifacts are included. Complete external writer/schema contracts still block a runtime integration patch. Draft publication is authorized; merge and activation are not.
