# Final actual assistant-delivery pair

- Frontend: `94f7e73d531f474a93dd2ea826e641c075793b0a`
- Backend: `2ca9559671be7973793dbac44c86b4ea8dcd5a53`
- Backend tree: `d6eae8123221f3ca478ba1da474e6052e4d16a4e`
- Common release baseline: `97b048abfde97426da7b5eb3a310964631ce724c`
- Local combined commit: `bf3582313dcdde2bb52f4d2f55f2ab09d8219b02`
- Combined tree: `7e48d2114809ed9f7627f3f874a78b57e4288f78`

The exact frontend delta from the baseline was applied to the exact corrected backend. Empty diffs verified public files match frontend94f7e73d and backend/scripts/companion fixtures match backend2ca9559. Clean worktree. No manual backend changes, fake acceptance, capability override or byte-binding adapter.

## Commands and results

From the combined repository root, with pinned Chrome154.0.8037.97 and approved browser executable selected:

1. Node22.23.3: `node --test tests/relay-*.test.js`
   -1334 passed,0 failed/cancelled/skipped;166723.391167ms.
   -[Complete unmodified TAP](node22-full.tap), SHA256 `50761b98b990f9768953c43d1c7356e788060ce34e18ab7ea033c0988adc54fa`.
2. Node24.21.0: `node --test tests/relay-assistant-attachments*.test.js tests/relay-attachment-transport.test.js tests/relay-attachment-http-cancellation-browser.test.js`
   -24 passed,0 failed/cancelled/skipped;19334.537899ms.
   -[Complete unmodified Node24 reporter output](node24-focused.txt), SHA256 `400040f62966721092f185f116c8ef43cd2a068d386fe489a91172b38aff3efb`.

The raw reports include test labels and synthetic fixture counters only. Invalid URL labels and example strings are deliberate synthetic inputs from published tests; no live credentials, private owner records or environment-variable values are included. Previous evidence artifacts remain unchanged.

## What was exercised

Actual MCP/Worker/SQLite stage and commit of synthetic images/documents, first file-only reply, accepted text then later image/PDF delivery, exact private byte downloads,11 later deliveries across pagination, Close/public navigation, refresh-conflict cache preservation, and cancellation/revocation cleanup. The corrected backend identity-collision regressions and runtime tests are included in the Node22 glob. The seven actual HTTP cancellation cases also passed explicitly on Node24.

The uncertain-commit assistant case throws synthetically after a successful real MCP commit and then retries identically; it does not sever that HTTP response. The held-preview case combines server revocation with explicit test-side local credential removal. The separate server-only revocation case does not alter browser storage: a subsequent real file request returns401 and the application clears credentials, file rows and existing preview Blob URLs. This qualifies cleanup on the next authenticated request, not push revocation or immediate offline cleanup.

Physical Android/TalkBack, production TLS/CORS and live ChatGPT host-to-production byte delivery remain unrun. Parent owns independent review, final merged source/deployment gates and promotion. This evidence-only branch performs no release/deployment and leaves the frontend head unchanged.
