# Jarvis

A minimal, mobile-first domain connectivity test. No JavaScript, packages, remote fonts, media, analytics, APIs, or build step. Only `public/` is deployed (2,656 bytes).

## Deployment

- Source: https://github.com/braydenparker999/jarvis, branch `main`.
- Hosting: Azure Static Web Apps **Free**, app `jarvis`, resource group `jarvis_group`.
- Azure's GitHub integration manages the deployment workflow and repository secret. The original bootstrap workflow was removed to avoid duplicate deployments.
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
