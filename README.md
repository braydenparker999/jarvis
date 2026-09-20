# Jarvis

A mobile-first personal hub with Home, Jarvis messaging, and Daily Board. Only `public/` is deployed to Azure. The UI uses small native JavaScript modules and system fonts, with no frontend dependencies or build step.

## Deployment

- Live site: https://gray-meadow-09216fd10.1.azurestaticapps.net/
- Source: https://github.com/braydenparker999/jarvis, branch `main`.
- Hosting: Azure Static Web Apps **Free**, app `jarvis`, resource group `jarvis_group`.
- Azure's GitHub integration created the deployment workflow and repository secret. The workflow now deploys the static files directly, without build, API, or preview jobs. The original bootstrap workflow was removed to avoid duplicate deployments.
- Custom preset; app location `public`; empty API and output locations.
- Push changes to `main` to deploy. Check GitHub Actions for the deployment result and Azure Overview for the generated HTTPS `*.azurestaticapps.net` URL.
- The initial domain test succeeded on the restricted Android device. Cloud message storage and automatic receipts are deployed and verified, including the Android device test.

## Cost boundary

- Keep the Static Web App on **Free**. Never upgrade automatically.
- Stop and ask the owner before creating or enabling any paid resource or entering billing information.
- Do not enable Front Door, Application Insights, paid databases, storage accounts, or separate Functions resources without explicit approval.
- The GitHub workflow deploys to an existing app; it does not create or upgrade Azure resources.
- Free bandwidth overage is unavailable: https://learn.microsoft.com/en-us/azure/static-web-apps/quotas . This does not protect unrelated resources elsewhere in an Azure subscription.
- The repository is public and uses a standard GitHub-hosted runner. Review GitHub's separate billing rules before changing visibility, runner type, or artifact storage.

## Module structure

Home, `jarvis/`, and `daily-board/` share the lightweight shell and native navigation in `public/assets/`. Later modules can use independent directories and assets beneath `public/`: `drawercast/`, `media/`, `chat/`, `notes/`, `tools/`, and `status/`. No placeholder routes for these future modules are shipped.

Keep large media and data at external origins. Have future modules fetch directly from those services, subject to CORS and device access; do not proxy them through Azure. Never put API secrets in the frontend. Review each provider's free limits before connecting it. Expand the content security policy deliberately when adding module scripts or external connections.

Local preview: `python3 -m http.server 8000 --directory public`.

## Version 0.3 — responder connection

Cloud backend: https://jarvis-hub-api.braydenparker999.workers.dev

Cloudflare Builds must use an empty Build command and Deploy command `npx wrangler deploy --config backend/wrangler.jsonc` from repository root. Azure deploys only `public/`. No AI API, cron trigger, or paid resource is configured.

Jarvis and Quick Chat are separate products:
- Jarvis is intended for ChatGPT to check the inbox hourly and write thoughtful replies. **No scheduled task is enabled yet.** The owner does not want Astra for routine replies. Model selection, usage accounting, and scheduled tool access must be verified before enabling it.
- Quick Chat is planned as on-demand responses from a free AI API. It is not implemented.
- Daily Board stores entries; scheduled posts are not enabled.

The responder console is `/respond/`. On the owner's phone, Connection → Create responder connection creates a separate 30-day bearer credential. Enter it in the responder console's connection form through secure credential entry, never paste it into a chat, repository, URL, or log. One responder connection is active per workspace. Creating another replaces the old connection. Disconnect responder revokes access immediately. The owner key is not disclosed to the responder. The responder may read messages and board entries and reply to existing messages, but cannot modify entries in the owner's workspace or send as the owner.

API routes:
- Owner: GET `/v1/state`, POST `/v1/messages`, POST `/v1/board`.
- Owner: POST `/v1/responder/connect` or `/v1/responder/revoke` with `{}`.
- Responder: GET `/v1/agent/inbox` returns history and `unanswered` messages. Delivery receipts do not count as answers.
- Responder: POST `/v1/agent/replies` with `{id, replyTo, body}`. Repeating the same reply is idempotent even with a new request ID; a different second answer returns 409. Reply targets must exist in that workspace.

All protected routes require `Authorization: Bearer <credential>`. Keys are stored in the corresponding browser's local storage; only hashes identify server records. CORS permits the Azure site. There is no global inbox. An agent must connect to the owner's workspace before it can read phone messages. Existing drafts and messages are preserved. Workspace message/board data is limited to 100 KB; export and archival are future work.

Run `npm test` (Node 24, no dependencies). Tests cover persistence, isolation, validation, retry behavior, draft merging, unanswered filtering, responder rotation/revocation and reply target checks. Cloud deployments need a separate live test. Never claim a scheduled task exists unless its creation and required connector access have succeeded.
