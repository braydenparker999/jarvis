> Current adoption assessment: [canonical package integration review](canonical-package-integration-review.md). The dated entries below preserve earlier evidence and are not the latest missing-source checklist.

# Mast partial contract review — integration still blocked

This document compares the local prototype with **unverified self-reports**,
not inspected runtime code or authorization:

- [Mast upload contract](https://github.com/braydenparker999/jarvis/issues/2#issuecomment-6100648392),
  published 2026-10-10 18:13:07 UTC.
- [Mast capabilities supplement](https://github.com/braydenparker999/jarvis/issues/2#issuecomment-6100649470),
  published 2026-10-10 18:13:15 UTC; reports watchdog restart at 17:16:45 UTC.

No contact with Mast, runtime inspection, upload or activation was performed.
Subsequent owner authorization permits a draft PR for review; it does not make
this incomplete adapter safe to activate.
The parent owns communication. The local base remains release commit
`97b048abfde97426da7b5eb3a310964631ce724c`; it does not identify active Mast code.

## Latest addendum supersedes conflicting earlier reports

[Mast addendum](https://github.com/braydenparker999/jarvis/issues/2#issuecomment-6100847903)
reports an 18:35 UTC snapshot: launcher PID 4729 since 17:49, workers
4734/5520/5540/7774 (**four**, not the earlier three), no STOP/AUTH-STOP and a
parseable 5,065-entry manifest. This remains a report, not independently inspected
runtime identity. Source hashes, loaded-source binding and current liveness are
still missing. No new worker count is recommended or configured here.

The latest report corrects decode placement: the standalone uploader does not
check playback, but `relay-worker.py:decode_check()` reportedly runs local FFmpeg
after successful registration and before the atomic manifest `registered` write
(lines 339–342 and 427–432 reported, not inspected). `decode_ok` is not proof of
remote Range/CORS/cover/player playback. Keep `playbackVerified:false`. A decode
failure leaves local work unregistered after a possible successful remote commit;
that is a completion/reconciliation case, not permission to resend the chain.

The latest single-request description is `process()` → `run_attempt()` → a
subprocess running the uploader → `upload_request()` using urllib. The active
uploader reportedly accepts **any 2xx + parseable JSON**, including `{"ok":false}`,
without validating PUT acknowledgement fields. Therefore receipt validation must
be ADDED at the raw HTTP response boundary; it cannot be assumed to exist. Actual
successful raw fields are still unprovided. Register checking `registered is True`
does not authenticate an earlier PUT acknowledgement.

The parent additionally reports 60-second rest and 16 temporary failures in 15
minutes at 18:33. Those figures are not present in the linked addendum text read
here and were not independently measured. Proposed 15-second rest, five workers,
parallel chains and 2x/3x estimates are unverified and are not adopted. Preserve
current dynamic pacing, existing workers, single-chain serialization and stops.

The paragraph labelled ambiguous analysis outcomes in the addendum actually
describes REGISTER timeout/unparseable responses entering retry/backoff. It does
not supply the `/analysis` POST receipt, exact condition or completion ordering.
That missing analysis tail remains blocked; do not infer it from the heading.

## Historical corrections and incompatibilities (superseded where noted)

| Reported fact | Consequence for this prototype |
| --- | --- |
| Workers, signing, retries and manifest operations are plain Python, with no per-track model invocation | No model-cost or scheduling saving can be attributed to this upload patch. |
| Empty embedded picture data is skipped and treated as no cover | Offline call-site fixture now omits both artwork PUT and registration cover for empty bytes; helper still rejects an attempted empty PUT. Do not replace the deployed guard. |
| Earlier report denied per-upload decode; latest report corrects this to post-register worker-local decode | Latest addendum above controls: preserve decode ordering; do not equate it with remote playback verification or move/remove it. |
| Up to five retries for 429/5xx/network errors; claim expiry after ten minutes | This is NOT the proposed ambiguity stop/reconciliation policy. RemoteDisconnected, timeouts and generic 503s are not proof of no remote commit. Stale age does not resolve them. |
| AUTH-STOP is respected by the relay/watchdog; validation errors stop | Keep both behaviors. The prototype no longer clears an artwork-415 intent for retry; acknowledged audio is retained but the job stays stopped. |
| One shared flock; token released for retry backoff, rest outside it | Keep one chain across workers. Exact preparation/optional-analysis placement still needs source excerpts; do not move it based on an abbreviated audio/art/register description. |
| Phase checkpoints are not implemented; successful PUT described only as server JSON | No installed hook, active checkpointing or verified PUT receipt shape can be inferred. Repository server schema is only an expected contract, not runtime evidence. |
| VM replacement and watchdog restart reported at 17:16:45 UTC | Old PID/source observations cannot identify current workers. Refresh the identity and recovery path before integration. |

The reported ~23-second median inter-registration gap is not lock-held service
time. Retry-line counts do not locate the failed phase or establish a request
failure rate. Our two-PUT synthetic saving is not measured Mast throughput, and
its registration-409 scenario is not an enabled Mast retry policy.

## Smallest remaining public-safe contract, for parent-owned follow-up

Four bundles suffice. Existing source/records only; no test upload or secrets are
needed. If a fact cannot be established, label it unknown rather than extrapolate.

1. **Current source/process binding after replacement.** Supply observation UTC,
   boot/VM generation identifier (or nonsecret fingerprint), worker PID/start UTC,
   uploader/relay/watchdog source SHA256 (and commit where available), and evidence
   connecting the launched entrypoints to those exact source bytes. State whether
   any old workers or pending remote requests remain and what state survives VM
   replacement. A path or on-disk hash alone does not prove running code identity.
2. **The single-request boundary and actual PUT return contract.** Supply minimal
   sanitized function/call-site excerpts from file read/hash through signing,
   `urlopen`, status/body parsing and return. Show *audio and art separately*: an
   existing successful status, exact JSON field names/types/nesting, and how it
   reaches the caller. Expected from this repository is
   `{key,sha256,size,r2Identity:{etag,size,lastModified}}`; do not assert it is
   present in Mast without evidence. Include destination/public-signer binding,
   response URL/redirect policy, MIME, body bound, and exception types. Identify
   EVERY retry loop above/below that function. A callback must perform one HTTP
   attempt with the exact immutable bytes already hashed, and freshly sign it.
   Neither arbitrary JSON nor the sanitized error receipt authenticates success.
3. **Retry, claim and restart decisions.** Supply sanitized excerpts for the
   five-attempt catch/classification, manifest claim/reclaim, stable logical job
   identity, AUTH-STOP checks and watchdog restart gate. State how the same job
   maps to durable state even if bytes/process/VM change. Today there is no
   confirmed unresolved-job gate. The proposed adapter must make durable pending
   state authoritative before any retry/reclaim/network request; unresolved or
   missing previously-started state cannot become a new attempt after ten minutes.
   It must propagate authentication/validation stops, not remap them to transient
   retries. Identify where a separately reviewed reconciliation decision could
   enter; no reset-by-age/delete/new-job path is acceptable. A journal lock is not
   a replacement for the global token or remote-request reconciliation.
4. **Exact whole-attempt tail and completion order.** Supply the lock context and
   precise order/conditions for `prepared`, optional FFmpeg analysis, byte read,
   audio/art/register, duplicate library GET, analysis correction POST, success
   report write and manifest `registered` write. The report describes correction
   on duplicate; the public client gates it on available `audioAnalysis`. Resolve
   that difference instead of choosing either. Include bounded library lookup,
   SHA/size/R2 identity checks, correction receipt/exception behavior and which
   failure can re-enter the whole chain. `registered:true` is not proof that this
   tail finished, and `playbackVerified:false` must remain false.

## Smallest offline integration changes

Implemented now, without production imports:

- `ValidatedPutSender` is a proposed raw-response seam, not Mast's installed
  transport. It requires one HTTP attempt returning actual status, final URL,
  Content-Type and bounded raw body. The transport must read through EOF or the
  65,537-byte sentinel, never silently truncate; the helper cannot prove body
  completeness, TLS provenance or absence of hidden retries from supplied fields.
  It checks status 200 (repository contract),
  exact destination/path, JSON MIME/UTF-8, a complete body <=64 KiB, duplicate-key
  rejection, and exact key/hash/size/R2 proof schema. An adapter/session
  destination or public signer mismatch fails before requests or cache reuse.
  Invalid acknowledgements remain pending in the journal. Request bytes pass
  unchanged to the single-attempt transport, which must sign freshly. TLS/status
  provenance must be obtained from the actual response, not fabricated envelope
  fields. This does not change the active any-2xx behavior until integrated.
- New adversarial fixtures cover audio and artwork, `{"ok":false}`, 201/204/503,
  wrong URL/MIME, truncated/oversized/invalid UTF-8/duplicate-key JSON, mismatched
  identity and sender/session binding. The adapter does not classify these as
  safe-to-retry responses. No actual PUT receipt has been observed here.

- Empty-byte cover normalization in the fixture matches the reported skip
  semantics; preflight and the helper still reject mutable/invalid upload bytes.
- Artwork validation rejection now retains the acknowledged audio but leaves a
  durable stop, preserving the reported validation halt. The synthetic
  registration-409 allowlist is not mapped into Mast's runtime retry policy.
- Five outer attempts against one stable journal cannot resend an unresolved
  audio/art/register request. Tests cover timeout, RemoteDisconnected, 429 and
  503 without treating them as definitive rejection.
- Reopening arbitrarily old pending state still blocks. This tests journal
  semantics, not a manifest/watchdog adapter which does not yet exist.
- A **negative** fixture demonstrates that a callback with internal retries can
  still send five times before raising: checkpointing outside that callback
  cannot stop those sends. The actual one-request seam is therefore mandatory.

Remaining implementation, only after the four bundles above are reviewed:

- Install the checkpoint calls inside the existing global token, immediately
  around single-attempt audio/art/register calls; use the actual stable job key.
  Do not wrap an opaque whole-chain/retrying uploader. Preserve current backoff,
  adaptive rest and AUTH-STOP behavior. Do not equate all 429/5xx with retry safety.
- Add the unresolved-job gate to worker retry, stale reclaim and restart paths
  together, with journal pending authoritative even if manifest updates lag.
  Define durable recovery for missing/truncated state after VM replacement and
  test it offline with the real manifest format. Do not implement a second
  manifest/status schema based on this prose.
- Guard any duplicate-analysis mutation and its unknown outcome durably before
  allowing the job to be retried/reclaimed. The original helper ended at register. The later offline `analysis` guard
  below now holds both ambiguous and acknowledged corrections; actual integration
  and safe local completion are still absent. Completion/report failures must not blindly rerun the entire
  mutation tail; preserve the existing identity/CAS proofs and successful report
  meaning. Exact changes depend on bundle 4, so no guessed production correction/finalization adapter is
  included. A read-only GET failure is distinct from an ambiguous analysis POST.

No prep queue, scheduling change, model invocation change, extra network
concurrency, live measurement or playback check is introduced. No flag activates
this code. A separately authorized and reviewed process transition remains
necessary, after refreshed identity and full offline wrapper/supervisor fixtures.

## 18:50 readiness report: executable boundary remains missing

[Readiness report](https://github.com/braydenparker999/jarvis/issues/2#issuecomment-6101006336)
claims source observations at 18:50:15 UTC. The four supplied SHA256 strings for
relay-worker.py, upload-music-r2.py, manifest_lib.py and relay-uploader.py each
pass `[0-9a-f]{64}` (64 characters). **Format-valid is not verified:** no source
bytes or binding of those bytes to launched processes was supplied. These claims
are not used as checkout refs, integrity verification or runtime approval.

It reports three workers at 18:50 (4734, 5520, 5540; launcher 4729), saying 7774
was transient. Record this as a later reported snapshot; neither the earlier four
nor later three is independently confirmed. The four-producer queue stress test
remains useful regardless of the actual worker count and configures nothing.

The reported tail now matches the public client's broad condition: after register,
if duplicate AND audioAnalysis, bounded 30s library GET (16 MiB + sentinel), find
by ID and check SHA/size, then 120s analysis POST, then registered check, report/
stdout, worker decode, manifest registered. However, the prose does not show which
variable the registered check inspects. The public client attaches correction to
`result['analysisCorrection']` and later checks the original registration result.
Do not infer that the analysis response itself is validated by the active code.
It also describes generic exception classification, not the actual classifier.

`needs_verify` is proposed, not installed. A catalog row matching ID/hash/size
cannot prove an earlier timed-out request is terminal, nor that its analysis CAS
finished or local completion succeeded. Never clear intent based on that boolean,
stale age, a matching catalog read, or a replacement worker generation.

### Narrow executable boundary needed (no broader questionnaire)

Provide a single public-safe source slice/bundle, tied to source bytes rather
than prose line numbers, spanning:

- `upload_request` raw response/exception return through register → conditional
  library GET → correction POST → exact response check → report/stdout return;
- the consuming `run_attempt`/`process` catch/classifier, local decode and atomic
  manifest completion; include the specific retry/claim/reclaim/watchdog predicate
  that would prevent re-entry when a durable mutation/completion hold exists.

This is the missing patch attachment point. It determines response ownership,
where one request ends, which acknowledgement is checked, and whether exceptions
trigger another mutation. Source SHA strings alone cannot substitute for it.
There is no safe runtime adapter to install until this slice can be reviewed.

### Additional offline tail guard (deliberately incomplete)

`Session.analysis` now records durable intent BEFORE the injected correction
request, passes identical immutable bytes containing the existing identity/CAS
proofs, and validates the separate analysis acknowledgement against the requested
track and repository response schema. Timeout, malformed acknowledgement and any
HTTP rejection remain stopped. No registration-conflict retry exception applies
to analysis.

Even a valid analysis acknowledgement leaves durable
`analysis_acknowledged_completion_pending`, with the session blocked. There is
intentionally **no automatic finalize/reset API**: actual report/decode/manifest
completion and recovery semantics remain unavailable. This distinguishes an
acknowledged mutation from an unresolved one without treating either as end-to-end
completion or inviting replay. The existing `read_state` rejects both pending
states. It is a safe offline guard, not an operational completion implementation.

Fixtures cover timeout followed by a matching catalog observation and arbitrary
age, five blocked reopen attempts, wrong/false analysis acknowledgements, 401/409,
missing request/CAS identity, exact body pass-through and valid acknowledgement
held before local completion. No GET or mutation is performed against a real
server, and no report/decode failure is allowed to reset that hold in the fixture.

## Excerpt review: smallest actionable gap

[Uploader boundary excerpts](https://github.com/braydenparker999/jarvis/issues/2#issuecomment-6102590119)
contain ellipses, undefined request/receipt construction and prose in place of the
actual duplicate-analysis POST. They remain untrusted partial data, not executable
source. Their identity observations are still dated 18:50:15 UTC; repeated hashes
are not fresh process/source verification.

**Demonstrable excerpt hazard:** the shown `process` branch calls
`decode_ok = decode_check(path)` then unconditionally calls
`set_status(..., status="registered")`. A returned False would therefore still
mark registered. This contradicts the earlier claim that decode failure always
leaves an entry unregistered. An exception from decode_check could behave
differently; its actual return/raise semantics and surrounding handlers are not
shown. The offline negative fixture reproduces precisely the returned-False path,
not an assertion that the deployed worker necessarily behaves that way. Do not
silently fix/change its completion definition without the exact function.

**Mutation ambiguity:** visible classifier branches map 401/403 to auth,
429/5xx to temporary and other HTTP codes to fatal; remaining network matching
and unknown handling are abbreviated. A repository-native server fixture now
simulates R2 accepting audio or the catalog registration then losing its storage
acknowledgement. The actual server handler returns 503 with that mutation already
present. Thus 503 is not proof of no commit; generic temporary classification
cannot authorize checkpoint completion or assume the prior operation did nothing.
A fully received response also must not be conflated with a still-running timed-out
request: the latter specifically requires remote-terminal reconciliation. Neither
case is resolved merely by waiting ten minutes or observing catalog presence.

**Conditional claim-lock hazard:** `_locked_json(MANIFEST)` followed by atomic
replacement is safe only if the lock is a separate stable lock identity shared by
all claim/status writers. If it instead locks the replaced manifest inode, a new
claimant can lock the replacement while the first writer still holds the old
inode. The local negative fixture proves that filesystem behavior, and a positive
fixture verifies a stable sidecar lock survives replacement. The actual manifest
helper is unavailable, so this is a concrete verification requirement, not a
confirmed deployed defect. The offline checkpoint journal already uses a stable
sidecar lock; no production lock file was touched.

Only these exact complete functions are now needed—no new architecture survey:

1. **Uploader:** `prepared`; `upload_request` plus `UploadHTTPError` construction;
   the contiguous `main`/CLI block containing audio/art/register, actual conditional
   library GET and `/analysis` POST, result assignment/check, report write and exit.
   This establishes snapshot ownership, zero-cover skip, raw-response adapter
   placement, which acknowledgement is validated, and what reaches the subprocess
   caller. Keep private key paths/values redacted; do not replace branches with `...`.
2. **Worker:** complete `run_attempt`, `process`, `decode_check`, `classify`, and
   `UploadToken.__enter__/__exit__` with their stop checks. Needed specifics are
   report freshness/job binding, subprocess return/output handling, returned False
   versus decode exception, every network-signature match and each retry/terminal
   branch. `process → run_attempt → subprocess` prevents treating our in-process
   helper as an already-compatible drop-in.
3. **Claim writers:** complete `_locked_json`, `_read_locked`, `_write_locked`,
   `claim_next`, `set_status`, and the exact stop/reclaim predicate they share.
   This verifies stable lock identity, claim ownership during token waits and
   status updates, and where a durable unresolved-job hold must block re-entry.

These functions with provenance from their exact bytes, not just asserted hashes,
are the minimal executable patch boundary. No broad rewrite, additional workers,
pacing reduction, parallel upload chain, credential change or live test is needed
for this review. Preparation outside the token remains blocked until `prepared`
and source snapshot ownership are known. Analysis completion remains held until
actual return/classifier/report/decode/manifest semantics can be verified.

Completed offline: three boundary-hazard fixtures plus a server-side post-commit
503 fixture; existing raw-response validation, durable analysis holds, immutable
preparation admission and zero-cover fixtures remain intact. These tests expose
unsafe assumptions rather than inventing a substitute Mast worker or silently
adopting a new completion policy. No publication retry or runtime change occurred.


## 22:04 reported source follow-up

See [manifest transaction prototype](manifest-transaction-prototype.md) for exact supplied-function comparison, isolated stable-lock replacement and crash fixtures. Source comments 6102674725, 6102678396 and 6102682701 were read as data, not executed. Manifest locking hazard is now established for the supplied excerpt, not verified running bytes. Worker decode failure remains registered; shown retry loop omits stop checks despite accompanying prose. Analysis/setup/result details remain omitted. No runtime adapter or safe process transition is complete.

## 22:19 reported corrections and duplicate-analysis adapter

[Source excerpt 6102795755](https://github.com/braydenparker999/jarvis/issues/2#issuecomment-6102795755) supplies the missing branch and timing initialization. Read as untrusted data only; no external code executed. `started_utc, started_monotonic` are initialized immediately before the request try block in this artifact, resolving the earlier excerpt omission. The earlier fixed `.tmp` filename is superseded by a **reported** PID+sequence filename. The source claims the inode-lock replacement bug remains. The newly reported worker hash `75b00f68...` is truncated; none of this proves loaded runtime identity or current worker behavior. Do not describe the fixed-temp collision as a verified current runtime defect.

The supplied duplicate branch is: register result has duplicate=true and tags contain audioAnalysis; GET exact origin `/music/library.json` with a 16 MiB bound; select result ID; compare SHA256 and byte size; POST correction preserving catalog R2 proof and `metadata.get('audioAnalysis')` as previousAnalysis. It does not show explicit analysis acknowledgement validation. The previous outer result check tests the registration response, so cannot establish analysis success.

`Session.register_with_analysis(body, request_once)` now implements a locally authored isolated version of this sequence. The callback uses the raw response envelope contract: actual status, URL, content type and immutable response bytes; same request bytes must be signed and sent once with fresh signatures, no redirects or hidden retries. GET callback receives no body/MIME. Adapter validates status=200, exact origin/path, JSON content type, bounded UTF-8 unique-key finite JSON. Catalog match must be unique, ID/SHA256/integer size exact, metadata an object, and R2 proof structurally valid. Analysis schema and compare-and-swap remain server responsibilities. Catalog freshness alone cannot authorize replay or prove an old writer stopped.

The adapter durably stores `duplicate_catalog_pending` immediately after acknowledged duplicate registration, before GET. GET failure, malformed catalog, identity mismatch or interruption leaves a hold. The transition to analysis intent never persists a clear journal; validation failure restores the in-memory hold. POST timeout, auth/HTTP failure or invalid acknowledgement stays held; even a valid acknowledgement stores `analysis_acknowledged_completion_pending`. No automatic reset, catalog-based reconciliation, completion claim or replay is added. Original registration bytes, first-wins metadata, server proofs, catalog/input objects and prior-analysis value are preserved; absent prior analysis is explicit null. Nonduplicates or tags without audioAnalysis skip the correction. Existing raw `register` remains a low-level primitive; real integration must route the duplicate sequence through the new adapter under the existing whole-chain lock.

Nine new offline tests cover exact order/proofs and unchanged inputs, skip conditions, absent previous analysis, mismatched identities/proofs, duplicate catalog IDs, invalid/oversized/nonfinite JSON, timeout at each stage, false/wrong analysis acknowledgement, auth/HTTP/envelope rejection, interruption between registration and GET, and same-session/reopened hold preservation. No live throughput is measured.

Remaining concrete integration gaps: complete wrapper setup/replaygain/result augmentation and worker/report ownership call sites; full source hashes and loaded process identity; raw response provenance/fresh-signature transport wiring and error-class mapping; actual analysis schema qualification; attempt-specific atomic report and truthful decode/completion transitions; durable stop checks after waits and before outbound attempts; claim-generation fencing and resolution of ambiguous remote writers; all manifest writers migrated together to stable lock; separately reviewed and authorized process transition. The isolated helper installs none of these runtime changes.

Independent review caught and fixed a real-server compatibility issue: the journal `encode()` sorts nested object keys, while the server compares hashes of JavaScript `JSON.stringify(previousAnalysis)`. Network correction now uses compact unsorted JSON, matching the supplied branch/public client and preserving catalog property order, including nested objects. A Node test executes only our locally authored Python adapter against synthetic input, then submits its captured bytes to the real local server handler with fake storage. It confirms a changed multi-key analysis succeeds with HTTP 200 while original title and R2 proof remain unchanged. This test requires local Python as well as Node; it performs no HTTP or real uploads. Future cross-language numeric edge cases outside the validated server analysis schema remain unqualified.

## Offline parent/child integration extension

[Worker boundary prototype](worker-boundary-prototype.md) now provides the explicit completed-prototype / artifact-mapping / unresolved-wiring table. Its locally authored child composes checkpoints through fresh report, exact-snapshot decode and fenced completion, with global holds on every abnormal outcome. Seventeen subprocess/fault tests cover the remaining known worker boundaries. This is an executable proposed protocol, not a patch to the unprovided complete Mast runtime. Existing auth holds, source files, provider/network concurrency and pacing are not changed.


## Identity clarification and final resource bounds

[Final worker integration mapping](worker-boundary-prototype.md#final-local-resource-safeguards-and-identity-correction) incorporates comment6102909497: helpers are local to relay-worker, manifest_lib is not imported, full on-disk worker hash is reported, and starts straddle source mtime. Loaded code remains unknown; temporary-name fixes cannot be asserted for every worker. Process-group/decoder/output/per-file limits and artifact admission/runtime accounting are now locally implemented and tested; process escape/supervisor-death containment and hard aggregate filesystem quota remain production facts to resolve.
