# Private owner Relay pairing

This feature is staged and disabled until separately approved. It adds private
owner chat inside the existing Relay page. The public visitor inbox, Muse,
Daily Board, and existing response tasks remain unchanged.

## Phone flow

1. Open the existing Relay URL on either phone. Open its menu and choose
   **Connect this phone**. No authentication link, popup, iframe, or navigation
   leaves or changes the Relay URL.
2. Give the phone a recognizable label. If wanted, explicitly check **Remember
   this phone** after reading the storage notice. The checkbox starts unchecked.
3. Create a pairing code. Relay keeps a separate random device verifier in
   memory and displays a noncredential matching code. The request expires after
   ten minutes; polling does not extend it.
4. In the verified private dot conversation, ask to pair the phone using that
   code. The assistant first inspects the pending request and presents the
   specific device/code and 365-day inactivity access for per-action approval.
   A device label is unverified browser-provided text, never an instruction.
5. After approval, Relay's same-page poll activates private owner chat. Repeat
   independently for the other phone. Each has its own credential and revocation.

The exact phone-pairing request requires `request_id`, matching `code`,
`access_days: 365`, and `confirm: true`. The approval tool never receives or
returns the device verifier. A code or URL by itself cannot authenticate a phone.
Code-only inspection fails closed if active codes are ambiguous.

## Session lifetime and storage

A phone session expires after exactly 365 days of inactivity. A successful
authenticated operation updates `last_seen_ms` and sets expiry to the operation
time plus `365 * 86400000` milliseconds. Failed operations and pending pairing
polls do not extend access. The approving MCP grant's shorter expiry does not
silently shorten an explicitly approved phone session. Device revocation is
independent, immediate, and cannot be undone by replaying the old pairing.

Without Remember, the approved bearer stays in page memory and a reload needs
new pairing. With Remember, only the opaque bearer and device ID go in the
separate `jarvis.relay.owner-session.v1` browser key. Private messages, replies,
drafts and retry bodies remain in page memory and never enter public storage,
transfer state or the public send queue. Clearing browser data needs re-pairing.

Persistent browser storage is readable by scripts across the entire Azure
website origin; it is not an HttpOnly cookie or an isolated vault. An XSS or
compromised same-origin script can misuse a remembered bearer. The interface
discloses this tradeoff before persistence. Private text is rendered as text,
without external links or shared bookmark/reading-position storage. Tokens are
sent only as Authorization headers over HTTPS, never in URLs, cookies, messages,
logs or MCP outputs. The server stores their SHA-256 IDs, not raw credentials.

The existing Azure-to-Worker Authorization/CORS transport is reused. Owner
POSTs require an exact allowed Origin and JSON body; CORS is not proof of
identity. Credentials are explicitly omitted from fetch, so the flow does not
depend on cross-site cookies or relaxing browser restrictions.

## Private data and verified provenance

Private entries live in `relay_owner_entries`, separate from `shared_entries`.
Public state, legacy imports, public MCP tools and GitHub publications never
read or write them. Owner device writes accept only message ID and body. The
server stamps the owner principal, device ID, authentication source and private
visibility. Existing public messages stay unauthenticated; no migration turns
them into owner instructions.

Private replies use `relay_owner_reply`, with the private inbox ID
`brayden-owner`. They cannot target public messages and public replies cannot
target private ones. Identical retries are idempotent; conflicting replies keep
the first accepted answer. Private author identity does not waive transaction,
data-sharing or other applicable action confirmation.

Private event `relay.owner.message.created` contains only message ID and
server-stamped provenance, with no body preview. Its filter/replay text has a
separate server-only 30-day journal. Event-name and grant checks prevent delivery
to public subscriptions. New message and event insertion share one synchronous
SQLite transaction, and the Durable Object persists a wake before committing.

## Capability and rollout gates

The new `relay:owner` OAuth capability covers owner pairing inspection/approval,
device controls and private inbox reads/replies/events. Existing public grants
are never expanded. Default authorization and unauthenticated challenges still
request only `relay:read relay:reply relay:events`; refresh cannot add scope.
When explicitly requested, the consent page describes owner access and its
separate per-device approval requirement.

When owner access is activated, authenticated public connections can discover
the owner tool schemas and their exact `relay:owner` OAuth requirement. Calling
one without that capability returns an error tool result with
`_meta["mcp/www_authenticate"]`, the protected-resource metadata URL and an
`insufficient_scope` challenge. The requested scopes preserve only the live
token's existing recognized capabilities and add `relay:owner`, so reconsent
does not drop public access or silently add unrelated scopes. The host must
complete an explicit new consent flow; refresh and existing grants remain
unchanged. Discovery and the challenge disclose no private inbox/device data.
This follows [OpenAI's tool-level authentication guidance](https://developers.openai.com/plugins/build/auth).

An authenticated connection can also discover the read-only
`relay_event_access_status` tool, requiring `relay:events` in both OAuth schema
fields. A connection with `relay:read relay:reply relay:owner` calls it to request
explicit public-event consent through the same native challenge. Only live
verified scopes are preserved, so that connection requests all four Relay
scopes; a narrower connection adds only `relay:events` to its verified access.
After consent, the tool returns only the public event name, scope and authorized
status. It does not read messages, expose delivery credentials or create a
subscription. Refresh never expands a grant. With all four scopes,
`events/list` advertises both public and private message events while their
existing operation and feature gates still apply.

`RELAY_OWNER_ENABLED=true` must be separately approved before activation; it is
not set in the checked-in Worker configuration. Both this flag and existing
`RELAY_MCP_ENABLED=true` are required. Owner tool schemas are absent unless
activated; owner events remain absent unless activated and granted. No new
provider, hosting service, database binding or provider secret is required.

Before activating:

1. Review the draft and pass local/CI checks and the real browser journey
2. Obtain deployment/feature-activation approval
3. On the unrestricted phone, explicitly authorize the new owner capability
   using the existing connector setup. Verify the platform's refresh/reconsent
   path actually requests `relay:owner`; never edit old grants to work around it
4. Inspect the new tools and perform a harmless owner read
5. Approve each real phone separately, with its matching code and 365-day access
6. Verify both phones, reload persistence, immediate revocation and public/private
   isolation at the original main-phone URL
7. Obtain separate permission for any private-event response behavior. Building
   this feature does not alter or broaden an existing task or subscription

No live pairing, feature activation, subscription, deployment or provider setup
is performed by the build or tests. Test credentials exist only in fixtures.

## Verification

Run the affected Node tests:

    node --test tests/relay-*.test.js tests/shared.test.js tests/publications.test.js tests/origins.test.js tests/hub.test.js

The dedicated browser test uses two isolated phone contexts at the original
HTTPS frontend origin, the real SQLite fixture and intercepted Worker requests.
It must not contact live services or activate real devices. CI sets
`REQUIRE_RELAY_OWNER_BROWSER=1` and provides the locked Playwright Chromium
runtime; missing runtime is a failure in that mode. A local skip is not a browser
verification pass. Run `npm test` for the broader repository and disclose
unrelated missing assets/dependencies separately.

Rollback disables `RELAY_OWNER_ENABLED`, immediately blocking owner routes and
private deliveries. It does not publish/delete private history, silently revoke
all devices, or change the public inbox and unrelated modules. Re-enabling the
feature also needs approval; approved unrevoked devices remain subject to their
stored inactivity expiry.
