# Read-only runner shape diagnostic

The host mismatch is not yet explained. Do not change pins, broaden exclusions,
or bypass the builder. This diagnostic reads and parses two files; it never
imports or executes their code and writes no host files. It does not interact
with workers, markers, services, network, or credentials.

From the repository root of this review checkout, using the same Python
interpreter used for the failed builder, run:

```sh
python3 -B scripts/staging/shape_diagnostic/compare.py /tmp/stage-test/input/queue-runner.py
```

Return only the printed JSON. Both file pins must match. Output contains Python
version, the two shapes computed by the SAME interpreter, and up to 20 AST field
paths with line numbers and difference categories. It contains no source text,
private paths, literal values, or source identifiers. Configuration exclusions
are exactly the existing builder's WS/KEY/REPORT_DIRS top-level assignments.

If shapes agree on the host, the pinned builder hash has a cross-interpreter
serialization problem. If they differ, the AST paths identify where the
redacted reference and pinned host file differ. Neither result authorizes
activation or automatic acceptance of those differences.

Local tests:

```sh
python3 -B -m unittest discover -s scripts/staging/shape_diagnostic -p test_compare.py -v
```

Local Python 3.12.14 reproduces expected runner shape
`d6cf2db731a88d7780df9c12d864057b4b28c362dd7fb27d09adabe9cb715e7c`.
Removing only empty `type_params` fields yields
`bc4fea6e41d568e95d65b2b1e223602470cee49342e955227ae7e8fd68f5d3d8`,
which is NOT reported host shape
`fb3e1249868e1b0e6c03809ed1fbb885af26c1ae6612216e83306da99af50e6f`.
Thus that specific version hypothesis alone is not an explanation.
