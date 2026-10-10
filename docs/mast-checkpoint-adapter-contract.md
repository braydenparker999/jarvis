# Mast partial contract review — integration still blocked

This document compares the local prototype with two **unverified self-reports**,
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

## Corrections and incompatibilities

| Reported fact | Consequence for this prototype |
| --- | --- |
| Workers, signing, retries and manifest operations are plain Python, with no per-track model invocation | No model-cost or scheduling saving can be attributed to this upload patch. |
| Empty embedded picture data is skipped and treated as no cover | Offline call-site fixture now omits both artwork PUT and registration cover for empty bytes; helper still rejects an attempted empty PUT. Do not replace the deployed guard. |
| `playbackVerified:false` always; no per-upload playback check; ffmpeg decode was once on repaired tracks | Remove the earlier assumption of per-track validation/decode outside the lock. No decode/verification cost is available to eliminate. Keep reports false; do not claim playback success. |
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
  allowing the job to be retried/reclaimed. **The current helper ends at register
  and does not checkpoint `/analysis`.** A timeout there would escape its pending
  guard today. Completion/report failures must not blindly rerun the entire
  mutation tail; preserve the existing identity/CAS proofs and successful report
  meaning. Exact changes depend on bundle 4, so no guessed correction adapter is
  included. A read-only GET failure is distinct from an ambiguous analysis POST.

No prep queue, scheduling change, model invocation change, extra network
concurrency, live measurement or playback check is introduced. No flag activates
this code. A separately authorized and reviewed process transition remains
necessary, after refreshed identity and full offline wrapper/supervisor fixtures.
