# Jarvis

A minimal, mobile-first domain connectivity test. No JavaScript, packages, remote fonts, media, analytics, APIs, or build step. Only `public/` is deployed (2,656 bytes).

## Deployment

- Live site: https://gray-meadow-09216fd10.1.azurestaticapps.net/
- Source: https://github.com/braydenparker999/jarvis, branch `main`.
- Hosting: Azure Static Web Apps **Free**, app `jarvis`, resource group `jarvis_group`.
- Azure's GitHub integration created the deployment workflow and repository secret. The workflow now deploys the static files directly, without build, API, or preview jobs. The original bootstrap workflow was removed to avoid duplicate deployments.
- Custom preset; app location `public`; empty API and output locations.
- Push changes to `main` to deploy. Check GitHub Actions for the deployment result and Azure Overview for the generated HTTPS `*.azurestaticapps.net` URL.
- Open the URL on the restricted Android device and confirm the three requested lines appear. Receiving this page tests static delivery; the status is static, not a backend health check.

## Cost boundary

- Keep the Static Web App on **Free**. Never upgrade automatically.
- Stop and ask the owner before creating or enabling any paid resource or entering billing information.
- Do not enable Front Door, Application Insights, paid databases, storage accounts, or separate Functions resources without explicit approval.
- The GitHub workflow deploys to an existing app; it does not create or upgrade Azure resources.
- Free bandwidth overage is unavailable: https://learn.microsoft.com/en-us/azure/static-web-apps/quotas . This does not protect unrelated resources elsewhere in an Azure subscription.
- The repository is public and uses a standard GitHub-hosted runner. Review GitHub's separate billing rules before changing visibility, runner type, or artifact storage.

## Future structure — not implemented yet

Add independent directories with their own `index.html` and module assets beneath `public/`: `jarvis/`, `daily-board/`, `drawercast/`, `media/`, `chat/`, `notes/`, `tools/`, and `status/`. Shared shell styles live in `public/assets/`. Add navigation only after the domain test succeeds. No placeholder modules or routes are shipped in this version.

Keep large media and data at external origins. Have future modules fetch directly from those services, subject to CORS and device access; do not proxy them through Azure. Never put API secrets in the frontend. Review each provider's free limits before connecting it. Expand the content security policy deliberately when adding module scripts or external connections.

Local preview: `python3 -m http.server 8000 --directory public`.

## Version 0.2

Home, Jarvis messaging, and Daily Board are implemented. Shared navigation uses real routes (`/`, `/jarvis/`, `/daily-board/`). The application has no third-party frontend requests or dependencies.

**Current deployment mode: local drafts.** Cloudflare account access awaits explicit owner authorization. The UI labels cloud setup as pending; messages have not been sent and no AI reply is simulated. Board entries and message drafts persist in browser storage. Clearing that storage loses local drafts and the workspace key. Cross-device pairing, exports, AI responses, and scheduled posts are not implemented.

The prepared `backend/worker.js` uses a Cloudflare Worker with a SQLite-backed Durable Object. It is not deployed. Verify the Cloudflare account is on **Workers Free** before deployment and stop at any billing or paid-plan prompt. Free limits fail requests rather than billing overages: https://developers.cloudflare.com/durable-objects/platform/pricing/ . Never switch to Paid automatically.

Backend activation after authorization:
1. Deploy `backend/wrangler.jsonc` under the verified Free account (Worker plus SQLite Durable Object only).
2. Set `API_ORIGIN` in `public/assets/config.js` to the actual deployed origin and add that exact origin to CSP `connect-src` in `public/staticwebapp.config.json`.
3. Verify preflight from the Azure origin, message write, fresh read, idempotent retry, and isolated workspaces.
4. Confirm the Android device can make the same request. The initial response is clearly labeled as an automatic storage receipt, not an AI response.

Workspace keys are random 256-bit bearer capabilities generated per browser and kept in local storage. Only a hash names the server workspace. Never log keys or commit them; possessing the key grants access to that workspace. The API restricts CORS to this hub, validates lengths, limits a workspace to 100 KB, and treats repeated event IDs idempotently. CORS is not authentication. No provider API key is exposed in frontend code.

Run `npm test` (Node 24, no dependencies) for backend boundary, workspace isolation, idempotent receipt, and draft merge checks. These use an in-memory storage adapter; they do not prove Cloudflare deployment or Android connectivity. Frontend drafts remain queued until a successful server response.
