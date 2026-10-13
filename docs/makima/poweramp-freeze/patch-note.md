# Proposed patch: resume playback after a background freeze (Poweramp web / drawercast)

**Status: UNAPPLIED and UNTESTED in production.** This is a proposal from Makima (Grok Bot). No repo was modified, pushed or PR'd, and nothing was deployed. Lucy owns integration, review and release.

Files:
- `/workspace/poweramp-test/proposed-patch.diff`: unified diff for `public/drawercast/player.js` in `braydenparker999/jarvis`.
- **Base caveat:** the diff is made against the **currently deployed** `player.js` (`/workspace/poweramp-test/player.js`, 10,435 lines). The repo's default branch at `ed7bbd4` (2026-10-09) has an older 9,859-line `player.js`, and the diff does **not** apply cleanly there (`git apply --check` fails at the first hunk). Rebase the hunks onto whichever branch produced the live build. All touched functions (`onPause`, `reconcilePlaybackLifecycle`, `play`, `pause`, and the `freeze`/`resume`/`online` listeners in the install block) exist in both versions.

## Plain-language summary
When Android freezes the page in the background, Chrome pauses the audio. The player currently treats that pause like "the user or another app stopped me", so it marks itself paused and never tries again. The patch tells it: "if the user still wants music and this pause happened because the page was frozen or hidden, try to play again a few times, then give up."

## What changes
1. **User intent is the existing `Engine._playIntent` / `wantsPlayback()`.** The intent flag already exists: explicit Play and MediaSession play set it true, while explicit `pause()`/`stop()` set it false before the element pauses. So genuine user pauses already short-circuit `onPause()` and are never retried. No new intent flag was needed.
2. **New `Engine.tryLifecycleResume(reason)`:**
   - Eligible only if playback is wanted, there's a real `src`, the element isn't ended or errored, and no load is in progress.
   - The page must have been frozen within the last 10 min (`freeze` event) or still be hidden. The intent captured at freeze time must match the current request and track.
   - Bounded retries: up to **3 attempts per song/request**, at 0.4 s, 2 s and 6 s. Each attempt resumes a suspended or interrupted `AudioContext` (`Engine.resumeContext('lifecycle')`) and then calls the existing `startElement()`. That keeps all existing request fences, R2 buffering deadlines and the `NotAllowed`/`Abort` handling.
   - MediaSession `playbackState` is held at `playing` while a retry is pending. `onPlaying()` then refreshes it through `updateMediaSession()`.
   - When the budget runs out, it falls back to the old behaviour, `pause('interrupted')`.
3. **`onPause()`:** before `pause('interrupted')`, it tries `tryLifecycleResume('pause')`.
4. **`reconcilePlaybackLifecycle()`** (runs on `resume`, `pageshow`, visible, and now also `focus`/`online`): if the element is paused, it tries `tryLifecycleResume('lifecycle')` before adopting the pause.
5. **`freeze` listener:** it records `noteLifecycleFreeze()`, which captures time and intent.
6. **`play()`** clears the retry state. **`pause('user'|'screen-off')`** clears it. Other pause reasons only cancel a pending timer.
7. **Hidden watchdog:** a 15 s interval, only while hidden and playback is wanted. If the element is paused with no event delivered, it routes through the same bounded `reconcilePlaybackLifecycle()` path.

## Risks
- **Audio focus (calls, YouTube, alarms):** the patch may retry up to 3 times within about 8 s, but only if the page was recently frozen or is hidden. On a phone call this could cause a brief attempted restart. Chrome normally rejects or immediately re-pauses it, and then the budget runs out and it stops. **This must be checked on a device.** If it's a problem, shrink to 1 to 2 retries, or require a `freeze` (not just hidden).
- **Intentional design reversal:** this partly overrides the existing comment "A missing pause event is still an interruption, never a reason to play". Lucy should decide whether that trade-off is acceptable.
- **`pause_on_screen_off` setting:** `pause('screen-off')` clears intent first, so it isn't fought. Worth a regression check.
- **Autoplay policy:** if Chrome requires a gesture after a freeze, `play()` rejects with `NotAllowedError`. The existing handler then pauses and shows "Tap play again". That's no worse than today.
- **Battery:** the watchdog is a 15 s no-op timer unless hidden and wanting playback. Hidden timers are throttled anyway.
- **Not covered:** a real Android freeze or discard of a page that is truly killed (`wasDiscarded`). That needs reload-time restore, which this patch doesn't do.

## How to test
**CDP freeze repro (desktop):** `/workspace/poweramp-test/r2b/run.js` does R2-only, foreground, hidden, `Page.setWebLifecycleState frozen` for about 30 s, then `active`. The pass criterion is that `currentTime` keeps advancing after unfreeze. The shortened local variant is `/workspace/poweramp-test/local-patched/run.js` (env `URL=`). Run it headful with `DISPLAY=:2` and no request interception.

**Local-only sanity result (2026-10-13, about 08:46 to 08:51 ART):**
- **Setup:** I served the deployed drawercast files from `/workspace/localsrv` (patched) and `/workspace/localsrv-orig` (unpatched control) on localhost. The R2 worker rejects the localhost origin via CORS, so these test browsers ran with `--disable-web-security`. The music itself was the real R2 library, with zero Drive requests. Both runs were side by side with an identical script.
- **Control (unpatched):** froze at "Sesame Girl" 1:23.7. On unfreeze it went to `paused`, `Engine.playing=false`, and stayed stuck for the remaining 2+ min. This reproduces the deployed bug.
- **Patched:** froze at 1:23.8. Within 5 s of unfreeze `<audio>` was playing again and `currentTime` advanced 83.8 → 164 s while hidden. It then auto-advanced to the next track ("The Past"), still playing at the end.
- **Logs:** `local-control/log.jsonl` and `local-patched/log.jsonl`.
- **Caveat:** this is local-only, desktop Chrome, a simulated freeze, a single run, and CORS checks disabled. It is **not** evidence about real phones.

**Real-device steps (required before calling this fixed):** see "Recommended real-device validation" in `lucy-evidence-note.md`. In short:
1. Screen off for 10 to 15 min across song boundaries.
2. App switch to a non-audio app (should keep playing) and to YouTube (should stop and stay stopped).
3. Battery Saver and Chrome battery set to "Restricted".
4. Pause from the lock-screen notification (must stay paused).
5. Incoming call (must stop; at most a brief retry, no restart over the call).
Capture the playback trace events `lifecycle-resume-scheduled/attempt/exhausted`, `freeze` and `page-resume`.
