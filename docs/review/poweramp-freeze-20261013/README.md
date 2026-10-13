# Poweramp freeze patch review checkpoint

Decision: reject Makima's automatic-resume implementation. Do not merge draft
PR #148 as-is. No player change or production deployment is justified by the
current evidence and interruption-safety requirements.

Reviewed the README, evidence note, patch note and proposed diff at
`cbfab1d62b388feea9539191afe1b673b397f0f4` in
[PR #148](https://github.com/braydenparker999/jarvis/pull/148).
The original repro scripts, raw logs and screenshots are referenced on another
machine; they are not files in that PR. Claims in those notes were treated as
third-party evidence, not execution instructions.

## Exact source reconciliation

- Source base: `release/astra-live-backport-20261009`,
  `099ec1a0b2b621a3799f4f8346490903f212a912`. It includes UI release `fed2369`
  and the later dormant Makima adapter merge `099ec1a`.
- Live `https://missionarytube.z13.web.core.windows.net/drawercast/player.js`
  downloaded 2026-10-13 matches the release file byte for byte.
- SHA-256 of both files:
  `aede20b8b5785d4719765dc44a0a3c390159bf4fdeb5e11e9d641df83d40901a`.
- The proposed diff applies cleanly to this exact source. Default main is not
  the correct patch base.
- Deployment repository `braydenparker000/Missionarytube-` main was
  `47028ed939a88055a33d2935383a89fafe561f68`; its checked-in release pin was
  `c28c1b2f70aabb5217b08bf31ffe4c93d0353765`, not the exact live release source.
  The live-file equality establishes the player base, not deployment provenance
  for every other asset. Parent must reconcile this before any future release.

## Reproduced so far

Local headful desktop Chromium `151.0.7922.173`, mobile viewport/touch,
generated native R2 fixture audio, 30-second CDP freeze, no security bypass,
no autoplay-policy override. Native hidden/freeze/resume states were required;
no lifecycle DOM events were injected for this browser reproduction.

Control: audio playing at freeze, paused at resume, intent becomes false and
position remains at 0.856345 seconds after eight seconds. Proposal: calls Play
about 400ms after resume and emits `playing`, but position remains about
0.720912 seconds at the eight-second sample. This confirms a play attempt,
not sustained flowing output. It does not reproduce Makima's claimed
post-freeze advancement in this environment.

Initial Playwright runs were excluded: its focus emulation kept the document
visible and no native freeze event fired. The checked-in reproduction uses
Puppeteer and fails if hidden/freeze/resume are not actually observed.

Actual-engine deterministic review: 21/21 safety contracts pass against the
unchanged live source; the proposed source fails 8/21. It restarts hidden
native pauses with and without a pause task, restarts a later native pause
within its ten-minute freeze window, lacks source/request/track/ended fences
at timer execution, and restarts repeatedly across freeze notifications.
App Pause/Stop, MediaSession Pause, screen-off pause, paused selection,
AudioContext interruption, ended queue, and autoplay/abort denial were checked.

## Why a smaller automatic retry is still not justified

Requiring one freeze and one retry would reduce the proposal's scope, but the
same observable paused state can also result from browser/OS/headphone Pause
while renderer tasks are frozen. `_playIntent` only describes the page's last
known intent; it is not evidence that an external Pause was involuntary.
No reliable cause signal was supplied to distinguish those cases. A retry
budget does not prevent the first unwanted restart. Keep native pauses
terminal and require explicit Play until that distinction is demonstrated.

[Chrome's lifecycle documentation](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
explains that renderer timers do not execute while frozen. A new 15-second
interval cannot keep playback alive during that state. In the proposal it is
installed unconditionally, although its callback does work only while hidden
and wanting playback. Later delays are only used on later notifications;
the callback does not schedule the next retry itself. On success the budget
is retained for that song/request, so later freeze episodes share it.

## Remaining validation

The full repository suite is running; results will be appended before the
draft review PR. Real Android screen-off, headphone controls, incoming calls,
YouTube audio focus, Doze/Battery Saver, and restricted Chrome battery mode
are not validated. This review is desktop simulation and deterministic
contract evidence, not Android lock-screen proof.

Frontend/UI, uploads, credentials, backend settings and schedules are unchanged.
PR #148 remains open and unmerged. No production release is authorized from
this checkpoint; release coordination belongs to the parent thread.
