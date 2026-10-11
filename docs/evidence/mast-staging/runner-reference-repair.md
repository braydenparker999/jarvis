# Reviewed runner reference repair

The earlier reference omitted docstrings, timing/logging and adaptive pacing
code. Earlier qualification.json, writer-source-validity.json and call-site
patch records describe that superseded reference; they are historical evidence,
not qualification of this corrected source. Host qualification remains blocked.

Reviewed public source:
https://github.com/braydenparker999/jarvis/issues/2#issuecomment-6108705432

The supplied artifact additionally over-redacted two expressions. Both were
restored verbatim from the already-published reference:

```python
R2DIR = os.path.join(WS, "r2-upload")
path = os.path.join(WS, entry["path"]) if not os.path.isabs(entry["path"]) else entry["path"]
```

Placeholder values inside WS, KEY and REPORT_DIRS were quoted as strings. Those
are the existing excluded configuration assignments; no exclusion was added.
After these repairs, the entire remaining AST matches the reported host shape
from comment 6108586426 exactly, including docstrings and executable statements.
No external source was imported or executed.

- Raw host pin, unchanged: `47bacb1651dc3a826822c79736968c4e9a8d917b4e1f9adc8d1e37d1370f5d18`
- Corrected reference SHA256: `5e2ec27106724efdb16e69cfa0442f594339681abbf862451b76e9b69f5501da`
- Corrected normalized AST SHA256: `fb3e1249868e1b0e6c03809ed1fbb885af26c1ae6612216e83306da99af50e6f`

The two preserved module-level statements define widen_pacing(reason) and
maybe_narrow_pacing(clean_streak). They have no decorators, default arguments,
or annotations. Their bodies mutate only paced_gap and call the existing logger:
the first increases by 15 up to PACED_GAP_MAX; the second decreases by 15 toward
PACED_GAP_MIN after 50 clean registrations. Definition does not execute these
bodies. Their callers are in process/main, which the existing builder replaces
with retirement code. The added t0 timestamp is unused; other omitted code logs
startup/idle/streak information, widens pacing on temporary retries, tracks clean
registrations, and changes the parked-error text. Authentication still returns
through the auth-stop branch. No uploader/runtime behavior is changed here.

Strict raw-byte and normalized-AST admission checks remain in place. Hash equality
supports source equivalence outside declared configuration; it does not establish
which VM ran the report or qualify the intended live host. A fresh private host
build, provenance, reconciliation and separately approved transition remain
required. This repair performs no install, restart, upload or state migration.

Focused validation commands:

```sh
python3 -B -m unittest discover -s scripts/staging/shape_diagnostic -p test_compare.py -v
python3 -B -m unittest tests.test_mast_writer_integration tests.test_mast_staging_calls -v
```
