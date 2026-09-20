# Jarvis 1.0

Mobile-first personal hub: Jarvis messages and an assistant-published Daily Board.

- Website: https://gray-meadow-09216fd10.1.azurestaticapps.net/
- Inbox reader: https://gray-meadow-09216fd10.1.azurestaticapps.net/reader/
- Backend: https://jarvis-hub-api.braydenparker999.workers.dev
- Publications: https://github.com/braydenparker999/jarvis/issues/2

## Delivery

Every phone opens the same public conversation. No password, device pairing, or plugin setup. The owner explicitly accepts public reading and ordinary message posting. Anyone finding the URL can do both.

Azure serves the lightweight application shell. Cloudflare stores messages, replies, and briefings in the existing SQLite Durable Object binding. The assistant publishes structured comments through the connected GitHub account in issue #2. Cloudflare accepts only comments authored by owner ID 183016859, validates their schema, and imports them into SQLite. Ordinary visitors cannot publish assistant replies or briefings.

Replies and briefings are data: publishing a comment does not redeploy either website or Worker. The site polls every 30 seconds while visible. Cloudflare checks GitHub at most once per five minutes when the inbox is read, shared across all visitors. Imported entries remain available if GitHub is unavailable. The reply-delivery status is reported separately from message storage.

The importer is append-only. Do not edit or delete published comments to correct entries: these changes do not remove already imported data. Reply targets and dated briefings are deduplicated. Conflicting publications preserve the first accepted entry and appear in reader diagnostics. GitHub pagination resumes after outages or large backlogs.

## Safe rollout

`public/assets/config.js` contains `DIRECT_API_ENABLED`. While false, the main chat uses the existing legacy shared inbox and checked-in publication file. The reader tries the new API first and reports if the backend upgrade is unavailable. Enable the flag only after the live reader confirms version 6, the actual GitHub reply, and the Daily Board test. This prevents a delayed Cloudflare deployment from breaking the existing site.

The new Worker retains legacy APIs for recovery. Old user messages and trusted checked-in replies/briefings are copied into the shared SQLite store without deleting originals. Legacy assistant/board API rows cannot acquire trusted publication status. Offline drafts and retry queues stay on the phone; successful sends are identified by UUID for safe retries.

## Assistant handoff

See [JARVIS-HANDOFF.md](JARVIS-HANDOFF.md). Scheduling is configured in a separate chat after live delivery is verified. Do not claim an hourly task is active until an actual scheduled run succeeds. Quick Chat and other modules remain future work.

## Deployment and costs

GitHub main is the source. Azure Static Web Apps **Free**, app `jarvis`, resource group `jarvis_group`, deploys `public/` using the existing workflow, with no frontend build or Azure API deployment. Keep large media and data outside Azure.

Cloudflare uses the existing `jarvis-hub-api` Worker and existing `HUBS` SQLite Durable Object binding. Build settings: root `/backend`, build command empty, deploy command `npx wrangler deploy`, production branch `main`. No new binding or paid resource is required.

No paid upgrade, billing entry, or paid service is authorized. Free-tier limits can interrupt service. Public messages have an application cap of 200 new messages per UTC day, but this does not replace provider limits or a verified Free plan.

## Development

Native JavaScript modules and system fonts; no frontend dependencies. Add future routes under `public/`. Never place provider secrets in browser code.

Run `npm test`. Tests exercise migration, preserved drafts, untrusted-role rejection, SQLite pagination, owner-only publication parsing, retries, outage recovery, backlog continuation, and duplicate prevention. Before deploying, run a Wrangler dry-run; before activating the new UI adapter, verify the live reply and briefing round trip.
