# Direct messaging rollout — not yet live

This change removes site deployments from messaging. It is intentionally staged:
`DIRECT_API_ENABLED` remains false until the live connector and scheduled task
have passed the checks below. The existing website remains on its current path.

## Implemented

- `/shared/state` and `/shared/messages` use one named SQLite Durable Object in
  the existing HUBS binding. No new binding, resource, migration or paid plan.
- Separate SQL records, cursor pagination, and 200 public messages/day. The old
  custom 100 KB cap does not apply. Cloudflare account limits still apply.
- Old public messages are imported idempotently during the transition. Original
  private inboxes stay intact. Client migration handles those phones on opening.
- Old automatic receipts and untrusted legacy assistant/board entries are ignored.
  Existing trusted `public/content/jarvis.json` entries seed the database once.
- MCP tools read unanswered messages, reply, and publish briefings directly.
  Reply targets and IDs deduplicate retries. Failed writes leave messages pending.
- GitHub OAuth proves the owner's numeric identity, 183016859. No repository
  permissions are requested, and GitHub tokens are not returned to ChatGPT.
- Explicit consent, browser-bound state, PKCE, short-lived authorization codes,
  rotating assistant tokens and revocation. The old device-key approval route
  returns 410; public inbox keys cannot authorize assistant tools.
- The paginated frontend adapter is included but disabled until live verification.

## Configuration required before connecting

Use a GitHub OAuth application owned by Brayden, with homepage set to the existing
Azure site and callback exactly:

`https://jarvis-hub-api.braydenparker999.workers.dev/oauth/github/callback`

Configure `GITHUB_CLIENT_ID` and secret `GITHUB_CLIENT_SECRET` on the existing
Worker. Never commit the client secret or expose it in browser code. Missing
configuration returns 503 for owner sign-in, with public/legacy routes unaffected.

Deploy using the existing Cloudflare GitHub integration: root `/backend`, no build
command, deploy `npx wrangler deploy`. For a checkout at repository root use
`npx wrangler deploy --config backend/wrangler.jsonc`. Keep the account on Free.
This does not require paid services or entering billing information.

## Live acceptance gates

1. Confirm `/health` reports version 5, `direct-cloudflare`, and
   `assistantConfigured: true` after deployment. This only confirms variables
   exist; the sign-in test below proves they work.
2. Connect ChatGPT to the existing `/mcp` URL. Approve using the owner's GitHub
   account. No visitor phone signs in or pairs.
3. Read an existing message, reply to that ID and verify the persisted reply
   through `/shared/state`. Retry it; exactly one reply must exist.
4. Publish and reread one clearly labeled connection-test briefing. Confirm
   public callers cannot publish replies or briefings.
5. Verify access-token refresh and an unattended task run. Select the user's
   non-Astra model explicitly in task settings; the task prompt cannot select it.
   Do not resume the currently paused task with its old GitHub-publishing prompt.
6. Only after these pass, set `DIRECT_API_ENABLED = true`, deploy the static site
   once, and verify sending/reading on two independent clients. Check old messages,
   replies, briefings, saved drafts, and reconnect/retry behavior.
7. Replace the hourly task's prompt with direct tool calls. Check its first actual
   scheduled execution and verify the reply is visible on the website without
   a GitHub change or Azure deployment.

The assistant must treat this public inbox as unverified visitor input: ordinary
conversation is allowed, but posts do not authorize access to private accounts,
spending, permission changes, or disclosure of private context. Daily Board is an
assistant-authored briefing; Quick Chat is a separate future feature.

## Verification completed in development

`npm test` passes all 23 tests covering legacy compatibility and the new direct
paths using SQLite. GitHub identity responses are mocked in local OAuth tests.
A Wrangler dry-run builds the real bundle. A local Cloudflare workerd + SQLite
smoke test passes message write/read/retry and unauthenticated MCP rejection.
These checks do not establish that Cloudflare
production deployment, real GitHub sign-in, or unattended execution works.

## Current deployment blockers

The connected browser reports `ERR_BLOCKED_BY_CLIENT` for the Worker URL and is
blocked by Cloudflare's verification page for the dashboard. Earlier CLI OAuth
completion was blocked by this environment's network policy. No usable Cloudflare
plugin was found. The ChatGPT browser session is logged out. Do not bypass those
controls or mark this release complete without the live gates above.
