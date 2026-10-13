# Poweramp web: background-freeze playback evidence (for Lucy)

From: Makima (Grok Bot), on Brayden's request. Evidence only. I changed no code, did no deploys, and touched no settings. You own the fix and the release.

## What was tested
Deployed player: https://missionarytube.z13.web.core.windows.net/drawercast/ (live build as of 2026-10-13).
- Headful Google Chrome on my box (puppeteer-core, `--autoplay-policy=no-user-gesture-required`). Emulated a Pixel 8 with an Android 14 UA, a 412x915 mobile viewport and touch.
- Sources: R2 only (`drawercast.sources.v1 = {local:false, drive:false, r2:true, server:false}`). No request interception and no network listeners, because heavy CDP network logging had choked the 8 MB manifest in an earlier attempt.
- Phases: foreground, then hidden (another tab brought to front, focus emulation off), then frozen for about 25 s via CDP `Page.setWebLifecycleState frozen`, then `active` (still hidden) for about 6 min, then brought back to the front.
- A poll every 5 s recorded the `<audio>` state (currentTime, paused, readyState, error), `Engine.playing`, `navigator.mediaSession.playbackState` and resource hosts.

## R2-only verification
- Library loaded in about 5 s: "Verified R2 library ready", 7,292 tracks, all kind `r2`.
- Media streamed from `jarvis-hub-api.braydenparker999.workers.dev/music/library/audio/r2_native_*`. The resource tally had zero googleapis/drive/googleusercontent entries for the whole run (`driveHit:false`).
- The only console errors were two 404s on page assets, unrelated to playback.

## Timeline (ART = UTC-3, 2026-10-13)
| ART | Phase | Observation |
|---|---|---|
| 08:10:49 | foreground | Play tapped (shuffle on). "Sesame Girl" plays, currentTime advancing, readyState 4 |
| 08:13:38 | foreground | Auto-advance to track 2 ("oh are you bipolar one or two?") in under 5 s |
| 08:14:03 | hidden | Page hidden. Track 2 keeps advancing normally, with no stall around the 2-minute mark |
| ~08:15 to 08:17 | hidden | Polls were sparse (timer throttling while hidden). Auto-advance to track 3 "AMEN" happened while hidden |
| 08:17:09 | frozen | Freeze applied at AMEN 0:05.1. `<audio>.paused = true` immediately, while `Engine.playing = true` and `mediaSession.playbackState = "playing"` |
| 08:17:34 | active (hidden) | Unfrozen. The app adopts the pause: `Engine.playing = false`, mediaSession `"paused"` |
| 08:17:34 to 08:23:29 | hidden, then front | Stuck at 0:05.1 for about 6 min. readyState 4 (fully buffered), no media error, no retry. Bringing the tab to the front did not resume it |

## Observed vs inferred
**Observed:**
- Foreground playback, hidden playback and hidden auto-advance all worked.
- The freeze paused the element.
- After unfreeze the app's own state switched to paused and never attempted play again.

**Inferred (not proven):**
- This matches Brayden's "stops and stays stopped, often with the screen off" reports.
- In `player.js`, `reconcilePlaybackLifecycle()` (run on `resume`, `pageshow` and visible) and `onPause()` both treat a non-user `<audio>` pause as terminal. They call `pause('interrupted')`, per the comment "A missing pause event is still an interruption, never a reason to play". That design is intentional to avoid fighting calls and other apps, but it also makes a browser-imposed freeze pause permanent.
- I saw **no** evidence of a fixed ~2-minute stop in this run.

## Limitations
- Desktop Chrome emulating a phone, not a real Android device. The freeze was simulated by CDP. Real Android may differ: real freeze timing, audio focus, Doze and battery saver, the media notification, and whether Chrome freezes a page that is playing audio at all.
- One run, 3 tracks, one freeze. Not statistically meaningful.
- Hidden-tab polls were throttled, so there are gaps in the timeline (about 08:15 to 08:17 and 08:19 to 08:22).

## Artifacts (on the Grok Bot box)
- `/workspace/poweramp-test/r2b/log.jsonl`: full poll log (timestamps in UTC)
- `/workspace/poweramp-test/r2b/run.js`: the repro script
- `/workspace/poweramp-test/r2b/*.png`: screenshots (01-load, 02-playing, shot-120s to 643s, 99-final)
- `/workspace/poweramp-test/player.js`: the deployed player.js as downloaded
- Proposed (unapplied) fix: `/workspace/poweramp-test/proposed-patch.diff` and `patch-note.md`

## Recommended real-device validation (Brayden's phone, Chrome, R2 only)
Before each test, enable Diagnostics or playback trace if available, and note the times.
1. **Screen off for 10+ min:** start a playlist, lock the phone, wait 10 to 15 min across at least 2 to 3 song boundaries, then unlock. Record whether it is still playing, the timestamp where it stopped, and whether the lock-screen media notification shows playing or paused.
2. **App switch:** play, switch to another app that doesn't use audio (for example Maps) for 5+ min, then come back. Repeat with an app that **does** take audio focus (YouTube) to confirm that stopping is correct there.
3. **Battery saver:** repeat test 1 with Android Battery Saver on, and again with Chrome set to "Restricted" battery usage.
4. **Media controls:** while the screen is locked, pause and play from the notification to confirm user pause still sticks.
5. If possible, capture the playback trace or `chrome://inspect` remote-debug console for `freeze`, `page-resume`, `element-pause` and `pause-request {reason}` events around each stop.
