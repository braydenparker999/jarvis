# Jarvis

First version: a minimal, mobile-first domain connectivity test. No JavaScript, packages, remote fonts, media, analytics, APIs, or build step. Only `public/` is deployed.

## Deployment

Target: GitHub source repository, `main` branch, Azure Static Web Apps **Free** plan. No Azure resources have been created by these files. A deployment token alone cannot choose or enforce an Azure resource's pricing plan: verify **Free** in Azure before connecting it.

1. Create the GitHub repository and push this project to `main`.
2. In an existing Azure subscription, create a Static Web App named `jarvis`, choosing **Free**, with deployment source **Other** (the workflow is already provided here). Stop if Azure requests billing details or a paid service.
3. Add the app's deployment token as the GitHub Actions repository secret `AZURE_STATIC_WEB_APPS_API_TOKEN`. Never commit the token.
4. Run **Deploy Jarvis** from GitHub Actions. Copy the generated HTTPS `*.azurestaticapps.net` URL from Azure Overview once deployment completes.
5. Open that URL on the restricted Android device and confirm the three requested lines appear. Receiving this page tests static delivery; the status is intentionally static and is not a backend health check.

For Azure's automatically generated GitHub workflow instead, use preset **Custom**, app location `public`, empty API and output locations. Keep only one deployment workflow to avoid duplicate builds.

## Cost boundary

- Keep the Static Web App on **Free**. Never upgrade automatically.
- Do not enable Front Door, Application Insights, paid databases, storage accounts, separate Functions resources, or other paid services without the owner's explicit approval.
- This workflow uploads files to an existing app. It cannot create or upgrade Azure resources.
- Free bandwidth overage is unavailable; see https://learn.microsoft.com/en-us/azure/static-web-apps/quotas . This does not protect unrelated resources elsewhere in an Azure subscription.
- GitHub Actions has separate usage rules. Use standard hosted runners and ensure any private repository's Actions budget prevents paid overages before the first run.

## Future structure — not implemented yet

Add independent directories with their own `index.html` and module assets beneath `public/`: `jarvis/`, `daily-board/`, `drawercast/`, `media/`, `chat/`, `notes/`, `tools/`, and `status/`. Shared shell styles live in `public/assets/`. Add navigation only after the domain test succeeds. No placeholder modules or routes are shipped in this version.

Keep large media and data at external origins. Have future modules fetch directly from those services, subject to CORS and device access; do not proxy them through Azure. Never put API secrets in the frontend. Review each provider's free limits before connecting it. Expand the content security policy deliberately when adding module scripts or external connections.

Local preview: `python3 -m http.server 8000 --directory public`.
