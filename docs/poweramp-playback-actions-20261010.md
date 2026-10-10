# Poweramp playback notification and Media Session reliability

Candidate base: `97b048abfde97426da7b5eb3a310964631ce724c`, on
`release/astra-live-backport-20261009`. This changes playback state validation
and Media Session registration only. Poweramp markup, styles, gestures, source
configuration, delivery services and deployment pins are unchanged.

## Reproduced defects

1. `onPlaying` accepted a queued `playing` event or fulfilled Play promise when
   the element had already fallen back below `HAVE_FUTURE_DATA`. It cleared the
   existing 12-second no-progress timer, even with no playable data at the seek
   position. A held native HTTP Range response reproduces the no-data state;
   replaying the delayed notification removes its recovery deadline on the
   original player. The candidate reads current readiness, pause, end and error
   state before accepting the notification. It preserves the original deadline,
   existing one-reload allowance, selected track and position. A late
   `timeupdate` from the last buffered frames is checked the same way, and the
   watchdog rechecks readiness when its deadline fires. Pause still cancels
   recovery. If a native pause notification was missed, the watchdog reads
   `paused` and yields intent instead of reloading and restarting the element. The notification timing is injected in this
   reproduction;
   it does not prove that a particular physical device encountered this race.
2. `updateMediaSession` awaited artwork before registering transport handlers,
   and metadata construction shared the same exception boundary as registration.
   Pending/rejected artwork could delay or prevent initial registration and
   changes to the headset-button setting. Invalid metadata could likewise skip
   registration. Controls now register synchronously and independently; textual
   metadata is immediate and optional artwork follows. A per-update sequence
   rejects stale artwork completions even within the same selected track.

The [HTML media processing model](https://html.spec.whatwg.org/multipage/media.html#notify-about-playing)
queues playing notifications and Promise resolution. The candidate consequently
checks native state when handling the notification, instead of treating its
arrival as an unconditional assertion of present readiness.

Eight controlled Engine regressions fail on the frozen original script and pass
on the candidate. Three browser regressions also fail before/pass after: pending
artwork setting changes, the held native stream with delayed notification, and
a real native pause whose event was withheld before the stall deadline.
Existing media doubles now clear errors when a source is replaced and supply
future data when simulating successful playback; their original assertions
remain intact.

## Trace and preserved policies

The Engine owns two persistent audio elements. `_playRequest` identifies a
selection or cancellation, `_playAttempt` fences Play promises, and transition
owners fence the spare slot. Native events bind to the installed Engine methods.
Manual navigation uses the requested queue occurrence, including rapid commands;
explicit queues and automatic ends retain their existing policies.

Native and legacy R2 URLs use the same bounded recovery path. R2 reloads the
original URL once, waits for online when appropriate, retains pending seeks,
and rechecks request/element/source/track ownership. Decode failures stay
terminal. Native pause and AudioContext interruption relinquish playback intent;
page return does not grant permission to restart. No blanket retry, focus
resumption, retry-budget reset, or source fallback was added.

Read-only inspection of `backend/music.js` and `backend/music-upload.js` found
single/suffix/open Range support, 206/416 handling, HEAD behavior, ETags,
conditional object identity checks and exposed CORS Range headers. Existing
native R2 and delivery tests cover these paths; this candidate does not modify
or attribute a new defect to server delivery. A bounded live probe reached the
configured R2 catalog but received HTTP 403 from this environment. No live
track Range request was possible; this is a live-verification blocker, not
evidence that delivery is failing on other clients.

A live byte comparison on 2026-10-10 found the deployed `drawercast/player.js`
identical to the candidate base, SHA-256
`ae45b9cbff63c1b129aa2672cc855454ce52611e75ab7fdacda2dc7b20c7247d`.
At that observation, `/release.json` named source
`7264c473cb45be370647d95f37aa6db99759af1a`; that whole-release identity is distinct
from the unchanged playback-file identity. This is observation, not deployment
of this candidate.

## Validation

Final focused Engine/continuity/handoff/R2/track-step suites: **300 passed,
zero failures/skips**. Final expanded native Chromium suite: **11 passed,
zero failures/skips**. A subsequent targeted browser rerun passed **4/4**
after strengthening the missed-pause fixture to settle native Play first; this
excludes startup AbortError as an independent stop path. Production bytes were
unchanged. Coverage includes:

- Actual PCM decoding and seeks through the full production audio graph.
- An extended soak with **five unaccelerated 65-second intervals (325 seconds
  total), ten real native ends, and 22 registered Next/Previous commands**.
  Commands are exercised again after each interval, across both audio slots.
- Pause/Play and a controlled CDP freeze/return while paused, without restart.
- Offline Next, same-selection online recovery, cancellation by Pause, and
  terminal online/after-probe unsupported media.
- A real held HTTP body and Range seek; injected delayed startup notification
  must preserve the recovery deadline. Withholding a real native pause event
  must not let the watchdog reload or resume the paused element.
- Pending artwork I/O while toggling the Media Session setting.

Frozen original playback source: **eight Engine regressions fail**; all three
targeted browser regressions fail (four failed TAP entries including their
parent suite). Candidate tests use the same unchanged assertions.

The initial focused runs used Node 24.19.0 and Playwright Core 1.56.1. Chromium
was the checksum-verified official Chrome for Testing **154.0.8037.97** archive.
Repository-wide validation used the pinned Node **22.23.3** runtime.
The initial candidate `npm test` completed with **2,527 tests: 2,521 passed, four failed, two skipped**.
This is **not** a qualification pass. Failures were the external My Media
archive-cover timeout (and its parent), a missing historical My Media comparison
commit, and a Relay attachment replay timeout. The comparison commit was fetched
afterward. The skips were live podcast coverage and a separate Relay browser
journey requiring its own browser-path variable. All Poweramp tests in that run
passed. Dark/light canonical list/player pixel comparisons reported zero changed
pixels. Separate reruns do not erase the aggregate failures or skips.

The final candidate full run completed with **2,538 tests: 2,535
passed, 2 failed, 1 skipped**. Only the unchanged external archive-cover
subtest and its parent failed; live podcast coverage remained opt-in and skipped.
The historical comparison and Relay replay passed in this complete rerun. All
Poweramp tests passed, including the added missing-pause watchdog regression;
the four canonical dark/light endpoints again had zero changed pixels. This
full run still does **not** qualify a release.

The render-trace gate's combined-source fingerprint is updated to
`eddedc6cbea78c31d5913b1831282cbe12de4180dbccbc26c6e849ae04abfe83`.
Its frozen baseline, measurement cases, timing limits and pixel gates are intact. All three final serial performance gates passed: render trace
(all eight planned cases), persistent owner, and cold/repeat/playing setup.
The candidate playback-file SHA-256 is
`10009870adbabe88db873f5b5f1af7f47acd50d5471a37c8f9700b169f5811b0`.


Reproduce the candidate tests with the repository's verified browser installer
and `JARVIS_CHROME` set to its executable:

```sh
node --test tests/poweramp-native-reliability.test.js \
  tests/poweramp-playback-continuity.test.js \
  tests/poweramp-handoff-recovery.test.js
POWERAMP_SOAK_SEGMENTS=5 node --test tests/poweramp-native-reliability-browser.test.js
```

For before evidence, extract the base `public/drawercast/player.js` and set
`POWERAMP_PLAYER_SOURCE` to that file. Override runs are reproduction evidence,
not release qualification. Logs under `docs/evidence/poweramp-playback-actions-20261010/`
record before/after outcomes and remaining qualification limitations.

## Acceptance limits

Registered callback invocation is synthetic Media Session input, not a physical
headset test. Native decoding and network failure are real Chromium behavior;
CDP freeze and an explicit lifecycle notification do not establish Android
screen-off scheduling, OS focus delivery or renderer survival. The continuous
intervals are 65 seconds each (325 seconds total), not an hours-long reliability
claim.

WorkDroid reported no connected phone during this investigation. Actual Android,
Bluetooth/headphone, calls/other-app focus, and locked-screen acceptance remain
unverified. These reproducible fixes are a candidate; they do not establish the
cause or resolution of a particular phone's intermittent stop.

Before release, use the approved candidate on a real device for prolonged
locked playback, repeated headset Next/Previous, deliberate Pause, a brief
network loss with a track change, and another app taking audio focus. Export
the existing bounded playback report promptly after any failure. Independent
review and the coordinated pinned release remain required; this work neither
merges nor deploys the candidate.
