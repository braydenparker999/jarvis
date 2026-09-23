# Jarvis 1.0

Mobile-first personal hub: Jarvis messages and an assistant-published Daily Board.

- Website: https://missionarytube.z13.web.core.windows.net/
- Inbox reader: https://missionarytube.z13.web.core.windows.net/reader/
- Backend: https://jarvis-hub-api.braydenparker999.workers.dev
- Publications: https://github.com/braydenparker999/jarvis/issues/2

## Delivery

Every phone opens the same public conversation. No password, device pairing, or plugin setup. The owner explicitly accepts public reading and ordinary message posting. Anyone finding the URL can do both.

The Azure Storage static website serves the lightweight application shell. Cloudflare stores messages, replies, and briefings in the existing SQLite Durable Object binding. The assistant publishes structured comments through the connected GitHub account in issue #2. Cloudflare accepts only comments authored by owner ID 183016859, validates their schema, and imports them into SQLite. Ordinary visitors cannot publish assistant replies or briefings.

Replies and briefings are data: publishing a comment does not redeploy either website or Worker. The site polls every 30 seconds while visible. Cloudflare checks GitHub at most once per five minutes when the inbox is read, shared across all visitors. Imported entries remain available if GitHub is unavailable. The reply-delivery status is reported separately from message storage.

Ordinary reply bodies are limited to 6,000 characters. Daily Board briefing bodies may contain up to 20,000 characters; titles remain limited to 120 characters.

The importer is append-only. Do not edit or delete published comments to correct entries: these changes do not remove already imported data. Reply targets and dated briefings are deduplicated. Conflicting publications preserve the first accepted entry and appear in reader diagnostics. GitHub pagination resumes after outages or large backlogs.

## Safe rollout

`public/assets/config.js` contains `DIRECT_API_ENABLED`. While false, the main chat uses the existing legacy shared inbox and checked-in publication file. The reader tries the new API first and reports if the backend upgrade is unavailable. Enable the flag only after the live reader confirms version 6, the actual GitHub reply, and the Daily Board test. This prevents a delayed Cloudflare deployment from breaking the existing site.

The new Worker retains legacy APIs for recovery. Old user messages and trusted checked-in replies/briefings are copied into the shared SQLite store without deleting originals. Legacy assistant/board API rows cannot acquire trusted publication status. Offline drafts and retry queues stay on the phone; successful sends are identified by UUID for safe retries.

## Assistant handoff

See [JARVIS-HANDOFF.md](JARVIS-HANDOFF.md). Scheduling is configured in a separate chat after live delivery is verified. Do not claim an hourly task is active until an actual scheduled run succeeds. Quick Chat and other modules remain future work.

## Deployment and costs

GitHub main is the source. `public/` is published to the Azure Storage static website `missionarytube` by the existing pinned-release workflow in the Missionarytube repository, which configures public Quick AI metadata and injects the unrelated Drive key and backs up current blobs before upload. There is no frontend build or Azure API deployment. The former Static Web App (`gray-meadow-09216fd10`) is retired: its deploy workflow was removed and the Worker no longer accepts its origin. `public/staticwebapp.config.json` is ignored by Storage hosting, so its per-route security headers do not apply there. Keep large media and data outside Azure.

Cloudflare uses the existing `jarvis-hub-api` Worker and existing `HUBS` SQLite Durable Object binding. Build settings: root `/backend`, build command empty, deploy command `npx wrangler deploy`, production branch `main`. No new binding or paid resource is required.

No paid upgrade, billing entry, or paid service is authorized. Free-tier limits can interrupt service. Public messages have an application cap of 200 new messages per UTC day, but this does not replace provider limits or a verified Free plan.

## Development

Native JavaScript modules and system fonts; no frontend dependencies. Add future routes under `public/`. Never place provider secrets in browser code.

Run `npm test`. Tests exercise migration, preserved drafts, untrusted-role rejection, SQLite pagination, owner-only publication parsing, retries, outage recovery, backlog continuation, and duplicate prevention. Before deploying, run a Wrangler dry-run; before activating the new UI adapter, verify the live reply and briefing round trip.

## Quick Chat backend setup

Deploy the existing `backend/` Worker first through its Cloudflare GitHub pipeline (`main` branch, `npx wrangler deploy`). Confirm `GET /quick-ai/status` returns `version: 2`. In the Cloudflare dashboard for `jarvis-hub-api`, add **encrypted Worker secrets** `QUICK_AI_ACCESS_KEY` (a new 64-character lowercase hex value), `GEMINI_API_KEY`, `GROQ_API_KEY` (new, backend-only key), and `TAVILY_API_KEY`. Create an unlock credential locally with `openssl rand -hex 32`; enter it in the Quick Chat browser Unlock dialog. Do not put any provider key there. Verify that the Google project, Groq project, and Tavily account are on free-only plans with no billable overages. Then set Worker plain-text variables `QUICK_AI_GEMINI_FREE_CONFIRMED=true`, `QUICK_AI_GROQ_FREE_CONFIRMED=true`, and `QUICK_AI_TAVILY_FREE_CONFIRMED=true` **only for the respective confirmed accounts**. Without a key and its gate, that provider remains unavailable; `GET /quick-ai/status` is safe and does not consume model credits. Set limits can be adjusted in `backend/quick-chat.js` after testing.

The frontend keeps its existing `jarvis.quick-ai.v1` text chats and drafts. New image bytes are stored locally in IndexedDB; provider keys never reach the browser. The unlock credential is stored in browser localStorage for this device; clear its `jarvis.quick-ai.access.v1` entry to revoke this device, or rotate the Worker secret to revoke all devices. Search sends an editable textual query to Tavily only when explicitly enabled. Gemini free-tier data may be used for product improvement. This route is separate from Main Chat and Muse.

Rollback: disable the three `QUICK_AI_*_FREE_CONFIRMED` flags or remove the provider secrets to stop model calls without touching chats, Main Chat, or Muse. Roll back only to a Jarvis commit that uses the server proxy, never to the earlier static Groq key release. Rotate the formerly exposed Groq key after confirming other consumers; do not revoke an unknown shared key blindly.
