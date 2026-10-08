# Live anonymous conversation evidence

These captures show the qualified production source `e63fa716cf3e90522b6d6b1f1bcf36e67a67d186`, deployed as `6135657a25d2f24f1ce082a15504b935a4a734f4` in [successful production run 37760296791](https://github.com/braydenparker000/Missionarytube-/actions/runs/37760296791).

- [Public Relay reply](live-public-reply-390x844.png): the real responder's accepted public diagnostic reply, read back in a fresh browser under its exact UUID and reply target.
- [Anonymous owner sign-in](live-anonymous-owner-signin-390x844.png): empty sign-in controls and explicit private scope; no owner credential or phone session was used.
- [Public Muse controls](live-anonymous-muse-menu-390x844.png): the live public secondary surface, including its public-channel and identity limits.

The browser is Chrome 154.0.8037.97 on Node 24.21.0, with a 390×844 phone viewport. CDP fulfills exact TLS-verified production bytes from curl at the original existing HTTPS Origins because native browser transport is unavailable in the workspace. DOM text is not replaced. These are live anonymous captures, not physical Android tests.

The public request was saved at 10:08:52.209 UTC and its reply at 10:10:17.859 UTC: **85.650 seconds**. The original send reached confirmed browser acceptance in **0.934 seconds** and used one POST. Those are observations from one bounded diagnostic, not a future delivery guarantee or private-job completion.

Independent checks matched 13 critical static files to the qualified build, passed all 17 live read checks and all 10 Relay/Muse phone/desktop pages, retained separate public drafts, and kept private scope on reload. Unauthenticated private-job access returned 401. [Release identity](https://missionarytube.z13.web.core.windows.net/release.json) and [qualified receipt](https://missionarytube.z13.web.core.windows.net/release-qualified.json) identify the same source/deployment/run.

The separate [private result screenshot](../conversation-evidence/real-owner-result-360x800.png) and other existing owner captures use synthetic authenticated SQLite/browser fixtures. They do not prove a live owner-phone job completed. A legitimate owner-phone request/result test and physical Android keyboard/audio checks remain outstanding. Optional job progress tools are still absent from the connected host catalog; the existing authenticated immutable owner reply is the available completion path.

See [manifest.json](manifest.json) for exact timestamps, hashes, screenshot dimensions, transport and acceptance limits. This evidence branch changes documentation only and is not another production release.
