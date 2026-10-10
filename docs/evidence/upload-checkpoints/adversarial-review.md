# Independent adversarial review — offline only

Reviewer: separate agent `/root/adversarial_review`, given the actual local
`/workspace/mast-upload-checkpoints.patch`, source and tests in
`/workspace/jarvis-upload-prototype`. The reviewer made no file edits. Initial
patch SHA256:
`7aa80371eb523f75be3a5082af3830efcdf284157fda3a0acd241ed119d17e6b`.
This identifies the reviewed input, not the revised final patch. The final patch
hash is reported separately after all documentation and evidence updates.

## Findings and fixes

1. **Medium — malformed blob acknowledgement accepted.** Original `receipt_ok`
   accepted arbitrary printable ETags, including `"not_an_r2_etag"`, outside
   `public/drawercast/r2-library.js`'s identity schema. Fixed to bounded ASCII word
   characters plus optional `-digits`. Corrected the formerly invalid fixture
   ETag. Regression tests verify acceptance boundaries and ensure invalid receipts
   retain pending state across reopening.
2. **Medium — malformed/unrelated registration acknowledgement clears pending.**
   Original `register` accepted IDs such as `r2_x`, counts over the server's
   50,000-track limit, and unrelated native IDs. Fixed exact response shape,
   boolean/integer types, ID/count limits and binding to the submitted audio
   SHA256. Nonduplicates must have that native ID; duplicates can retain valid
   migrated legacy IDs. Request identity is parsed without rewriting request
   bytes. Malformed acknowledgements remain unresolved. Regression tests cover
   each case and legitimate legacy duplicates.
3. **Coverage gap — persistence tests replaced the whole writer.** This was not
   evidence of a durability bug. Added injections inside the real writer for a
   partial temporary-file write, file fsync, replacement and directory fsync.
   Intent failure never starts transport. Acknowledgement failure before replace
   retains pending; after replace, reopening may see only a validated receipt.
   The failing live session remains poisoned in either case. No temporary file
   debris is left by these injected exceptions. Documentation now states the
   after-replace distinction instead of claiming every failed save must reopen
   as pending.

The reviewer independently re-read the fixes and reported: **no additional
substantiated offline defect found within the trusted-adapter, trusted-local-FS
and serialized-caller assumptions**.

## Independent verification

- Before fixes: 121 Python R2 tests (16 prototype), 14 native server tests passed.
- After fixes: `python -m unittest discover -s tests -p 'test_r2_*.py' -q`:
  **127 passed**, including **22 prototype tests**; no failures or skips.
- After fixes: `node --test tests/native-r2.test.js`: **14 passed**, no failures,
  skips or cancellations.
- Primary agent separately reran both suites at this review stage (141 tests).
  Later partial-contract revisions and current counts are recorded below;
  adjacent logs always contain the latest run, not the historical run.

## Reviewed invariants and remaining limits

- Exact immutable `bytes` are hashed and passed unchanged to the callback.
  Same-buffer hashing/signing and fresh timestamps were exercised through the
  public uploader with mocked signing and HTTP; this does not test Mast's
  unavailable private wrapper. Nothing is inferred about its exact code.
- Blob receipt key/SHA256/size/proof structure and cache destination/public
  identity are checked. This is structural validation, **not cryptographic
  receipt authentication**. Actual HTTPS destination, status, response provenance,
  no redirects/internal retries and identity binding require the future reviewed
  adapter. Schema-looking JSON and an error receipt alone do not establish this.
- At the original review stage, explicitly allowlisted, proven non-committing
  artwork 415 and register 409 responses could clear an intent. The later partial
  Mast contract revision removes artwork 415 from that allowlist to preserve its
  validation stop. The synthetic register-409 policy is not active Mast behavior. A generic
  exception, timeout, authentication error or unrecognized HTTP outcome leaves
  the job unresolved. Adapter classification still requires actual-wrapper review.
- Durable intent precedes callback execution. Actual child-process exit and
  injected storage failures are covered. No physical power-loss or target
  filesystem qualification was performed. The checksum is not protection against
  deliberate state rewrite or rollback; state storage must remain trusted.
- Per-journal flock serializes the same journal, not distinct jobs. The existing
  outer whole-chain flock, stable retry job-to-journal mapping and no overlapping
  old/new worker chains remain required. Lock files cannot be unlinked in use.
- Server fixtures confirm proof revalidation and first-registration-wins metadata
  even when blob uploads are omitted on retry. Registration is not cached.
- State excludes media/registration bodies, private key paths, signatures and
  arbitrary exception text. Public signer identity and validated object receipts
  remain. A trusted adapter remains responsible for response provenance.
- Empty cover guards, optional analysis correction and report/supervisor behavior
  must be tested with Mast's real wrapper before any activation. No hook exists.
- No live uploads, throughput measurements, publication, deployment, worker or
  schedule changes, or credential changes occurred. At that review stage sharing scope was unresolved and the patch was local.
  Subsequent owner authorization permits a draft PR. Activation still requires
  and a reviewed process transition; there is no flag-only activation claim.

## Follow-up after partial Mast contract

The same independent reviewer re-read the local changes and partial-contract
comparison. Artwork 415 now preserves a durable stop; the empty-cover fixture
skips both the PUT and registration reference. Four added fixtures cover reported
empty-cover handling, five outer attempts against a stable journal, old pending
state, and the negative example of internal callback retries outside helper
control. These are proposed seam tests, not a Mast wrapper implementation.

The reviewer independently reran **131 Python R2 tests (26 prototype)** and
**14 server tests**, all passing with no failures/skips/cancellations. No new
substantiated offline defect or material overclaim was found. The actual wrapper,
refreshed runtime source identity, single-attempt transport, durable retry/reclaim/
restart gate, and analysis-correction/completion tail remain activation blockers.
The new contract document is included in the local patch. No publication or
activation occurred. Total current suite count: **145**; not full branch CI.

A later preparation-ahead candidate is reviewed separately in
`../preparation-ahead/review.md`. The latest full logs include its 14 tests, so
the combined current count is 145 Python + 14 server = 159. Historical counts
above describe their respective review stages. Draft publication is now
authorized; no live process transition or activation has occurred.
