# Atomic chooser clean pair

- Frontend: `bc2d3e956dd96226b7e0664d2f531487f56c3102`
- Backend: `e8f9e2be23520f8eecaf31e65864f28da6214a2e`
- Combined local commit: `d8d2b7a73133c7dd686c7d202075049546cef5fb`
- Combined Git tree: `b469ac13179a2e5105ee86543ca5ceecd0e9c1cd`
- Node22.23.3 / Chrome154.0.8037.97, Linux.
- Exact command from combined repository root: `node --test tests/relay-*.test.js`
- 1286 passed, 0 failed/cancelled/skipped; 195589.835996ms.

The combined checkout applies the frontend/navigation delta to formal backende8f9e2b. Empty Git diffs verified that public files exactly match frontendbc2d3e9 and backend plus tests/relay-fixture.js exactly match backende8f9e2b. No temporary capability-enabling or BLOB adapters. The unavailable-service test explicitly supplies false; actual delivery and HTTP tests require the backend's real true signal.

Coverage includes actual Worker/SQLite delivery of both selected files while the first image preview is held, exactly one linked message, and no resurrection after late preview completion. Model and browser cases retain clear/access-loss/channel-change protection. Seven actual HTTP cancellation/retry cases remain included.

[Full TAP log](paired-1286.tap), SHA-256 `d77c2665d3c7882c528822c027767cf0ea02e915d413b0241237df03479b576c`. Only synthetic invalid URL userinfo labels are redacted; full outcomes/timing remain. No credentials, private records or environment-variable values are included. Physical Android/TalkBack, live connector consumption and production CORS/TLS remain unrun.

This evidence-only branch preserves the reviewed frontend head unchanged; it is not a release or deployment branch.
