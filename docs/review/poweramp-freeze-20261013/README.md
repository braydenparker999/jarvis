# Poweramp freeze patch review

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

A second run also required measured hidden playback progress before freezing.
Control advanced 3.013 seconds while hidden, then stopped at 3.667208 seconds
through resume, 16 seconds hidden observation, and foreground return.
Proposal advanced 2.976 seconds before freezing, then emitted `playing` after
resume but remained at 3.618644 seconds throughout both 8-second hidden samples.
Bringing it to foreground finally advanced the playhead to 6.549047 seconds.
Thus the proposal does not satisfy the claimed background-resume criterion in
this Chromium environment. The generated local fixture is not a real R2
catalog/network test. Full native events, sampled states and the final bounded
trace are in [browser-evidence.json](browser-evidence.json).

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

Existing transport tests: 242/242 pass, using `poweramp-native-reliability`,
`poweramp-handoff-recovery`, and `poweramp-playback-continuity`.
Review contracts: unchanged live source 21/21 pass; proposal 13 pass, 8 fail.
The additional failures exercise changed request/track ownership and an element
ending before the timer callback. The ordinary end/queue paths still pass.
See [test-results.json](test-results.json) for commands, counts and failure names.

Full `JARVIS_CHROME=/usr/bin/chromium npm test`: 2,695 tests, 2,571 pass,
122 fail, 2 skip, exit 1, approximately 344 seconds. This is not a clean
qualification. Several downloaded `file:///` preview navigations are blocked
by managed Chromium policy, and existing My Media/Poweramp interaction and
prolonged-playback tests also fail. Other failure causes were not diagnosed in
this scoped task. Production source was unchanged for the entire run. No
frontend build is defined in Jarvis package.json. Deployment repository checks
were not run because that repository was only read.

Real Android screen-off, headphone controls, incoming calls,
YouTube audio focus, Doze/Battery Saver, and restricted Chrome battery mode
are not validated. This review is desktop simulation and deterministic
contract evidence, not Android lock-screen proof.

Frontend/UI, uploads, credentials, backend settings and schedules are unchanged.
PR #148 remains open and unmerged. No production release was performed;
release coordination belongs to the parent thread. A smaller automatic restart
still needs reliable pause-cause evidence; otherwise recovery should require
explicit Play. Owner-device evidence is the next useful input, not another
desktop success claim.

## Reproduce the review

Run in an isolated checkout of this review branch with existing Jarvis
development dependencies. Reconstruct the proposal in scratch space only:

```sh
git fetch origin makima/poweramp-freeze-evidence
mkdir -p /tmp/poweramp-candidate/public/drawercast
git show 099ec1a0b2b621a3799f4f8346490903f212a912:public/drawercast/player.js > /tmp/poweramp-candidate/public/drawercast/player.js
git show cbfab1d62b388feea9539191afe1b673b397f0f4:docs/makima/poweramp-freeze/proposed-patch.diff > /tmp/poweramp-candidate.patch
cd /tmp/poweramp-candidate
git apply --check /tmp/poweramp-candidate.patch
git apply /tmp/poweramp-candidate.patch
```

Back in the review checkout:

```sh
node --test scripts/review-poweramp-freeze-contracts.mjs
POWERAMP_PLAYER_SOURCE=/tmp/poweramp-candidate/public/drawercast/player.js node --test scripts/review-poweramp-freeze-contracts.mjs
node --test tests/poweramp-native-reliability.test.js tests/poweramp-handoff-recovery.test.js tests/poweramp-playback-continuity.test.js
```

The second command is expected to fail the eight safety contracts. The script
reuses the existing actual-engine VM harness with deterministic interval support;
it does not substitute a rewritten player or simulated recovery algorithm.

For native browser evidence, install the review-only tool outside the repo:

```sh
npm install --cache /tmp/poweramp-npm-cache --prefix /tmp/poweramp-review-tools --no-audit --no-fund puppeteer-core@24.20.0
DISPLAY=:97 PUPPETEER_MODULE=/tmp/poweramp-review-tools/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js PROPOSAL_SOURCE=/tmp/poweramp-candidate/public/drawercast/player.js EVIDENCE_OUT=/tmp/poweramp-freeze-native.json node scripts/review-poweramp-freeze.mjs
```

Use an available headful X display; this workspace used `Xorg :97 -config
/etc/X11/xorg.conf -logfile /tmp/poweramp-Xorg.log -nolisten tcp -noreset` with
the existing dummy display driver. `CHROMIUM_PATH` can override `/usr/bin/chromium`.
Puppeteer is a disposable review tool, not a new project dependency. The script
does not change the checkout: it serves disposable copied static files, native
generated WAV media and inert source configuration. Each valid run must observe
hidden playback progress plus trusted native freeze and resume events.
