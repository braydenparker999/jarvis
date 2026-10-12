# Manifest-builder reference correction

Reviewed source: https://github.com/braydenparker999/jarvis/issues/2#issuecomment-6108954751

The exact supplied sanitized bytes are preserved in
`scripts/staging/shape_diagnostic/build-queue-manifest.redacted.txt`.
SHA256: `1cfec9eb9742cde9f5821504c3f17d22eb92313bf1d58f682ca6023ebb74551a`.
Normalized AST SHA256: `711f34f2303c0cf243b0a8ff0dfe58241e387eb1ea02d477d1e122a40e7a4fea`.
The original raw-source pin remains
`a56a29dbb8dac08b95c9cd5218251daebe1f395112d2b46570fb68923f349951`.

The earlier reference omitted an HF path assignment and a module-level loop
appending seven scope-specific report directories (ten entries including the
initial three), detailed size/twin error messages, a manifest note, an entry-count
print, and docstrings. Hashing, cover inspection and tag validation ASTs are
unchanged. Module-level additions construct paths and update a list; they do not
read files or contact a service. No supplied module was imported or executed.

Only the sanitized-reference pin and expected shape changed in the builder.
Raw pins, admission logic, exclusions, transformations, runtime and live state
remain unchanged. The existing transform preserves discovery and replaces direct
manifest replacement with fenced reconciliation. Existing entries remain
first-wins; newly discovered historical registrations remain held for review.

Focused checks:

```sh
python3 -B -m unittest tests.test_mast_builder_reference tests.test_mast_writer_integration tests.test_mast_staging_calls -v
python3 -B -m unittest discover -s scripts/staging/shape_diagnostic -p test_compare.py -v
```

Results: 10 integration/reference test methods (including the 13-scenario
synthetic transport matrix) and 13 diagnostic tests pass. A seven-input local
review build passes using AST/text inspection only. This is not live throughput
evidence or host qualification. Historical qualification/source-validity records
and the earlier source-call-sites patch predate these reference repairs and must
not be treated as qualification of the corrected source.

Remaining: a fresh private host build at the repaired commit with all original
raw pins, preserved private settings, identified current host/interpreter and
dependencies. Activation also requires reconciliation of uncertain uploads and
a separately approved drain/process transition. No installation, upload, restart,
credential change, state migration or deployment is authorized by this repair.
