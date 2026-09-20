# Jarvis 1.0

The direct Cloudflare messaging replacement is staged in this branch. See
[DIRECT-MESSAGING.md](DIRECT-MESSAGING.md) for implementation, verification and
the live acceptance gates. `DIRECT_API_ENABLED` is false; the description below
continues to describe the current production frontend until cutover.

Mobile-first personal hub: Home, Jarvis messages, and assistant-published Daily Board.

- Website: https://gray-meadow-09216fd10.1.azurestaticapps.net/
- Backend: https://jarvis-hub-api.braydenparker999.workers.dev
- GitHub: braydenparker999/jarvis, main.

## One shared inbox

Every phone opens the same website. No account, password, device linking, or plugin setup. The owner explicitly chose public access: anyone who discovers the website can read messages and post regular messages. Only changes to this GitHub repository can publish trusted Jarvis replies and briefings.

The frontend adapter uses the already deployed `/v1/state` and `/v1/messages` endpoints with one deliberately public inbox identifier. No Cloudflare redeployment is needed. Only user messages from that Worker are displayed; all Worker assistant and board rows are ignored. Trusted replies and briefings come exclusively from the GitHub-deployed `/content/jarvis.json` on Azure. Drafts and retry queues remain in browser storage when offline. Original private inboxes remain intact; opening the updated website on an original phone copies its user messages into the shared inbox once. Old delivery receipts and personal board drafts are not published into the shared space.

## Assistant publishing

1. Open `/reader/` on the Azure website. Its visible JSON contains messages, posts, unanswered messages, and publisher health.
2. Read `public/content/jarvis.json` from GitHub main with its current file SHA.
3. Append a reply `{id, replyTo, body, createdAt}` or briefing `{id, title, body, createdAt}`. IDs must be UUIDs; timestamps ISO 8601. Reply target must be an existing user message. Preserve existing entries and skip already answered targets.
4. Update that file using the GitHub connector and current SHA. On conflict, reread and merge. The existing Azure workflow publishes the updated file, normally within a minute or two.
5. Refresh `/reader/`. Wait for the Azure deployment to succeed. Website polling is every 30 seconds while visible.

Public visitors cannot alter the GitHub-deployed publication file. The backend retains messages if Azure publishing is delayed. The existing Worker record has a 100 KB cap; reaching it returns an explicit error and preserves the unsent draft. Export/archival is future work.

Recurring assistant execution is separate from website hosting. Never claim an hourly check or daily briefing is scheduled without verifying the automation. Quick Chat and additional modules are not implemented yet.

## Deployment and costs

Azure Static Web Apps **Free**, app `jarvis`, resource group `jarvis_group`. Only `public/` deploys to Azure, with no build step, API deployment, or media storage. Keep large media and datasets outside Azure.

Cloudflare uses the existing `jarvis-hub-api` Worker and existing SQLite Durable Object binding. Build settings: root `/backend`, no build command, deploy `npx wrangler deploy`. Alternatively root `/` with deploy `npx wrangler deploy --config backend/wrangler.jsonc`.

Do not create or upgrade paid resources, enable paid plans, or enter billing information without explicit owner approval. No new infrastructure is required by this version.

## Development

Native JavaScript modules and system fonts; no frontend dependencies. Future modules can be separate directories under `public/`. Keep provider secrets out of the frontend.

`npm test` checks persistence, public role restrictions, trusted publication filtering, retry deduplication, migration, preserved drafts, and compatibility of legacy data routes. Cloud deployments also require a live round-trip test.

Legacy private API code remains only for compatibility and recovery. The active website no longer depends on device credentials or the old OAuth connector.
