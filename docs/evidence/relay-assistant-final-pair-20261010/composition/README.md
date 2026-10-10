# Independently inspectable exact composition

The previously local tested combined commit is now published unchanged on `review/relay-assistant-pair-bf358231`. It is historical review evidence only, not a current release/promotion candidate. Subsequent attachment integration must use the separately verified release baseline when parent coordinates it.

- `combined-commit.txt`: complete raw Git commit object, including tree and parent.
- `combined-tree.txt`: complete recursive path/mode/type/object listing, not a selected subset.
- Equivalent commit/tree listings for baseline, frontend and backend.
- `combined-vs-frontend.patch` and `combined-vs-backend.patch`: exact full-index binary-capable endpoint diffs, produced with `git diff --binary --full-index <component> <combined>` (not merge-base diffs).
- `all-paths-composition.json`: independent per-path audit across all four trees. Frontend and backend changed-path sets are disjoint. Every combined object/mode/type equals its designated source; unchanged paths equal baseline. Missing paths/deletions are included in the union audit.
- `SHA256SUMS`: hashes of every evidence file except itself.

All source is already within the authorized repositories and uses published synthetic test fixtures. No runtime credentials, private records or environment variables are collected. No merge, deploy or rebase was performed. Raw test logs remain in the parent evidence directory and are unchanged.
