# Relay and Muse conversation redesign

All screenshots in this document contain fictional fixture text. They contain no production messages, account credentials or private history. The `real-` captures use the actual Worker routes and SQLite implementation with synthetic owner approval, original Azure browser Origin/CORS and offline CDP routing. No live identity provider, callback or publication is contacted.

## Conversation structure

Relay and Muse share a restrained charcoal/amber conversation treatment in `public/assets/conversation.css`. The CSS is scoped to these two modules. The launcher, Quick AI, DrawerCast and media player keep their existing styles and behavior. Relay loads the scoped stylesheet when entered through the application shell as well as through its direct URL.

The toolbar names the conversation and always states its scope. Public Relay and Muse say **Public · shared conversation**; owner Relay says **Private owner** with the verified, sign-in-required, expired or revoked device state. The conversation uses the available viewport height, with a bottom composer whose Send control sits beside the text. System fonts, 48px controls, quiet timestamps and matte surfaces follow the approved style guide.

The conversation sheet contains scope selection, search, bookmarks or private request filtering, latest messages, refresh and connection details. Account sign-in, devices and disconnection live in its owner-access section. Muse is an ordinary link to its separate public module. Sheets scroll on shorter phones and keep the heading and Close control available while reading. They support native dialog dismissal and preserve the underlying reading position.

The former second owner heading/account row is removed from the visible chat. The accessible Owner chat heading remains. Each private request keeps its request text in the conversation, with one compact status and **Inspect request** action. The inspector shows the exact saved request, current lifecycle evidence, separately labeled delivery, attempts, request history and a saved result. Results use the existing DOM-based text formatter for paragraphs, lists, code and safe HTTP(S) links; request text stays inert. No server HTML, iframe or executable artifact is rendered.

## Privacy, drafts and navigation

Public Relay and Muse retain their existing independent local drafts, histories, outboxes, bookmarks and reading-position keys. The complete public history is read before retrying queued messages, so an accepted UUID whose receipt was lost is confirmed before another POST. Muse keeps its exact channel prefix and reply-target routing.

Private messages, request titles and bodies, drafts, request details, retry payloads and reading anchors stay in the owner controller/UI memory. They never enter the public adapters, transfers, sync or browser storage. In-page public/private switches preserve the private draft and reading anchor. Application-shell navigation preserves this page-lifetime state. A discarded or reloaded document does not recover a private draft from storage. Each page revalidates remembered owner access with the service.

Remembered owner access still requires the existing explicit checkbox and stores only the device bearer and device ID. The additional `jarvis.relay.owner-mode.v1` value contains only `owner` or `public`; it carries no credential or private content. It preserves the selected private scope after session expiry and reload. Public chat appears only after an explicit public choice. Confirmed expiry/revocation and cross-tab session removal invalidate concurrent operations and clear private history, drafts and inspectors. An ordinary network failure retains the draft and last known private evidence.

## Honest request behavior

An ordinary private message is still the existing authenticated owner request, and its immutable authenticated owner reply remains sufficient to save the job result. Explicit **Work request** mode adds a title and requested scope. Its default is **Needs review**; **Read-only report** and **Draft only** are explicit alternatives. Scope describes requested work and never grants permission for external actions.

The UI loads request features only when the approved owner service advertises `jobs_enabled: true`. An older service keeps private messaging available and omits request creation/filtering. Connection details explain the missing capability. There is no private-to-public fallback.

Job creation sequence is immutable while progress changes. Every owner refresh therefore consumes all bounded job pages from zero; an open inspector also reads its exact detail. A callback receipt says delivery was accepted, never that work started. **Working** requires authenticated execution acknowledgement. **Needs your input** reflects the waiting stage and directs the owner to the actual question or blocker; it does not invent an approval/resume protocol. **Result saved** describes the saved reply without asserting that every external action succeeded.

**Request cancellation** remains a request until authenticated acknowledgement. **Try again** appears only when the server permits a separate linked attempt. A duplicate-risk acknowledgement is required when specified by the service and grants no action permission. Unsafe consequential/unclassified outcomes do not offer retry. Callback-delivery retry is labeled separately.

An interrupted send keeps its original UUID and complete payload. Editing a title, requested scope or body cannot silently allocate a replacement while that send is unconfirmed. **Retry private send** confirms the original payload; any edited draft remains available afterward for an explicit later send.

Muse remains public and bounded by its existing channel and publication protocol. The page consumes every pagination cursor and deduplicates messages through the existing direct API. It reports saved messages, delayed replies and failed/uncertain sync separately. It cannot verify an assistant schedule or current execution. Existing responder schedules, hooks and polling cadence are unchanged.

## Review and evidence

The visual matrix includes 360×800, 390×844, 412×915, 390×520 and 1280×900. The tested states include a populated public/private/Muse conversation, request creation, queued request, saved rich result, long scrolling sheet, empty inbox, loading, failed sync, expired session, interrupted send and retry. Browser QA additionally exercises separate drafts and Back, privacy switches, late responses after expiry, exact UUID retries, inert attacker text, job progress after the message cursor advances, cancellation, guarded linked retries, touch targets, composer/keyboard geometry and reading anchors.

Refinements from rendered review and adversarial QA:

- Removed the duplicate owner toolbar row and fixed the private author appearing after the message body.
- Reduced composer chrome and moved Send beside the message text.
- Added persistent public/private scope, explicit mode selection and an owner-selected reload state after expiry.
- Moved account and connection controls to one secondary sheet; made long sheets fully opaque and scrollable with a persistent Close control.
- Replaced technical callback status in the conversation with one quiet line; retained precise delivery evidence in the inspector.
- Preserved private reading anchors across scope switches and inspector text anchors when a changed status wraps above long content.
- Kept request-history disclosure state, focus and scroll during polling; raised disclosure and code-copy targets to 48px.
- Retook sheet captures after animation completion. Intermediate fade frames are excluded from the representative evidence.

Representative synthetic screenshots:

| View | Evidence |
| --- | --- |
| Original owner layout, 360×800 | [Before](conversation-evidence/before-owner-360x800.png) |
| Private conversation, 360×800 | [After](conversation-evidence/real-owner-360x800.png) |
| Private conversation, desktop | [1280×900](conversation-evidence/real-owner-1280x900.png) |
| Coherent conversation sheet | [360×800](conversation-evidence/real-owner-menu-360x800.png) |
| Queued private request | [390×844](conversation-evidence/real-owner-queued-390x844.png) |
| Saved result with safe link | [360×800](conversation-evidence/real-owner-result-360x800.png) |
| Request composer at short height | [390×520](conversation-evidence/real-owner-request-390x520.png) |
| Public Muse conversation | [360×800](conversation-evidence/after-muse-360x800.png) |
| Public Muse empty state | [390×844](conversation-evidence/real-muse-empty-390x844.png) |
| Public sync error | [390×844](conversation-evidence/real-public-error-390x844.png) |
| Private loading state | [390×844](conversation-evidence/real-owner-loading-390x844.png) |
| Private session expiry | [390×844](conversation-evidence/real-owner-expired-390x844.png) |

The real render [manifest](conversation-evidence/real-render-manifest.json) records runtime, browser, viewport, overflow and fully opaque sheet geometry. [capture.mjs](conversation-evidence/capture.mjs) reproduces the real Worker/SQLite screenshots with the pinned toolchain:

```sh
PATH=/tmp/jarvis-tools/node-v22.23.3-linux-x64/bin:$PATH \
JARVIS_CHROME=/tmp/jarvis-tools/jarvis-qualification-browser/installed/chrome-linux64/chrome \
REQUIRE_RELAY_OWNER_BROWSER=1 \
node docs/conversation-evidence/capture.mjs
```

The focused owner UI, delivery, Muse and request-client regression run passed 48/48 with no skips on Node 22.23.3 and Chrome 154.0.8037.97. The independent browser suite owns the adversarial release checks. Fixture execution and screenshots demonstrate the interface and real request/reply implementation; they do not establish a live assistant schedule, tool availability or production deployment.
