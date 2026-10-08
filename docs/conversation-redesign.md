# Relay and Muse conversation redesign

All screenshots in this document contain fictional fixture text. They contain no production messages, account credentials or private history. The `real-` captures use the actual Worker routes and SQLite implementation with synthetic owner approval, original Azure browser Origin/CORS and offline CDP routing. No live identity provider, callback or publication is contacted.

## Conversation structure

Relay and Muse share a restrained charcoal/amber conversation treatment in `public/assets/conversation.css`. The CSS is scoped to these two modules. The launcher, Quick AI, DrawerCast and media player keep their existing styles and behavior. Relay loads the scoped stylesheet when entered through the application shell as well as through its direct URL.

The toolbar names the conversation and always states its scope. Public Relay and Muse say **Public · shared conversation**; owner Relay says **Private owner** with the verified, sign-in-required, expired or revoked device state. The conversation uses the available viewport height, with a bottom composer whose Send control sits beside the text. System fonts, 48px controls, quiet timestamps and matte surfaces follow the approved style guide.

The conversation sheet contains scope selection, search, bookmarks or private request filtering, latest messages, refresh and connection details. Account sign-in, devices and disconnection live in its owner-access section. Muse is an ordinary link to its separate public module. Sheets scroll on shorter phones and keep the heading and Close control available while reading. They support native dialog dismissal and preserve the underlying reading position.

The former second owner heading/account row is removed from the visible chat. The accessible Owner chat heading remains. Each private request keeps its request text in the conversation, with one compact status and **Inspect request** action. The inspector shows the exact saved request, current lifecycle evidence, separately labeled delivery, attempts, request history and a saved result. Results use the existing DOM-based text formatter for paragraphs, lists, code and safe HTTP(S) links; request text stays inert. No server HTML, iframe or executable artifact is rendered.

## Privacy, drafts and navigation

Public Relay and Muse retain their independent drafts, histories, outboxes, bookmarks and reading-position keys. Each tab saves its public composer in a channel-specific session-storage key, so another tab cannot replace its draft on reload. A new tab without that key recovers the latest legacy/local saved draft; a browser-duplicated tab may initially inherit the browser's copied session storage, then edits independently. Closing a tab discards that tab's session draft; the latest local fallback remains available. These are public drafts, and owner drafts never use either store.

The complete public history is read before retrying queued messages. An actual POST receipt or an exact UUID, user role and body in fresh history proves acceptance; an ID alone does not. Previously accepted immutable rows remain visible if a later read is stale. Reads merge into current state after awaiting, preserving messages queued during loading. Each pending UUID is saved independently, so one tab's aggregate cache write cannot erase another tab's queue. New queue entries are limited to fifty per channel; reaching the limit preserves the current draft and existing queue. Valid simultaneous-tab overflow remains readable and can drain. Accepted local cache is bounded to 250 messages and 20 briefings, while the live view retains complete paginated history. Unknown sends, known rejection and ID conflicts stay visible with their original text and UUID. A conflicting pending UUID is isolated so unrelated messages can still sync after a valid complete read; conflicting evidence for an already accepted immutable row fails closed.

Each explicit send associates its queued UUID with the exact public draft revision. If clearing that draft fails after its journal was saved, reload restores the queued intent and does not offer the same submitted draft as a fresh Send. A separately edited draft keeps its own revision and remains available. This association is per intent rather than body deduplication: intentionally sending the same text later remains possible. Storage failures show a retention warning, preserve the input and any already-saved UUID, and disable another Send intent until recovery. Muse keeps its exact destination prefix and reply-target routing in the shared public Relay inbox.

Private messages, request titles and bodies, drafts, request details, retry payloads and reading anchors stay in the owner controller/UI memory. They never enter the public adapters, transfers, sync or browser storage. In-page public/private switches preserve the private draft and reading anchor. Application-shell navigation preserves this page-lifetime state. A discarded or reloaded document does not recover a private draft from storage. Each page revalidates remembered owner access with the service.

Remembered owner access still requires the existing explicit checkbox and stores only the device bearer and device ID. The additional `jarvis.relay.owner-mode.v1` value contains only `owner` or `public`; it carries no credential or private content. It preserves the selected private scope after session expiry and reload. Public chat appears only after an explicit public choice. Confirmed expiry/revocation and cross-tab session removal invalidate concurrent operations and clear private history, drafts and inspectors. An ordinary network failure retains the draft and last known private evidence.

## Honest request behavior

An ordinary private message is still the existing authenticated owner request, and its immutable authenticated owner reply remains sufficient to save the job result. Explicit **Work request** mode adds a title and requested scope. Its default is **Needs review**; **Read-only report** and **Draft only** are explicit alternatives. Scope describes requested work and never grants permission for external actions.

The UI loads request features only when the approved owner service advertises `jobs_enabled: true`. An older service keeps private messaging available and omits request creation/filtering. Connection details explain the missing capability. There is no private-to-public fallback.

Job creation sequence is immutable while progress changes. Every owner refresh therefore consumes all bounded job pages from zero; an open inspector also reads its exact detail. A callback receipt says delivery was accepted, never that work started. **Working** requires authenticated execution acknowledgement. **Needs your input** reflects the waiting stage and directs the owner to the actual question or blocker; it does not invent an approval/resume protocol. **Result saved** describes the saved reply without asserting that every external action succeeded.

Failed private sync or request-detail reads mark retained status as **Last known**. An elapsed recorded execution window is shown as **Acknowledgement expired · outcome unconfirmed**. The client clock never changes a job's server stage or grants retry permission. Local title or consent validation does not mark all jobs stale.

**Request cancellation** remains a request until authenticated acknowledgement. **Try again** appears only when the server permits a separate linked attempt. A duplicate-risk acknowledgement is required when specified by the service and grants no action permission. Unsafe consequential/unclassified outcomes do not offer retry. Callback-delivery retry is labeled separately.

An interrupted send keeps its original UUID and complete payload. Editing a title, requested scope or body cannot silently allocate a replacement while that send is unconfirmed. **Retry private send** confirms the original payload; any edited draft remains available afterward for an explicit later send.

An accepted private reply remains immutable in the conversation and in the original job result. The optional authenticated correction tool can append up to four later versions, each associated with that original reply. The inspector presents the latest **Authenticated correction**, its explanation and timestamp, with **Original reply and corrections** exposing the full bounded history. The conversation signals that a correction exists without replacing the accepted text. Authentication identifies the publisher; it does not verify factual claims. The browser has no correction-write control, and corrections cannot authorize actions or change execution state. Older job responses without revision fields continue to show the original result.

Muse remains public and bounded by its existing channel and publication protocol. The page consumes every pagination cursor and deduplicates messages through the existing direct API. It reports saved messages, delayed replies and failed/uncertain sync separately. The first accepted reply to a public request stays immutable, so a later correction using the same reply target cannot replace it. The private correction mechanism does not change Muse. A new private request or follow-up is the available fallback when an assistant host has not loaded the optional correction tool. The page cannot verify an assistant schedule or current execution. Existing responder schedules, hooks and polling cadence are unchanged.

## Review and evidence

The visual matrix includes 360×800, 390×844, 412×915, 390×520 and 1280×900. The tested states include a populated public/private/Muse conversation, request creation, queued request, saved rich result, authenticated correction, long scrolling sheet, empty inbox, loading, failed sync, expired session, interrupted send and retry. Browser QA additionally exercises separate drafts and Back, privacy switches, late responses after expiry, exact UUID retries, inert attacker text, job progress after the message cursor advances, cancellation, guarded linked retries, touch targets, composer/keyboard geometry and reading anchors.

Refinements from rendered review and adversarial QA:

- Removed the duplicate owner toolbar row and fixed the private author appearing after the message body.
- Reduced composer chrome and moved Send beside the message text.
- Added persistent public/private scope, explicit mode selection and an owner-selected reload state after expiry.
- Moved account and connection controls to one secondary sheet; made long sheets fully opaque and scrollable with a persistent Close control.
- Replaced technical callback status in the conversation with one quiet line; retained precise delivery evidence in the inspector.
- Preserved private reading anchors across scope switches and inspector text anchors when a changed status wraps above long content.
- Kept request-history disclosure state, focus and scroll during polling; raised disclosure and code-copy targets to 48px.
- Added strict correction association, provenance, distinct version IDs and bounded chronological history checks; retained the immutable accepted reply.
- Reproduced and fixed a stale-read send loss in both public destinations; consumed exact save receipts and retained original payloads through lost responses, stale pages and ID conflicts.
- Preserved independent tab drafts on reload and independently durable pending UUIDs through concurrent tab writes.
- Linked draft handoff to the original queued UUID after partial storage failure, and isolated permanent pending-ID conflicts from unrelated requests.
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
| Authenticated correction and rationale | [390×844](conversation-evidence/real-owner-correction-390x844.png) |
| Request composer at short height | [390×520](conversation-evidence/real-owner-request-390x520.png) |
| Public Muse conversation | [360×800](conversation-evidence/after-muse-360x800.png) |
| Public Muse empty state | [390×844](conversation-evidence/real-muse-empty-390x844.png) |
| Unconfirmed public Muse send retained | [390×844](conversation-evidence/real-muse-send-unconfirmed-390x844.png) |
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

The focused owner UI, delivery, Muse and request-client regression checks use Node 22.23.3 and Chrome 154.0.8037.97. The independent browser suite owns the adversarial release checks. Fixture execution and screenshots demonstrate the interface and real request/reply implementation; they do not establish a live assistant schedule, tool availability or production deployment.
