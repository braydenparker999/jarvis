# Private assistant attachment frontend

Baseline: active release `97b048abfde97426da7b5eb3a310964631ce724c`.

The released private file renderer already supports incoming rows, bearer-protected reads, exact MIME/size/hash checks, explicit raster previews, document downloads, view cancellation and Blob URL cleanup. The released metadata parser prohibited assistant attachments. This frontend change admits them only with private authenticated owner-MCP provenance, the fixed owner principal, a distinct UUID original-message linkage, and metadata bound to the delivery entry ID. User upload validation remains intact.

Filename search includes file-only delivery entries. Empty-body entries do not expose a Copy text action. Subsequent deliveries retain their own IDs; incremental refresh keeps the accepted text reply alongside them and deduplicates repeated delivery IDs.

## Pending backend contract and integration

Backend delivery task owns actual MCP staging/delivery, authorization, byte validation, immutable retries and append-only storage. The frontend currently expects existing attachment metadata shape, `messageId` equal to the delivery entry ID, `role: assistant`, `replyTo` equal to the original owner message ID, and `authentication_source: owner-oauth-mcp`. This expectation must be reconciled against the final backend contract before integration. No new endpoint or fake production delivery is introduced here.

`relay-assistant-attachments.test.js` validates frontend parsing and incremental state with synthetic records. `relay-assistant-attachments-browser.test.js` explicitly supplies synthetic message/content responses to test the real frontend at320px: preserved reply text, filename search, raster preview, exact PDF bytes, private/public isolation and access loss. This is not end-to-end MCP delivery qualification. Existing upload and HTTP cancellation tests continue to use the real released backend.

Required before promotion: combine the exact reviewed backend, test actual first and subsequent assistant deliveries through MCP, verify accepted text remains unchanged and duplicate retries do not duplicate files, then run final source/deployment gates. No live owner records are used by published fixtures. Physical Android/TalkBack and native connector file delivery remain unqualified.
