# Synthetic private attachment evidence

`linked-private-files-diagnostic.png` is an actual Chromium154 render at390x844
with synthetic PNG/text/PDF fixtures only. It contains no live owner data.

Initial diagnostic backend: e3f4c1a635c77bba5e7e1ee6d0a5cafc586e7f91.
The temporary integration harness supplied the missing capability flag and
normalized ArrayBuffer BLOB bindings for Node SQLite. Staging, linking and content
routes otherwise used the actual backend. Five browser scenarios passed.
This screenshot is visual review evidence, not clean paired-head qualification.
Final paired-head results must be recorded in the PR before integration.
