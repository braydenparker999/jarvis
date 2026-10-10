# Actual assistant-delivery paired qualification

- Frontend: `098721671ef434360669d76089910b6ed0300543`
- Backend: `0cb786014b14c454d1869ae1f970397a66f6201f`
- Baseline: `97b048abfde97426da7b5eb3a310964631ce724c`
- Local combined commit: `70212c98ac2c197a22149f89100b6ae35dce1da5`
- Combined tree: `f446c362c914721b3ec875fa6977c346ab2232b4`
- Runtime: pinned Node22.23.3, Chrome154.0.8037.97, Linux.
- Exact command from combined repository root: `node --test tests/relay-*.test.js`
- Result:1325 passed,0 failed/cancelled/skipped,160224.139527ms.

[Full TAP log](paired-1325.tap), SHA256 `7d6345f9cfe584bb5603fe807630c34e73345109427094ad42ba1ac5d35eac3f`. Synthetic invalid URL-userinfo test labels are redacted; no outcome or timing is removed. No credentials, private owner records or environment-variable values are included.

The combined checkout is the exact frontend delta applied onto the exact backend. Empty diffs confirmed public files match the frontend head; backend, scripts and companion fixtures match the backend. No capability injection, fixture byte-binding adapter or invented message acceptance.

The two new browser scenarios call the actual MCP route to upload canonical synthetic bytes and persist first/later deliveries through Worker/SQLite. They verify preserved accepted text, uncertain commit retry without duplicates, image preview, exact PDF download, revocation with a held preview, public isolation, file-only first reply,11 later deliveries through pagination,320px layout and Close. Existing backend runtime/workerd and inbound attachment suites run within this full test command.

Additional focused command `node --test tests/relay-assistant-attachments*.test.js tests/relay-attachment-transport.test.js`:15 passed,0 failures/skips on Node22.23.3 and Node24.21.0 with the same Chrome build. These are local synthetic tests, not live ChatGPT file delivery or production TLS/CORS qualification. Physical Android/TalkBack remains unrun.

This branch publishes evidence only and does not alter the reviewed frontend head or authorize promotion.
