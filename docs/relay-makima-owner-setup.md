# Makima secure owner setup

PR #146 is merged into `release/astra-live-backport-20261009` as
`099ec1a0b2b621a3799f4f8346490903f212a912`. The merged tree exactly matches the
approved, green-qualified source `2689ef38be46aac2d9597509f2fd944ca0126956`.
The owner approved the isolated connection and one harmless manual exchange.
Setup is paused for owner confirmation that the new secure fields are saved.
Code merge alone does not establish Worker deployment or activation. No grant,
external agent message, webhook or routine has been performed.

The source implementation deliberately requires a distinct GitHub owner-sign-in
OAuth app and secret. Stop here for owner entry of that NEW secret in supported
secure fields. Never send it into this conversation, a terminal command line,
source file, repository secret export, log, screenshot, HAR or agent config.
Do not read/copy existing credentials. The Bot receives no client secret.

## Public connection values (chosen, not live-configured)

- MCP URL/audience: `https://jarvis-hub-api.braydenparker999.workers.dev/relay/makima/mcp`
- Public Bot CLIENT_ID: `b6bf3d2688484111e45ab58a644208918b875ad6fccc16f3ef65ad986aab4def`
- Scope: `relay:makima` only
- Bot CLIENT_SECRET: leave empty
- Exact allowed Bot callback: `https://www.cursor.com/agents/mcp/oauth/callback`

## Exact owner entry steps

1. In [GitHub New OAuth App](https://github.com/settings/applications/new), register one new OAuth App,
   name `Jarvis Makima`, homepage
   `https://missionarytube.z13.web.core.windows.net/`, and only callback
   `https://jarvis-hub-api.braydenparker999.workers.dev/relay/makima/oauth/github/callback`.
   Do not enable device flow. This new app is for Jarvis owner sign-in; its GitHub
   Client ID is DIFFERENT from the public Bot CLIENT_ID above.
2. Open Cloudflare dashboard → Workers & Pages → `jarvis-hub-api` → Settings →
   Variables and Secrets. Add only these NEW Makima names; preserve all existing
   entries, bindings and credentials:

   | Variable name | Field type | Value |
   | --- | --- | --- |
   | RELAY_MAKIMA_GITHUB_CLIENT_ID | Text | Client ID from the new GitHub OAuth App |
   | RELAY_MAKIMA_GITHUB_CLIENT_SECRET | Secret | New secret generated for that new app, entered directly by owner |
   | RELAY_MAKIMA_CLIENT_ID | Text | Public Bot CLIENT_ID shown above |
   | RELAY_MAKIMA_ENABLED | Text | false during setup |

   Use Cloudflare's Secret field for the new GitHub secret, never Text.
   Cloudflare's dashboard Deploy action applies settings to the current Worker
   version; it does not prove the merged Makima code was deployed. Leave the
   Makima flag false pending verified backend code deployment. Tell the assistant
   only that the fields are saved, without returning secret values.
3. After the secure handoff, continue the already-approved dedicated backend
   deployment with existing settings/bindings preserved. Do not run uploader,
   music setup, unrelated frontend promotion or webhook activation as a shortcut.
   The source merge alone did not deploy the new endpoint.
4. Once deployed and complete Makima-only settings are present, use the approved
   bounded enablement and configure the Bot with the public URL/ID/scope above,
   leaving CLIENT_SECRET empty. Before any sign-in/Allow, inspect `redirect_uri`
   locally in its authorization request. Confirm exact string equality with the
   allowed HTTPS callback. If different or not observable, stop; no wildcard,
   localhost, custom-scheme, mixed-list or ignored-redirect exception is allowed.
   Report only match/no-match, not OAuth URLs, state, PKCE, cookies, codes or tokens.
5. On callback match, the approved test uses a narrow `relay:makima` grant. The
   initial exchange issues access (at most one hour) AND refresh with a fixed
   30-day absolute deadline from consent. Each replacement refresh token retains
   that same deadline; this is not a sliding inactivity expiry. Do not select 365 days; refresh rotation never
   extends the deadline. For the one harmless manual exchange, share explicit
   test text only, confirm the Bot's channel reply, then revoke its family while
   enabled before disabling. No routine or webhook is part of this approval.

## Endpoint observation recorded on 2026-10-13

Unauthenticated GET probes for `/health`, `/relay/makima/mcp`, Makima OAuth
metadata, `/relay/mcp` and `/relay/mast/messages` returned HTTP 403 / Cloudflare
Error 1010 (browser-signature access denial) from this execution environment.
No access-control bypass, disguised headers, reused credentials, or private
history reads were attempted. Therefore live endpoint/deployment/roundtrip
success has NOT been verified, and ChatGPT/Mast live behavior is not newly
asserted. The same existing code paths and production settings were left intact.

## Official secure-entry references

- [Create a GitHub OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
- [Enter a Cloudflare Worker secret](https://developers.cloudflare.com/workers/configuration/secrets/)

## Exact source qualification

Merged source: `099ec1a0b2b621a3799f4f8346490903f212a912`. Its complete tree
matches PR #146's tested `2689ef38be46aac2d9597509f2fd944ca0126956`.
[Merge-commit qualification run 38388559662](https://github.com/braydenparker999/jarvis/actions/runs/38388559662)
completed successfully at exactly that merged source. Deployment and enablement
still await owner confirmation of the secure setup prerequisites. This document adds no
runtime configuration and does not enable Makima.
