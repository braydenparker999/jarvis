# Offline upload checkpoint prototype — not activated

Base: `release/astra-live-backport-20261009` at
`97b048abfde97426da7b5eb3a310964631ce724c` (fetched and checked locally).
The original checkout remains untouched; work is in a separate local worktree.
No AGENTS.md or .agents/skills exist in this source tree; /workspace/.agents is
empty. Reviewed STYLE_GUIDE.md, JARVIS-HANDOFF.md, docs/native-r2-uploads.md,
the uploader, nativeMusic server, upload-receipt tests and R2 validation workflow.

## Why this seam

The public Python client calls `upload_request` for audio, artwork, then
registration. `backend/music-upload.js` returns `{key,sha256,size,r2Identity}`
after hashing the uploaded body, conditionally storing it and checking its
server-created verification metadata. The helper validates receipt structure and
identity, not cryptographic authenticity: the future transport adapter must
establish the authenticated destination, successful HTTP status and provenance. The client currently ignores those PUT
receipts. Reusing validated acknowledgements avoids resending the largest bytes
on a later, definitively rejected phase. It needs no provider-download changes,
prep threads or queue, and no increase in network concurrency.

`scripts/prototypes/upload_checkpoints.py` is an isolated helper with an injected
transport. Nothing imports it in production. It does not replace the public
client or private Mast wrapper, and does not include a network command/CLI.

One journal belongs to one logical track job and all its retries. It retains at
most two acknowledged entries (audio/art), with no media bytes or credentials.
Reuse binds the exact immutable bytes' SHA256 and size, object key, request path,
MIME, destination and public signing identity. The same Python `bytes` instance
is handed to the transport; that transport must hash/sign/PUT those same bytes.
Changed identity requires a new PUT. Returning a cached receipt makes no request.
Every actual request must get a fresh signature through the existing transport.

Before a request, the helper atomically replaces and fsyncs a durable pending
intent. Only a strictly validated acknowledgement clears it. A timeout, malformed
response, 401/403, unknown HTTP failure or interrupted request leaves the job
blocked. Persistence failure poisons the current session. On reopen, a failure
before acknowledgement replacement leaves pending; a failure after replacement
may expose the validated acknowledgement. Either outcome avoids replaying an
unresolved blob PUT. Failed intent persistence never starts the request. It cannot automatically resend anything,
even if its prepared bytes change. No pending-state reset/reconciliation API is
provided. Missing/corrupt/checksum-invalid state fails closed; `create=True`
refuses to overwrite an existing journal. Never use a new job/journal or delete
state to escape an ambiguous request. The journal checksum detects accidental
corruption; it is not authentication against an actor who can rewrite the file.

Only the synthetic trusted-adapter registration 409
`registration_library_changed` classification permits another attempt. That exact
server branch cannot have committed that phase. Artwork validation rejections
remain durable stops; they are not enabled retries. Registration-409 retry is a
prototype fixture, not a confirmed Mast policy. The helper clears the
intent but still raises the rejection, leaving backoff and retry decisions to
Mast. All other failures stop conservatively. An arbitrary status/code or echoed
JSON from a proxy is not enough to establish a definitive rejection.

Registration bytes are passed unchanged and registration is always sent. The
helper validates the request audio SHA/size and bounds the response count/ID; a
nonduplicate or native acknowledgement must carry the submitted audio's native
ID. Only a duplicate may retain a valid migrated legacy ID. The server's existing proof checks, first-registration-wins metadata, duplicate IDs
and compare-and-swap writes remain authoritative. Duplicate analysis correction
and final reporting remain in the caller after registration, outside this
prototype's coverage. No playback verification is claimed. ETags follow the repository identity grammar
(ASCII word characters with an optional numeric multipart suffix, bounded to 128
characters); arbitrary printable response text is not persisted as an ETag.

## Required integration contract and activation prerequisites

1. Obtain Mast's public-safe current call-site contract and review an adapter
   against its actual wrapper. Its exact code is unavailable here. Partial reports were subsequently reviewed
   in `docs/mast-checkpoint-adapter-contract.md`; they do not close this gate. Confirm body
   ownership, request return schema/provenance, exception classification, job ID,
   retry behavior and report/analysis flow. Do not replace Mast with the public
   uploader. Preserve its zero-byte-cover guard: absent/empty covers must never
   cause a PUT or a registration reference. The offline fixture now skips empty picture bytes as Mast reports; the helper
   rejects attempted empty PUTs. Test the actual extraction guard before audio.
2. Preserve the existing **whole-chain flock**, and audio/art/register serialization; confirm the exact preparation/optional
   analysis boundary against current source before any integration. Open a checkpoint session inside it. The
   helper's per-journal flock only protects that journal; it does not serialize
   different jobs or existing workers. Keep adaptive rest and retry backoff in their current locations. Mast now reports
   no per-upload decode/playback check; do not assume such a phase exists. Do not add an
   independent uploader or concurrent retries. All workers/retries for a job
   must resolve to the same stable journal path; path derivation cannot change
   when prepared bytes change. Test this with the real supervisor contract.
3. Bind the session destination/public identity to the actual transport. Require
   authenticated HTTPS, no redirects, one request per callback, fresh signatures,
   no internal retries, bounded response parsing and validated success status.
   Only that adapter may turn a proven non-committing Worker response into
   `Rejected`. Existing diagnostic error receipts alone are not cryptographic
   proof of response origin. No keys or permissions are changed by this patch.
4. Establish a trusted, durable local journal directory and retention policy
   under existing permissions. Validate atomic rename/fsync/flock semantics on
   the target filesystem. Missing state must not implicitly create a fresh job.
   Journal locks must not be unlinked while workers can still reference them.
   Keep blocked jobs quarantined until a separately reviewed procedure proves
   the original request has finished and reconciles server state. An idempotent
   registration endpoint is not evidence that an old request is finished.
5. Review the concrete wrapper adapter and offline integration fixtures, including
   optional analysis correction and successful-report semantics. No production
   hook is installed, so activation requires an explicitly authorized, separately
   reviewed process transition with no overlapping old/new chains. There is no
   flag-only/no-restart activation path. The expired deployment window supplies
   no authorization. Confirm rollback retains journals and unresolved-job stops.
6. Only after activation authorization, establish a controlled measurement plan
   for real retries and end-to-end throughput. This work performed no real upload,
   publication, merge, deployment, worker/schedule change or credential operation.

## Reproduction and evidence

From the repository root, with Python 3 and Node available:

```
python -m unittest discover -s tests -p test_r2_upload_checkpoints.py -v
python -m unittest discover -s tests -p 'test_r2_*.py' -v
node --test tests/native-r2.test.js
```

Fixtures inject fake transports; the existing Python transport is exercised with
mocked signing and HTTP opening (no real key or network). Tests cover retained
audio after rejected artwork, both blobs after rejected registration, changed
bytes/destination/signer/extension, timeout at each phase, invalid receipts,
authentication stops, corrupt/missing state, actual child-process exit,
acknowledgement-save failure, intent-write failure, partial temporary writes,
file/directory fsync and rename failures inside the real persistence routine,
credential-free state shape, interprocess journal locking,
closed sessions, empty cover, unchanged registration bytes and fresh signatures.
Native server fixtures additionally verify first-wins metadata and that cached
client acknowledgements cannot bypass the server's current blob proof checks.

Evidence is in `docs/evidence/upload-checkpoints/`. In the deterministic
registration-conflict fixture, audio is 4,108 bytes and artwork is 15 bytes:
whole-chain retry sends 8,246 blob bytes in four PUTs; checkpoint retry sends
4,123 blob bytes in two PUTs. Both send registration twice. This is **4,123 fewer
blob bytes / two fewer PUTs (50% across this two-attempt fixture)**. It is not a
wall-clock benchmark or a 50% throughput claim. Normal successful first attempts
save zero PUTs and incur extra durable state writes. Uncertain failures stop
rather than produce a savings result. Real gains depend on retry frequency,
phase failure distribution, bandwidth and fsync latency; none is measured here.

This is offline development evidence, not full branch CI qualification, browser
or Poweramp qualification, live server verification or approval to activate.

## Independent adversarial review

A separate reviewer agent inspected the actual local patch, source, server
contracts and tests. Review findings and their resolution are recorded in
`docs/evidence/upload-checkpoints/adversarial-review.md`. The review found two
medium malformed-acknowledgement validation defects, both fixed with regression
tests. The reviewer also requested storage-boundary coverage, added without
claiming real power-loss or target-filesystem qualification. Subsequent owner authorization permits draft-PR publication for review only;
no runtime activation is performed.

The later partial Mast contract review and exact remaining adapter requirements
are in `docs/mast-checkpoint-adapter-contract.md`. It supersedes earlier unknowns
about empty-cover behavior, per-upload decode and the currently unsafe retry/
reclaim boundary. The current helper does not guard an analysis-correction POST;
that tail must be integrated safely before activation.
