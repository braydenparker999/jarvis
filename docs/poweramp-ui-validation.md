# Poweramp UI reliability and smoothness

Implementation date: October 2, 2026. The artwork-first layout, pills, navigation, and waveform beneath transport remain intact.

## Changes

- Outgoing screens become inert as soon as navigation begins; delegated row actions also validate screen ownership. Mini-player expansion cannot activate the outgoing song list.
- Gesture clicks are suppressed for the contact that moved or held, while a fresh deliberate contact and keyboard activation remain usable. Pending swipes, holds, and seek contacts cancel on navigation, replacement, capture loss, and backgrounding.
- Artwork, mini-player, EQ, A–Z, visualizer, and timeline gestures validate pointer ownership. Tap eligibility uses maximum travel; reversed vertical swipes use signed progress.
- Track menus render immediately and load artwork afterward. Request identity prevents late artwork or menu customization from affecting a newer or dismissed sheet. Shuffle owns its context-menu event.
- Mini-player seeking supports pointer capture, cancellation, song-change checks, and keyboard input. Queue has separate Added queue and Playback order views; the latter follows current engine indices, shuffle, and repeat settings without rebuilding the engine queue. Added queue interruption and completion remain governed by existing Queue settings.
- Library display hides a Drive migration copy only when an enabled R2 copy has the same migration identity, byte count, and checksum. Files, source settings, and saved playlists are retained.
- Library controls, song rows, groups, playlists, and folder navigation expose accessible names and keyboard actions.
- Seek progress uses transforms instead of repeated width/position layout changes. Row construction yields in small batches with a time budget and pauses during contacts unless needed for an A–Z jump. A–Z anchors are computed from metadata and deferred jumps reject obsolete views. Player fitting skips redundant style writes and retains scale-aware spacing.

## Regression evidence

The original repository suite contained 251 passing tests. The final suite contains 312 passing tests, including 61 focused gesture, menu, navigation, queue, and accessibility regressions. Existing playback sequencing and audio fidelity tests remain included. Playback progress cannot overwrite the mini-player seek preview while the contact owns it. Live browser testing also found that padding caused a Z tap to select W and an accented Ö title could preempt the Z jump. Alphabet input now uses cached visible letter bounds and folds accented Latin initials into their letter buckets; non-Latin titles cannot preempt an A–Z target.

Source-handler tests use simulated DOM nodes, pointer/touch events, timers, and display frames. They verify event ownership and state transitions; they do not establish physical-device smoothness. The deployed build must also be checked with real browser interaction.

## Galaxy A15 acceptance checks

- Rapidly tap the mini-player title over different song rows, including while paused. Current track, playback intent, and queue must stay unchanged until a deliberate player control is used.
- Scroll and pinch All Songs, then immediately tap a row. The moved contact must not play a song; the new tap must work. Interrupt momentum with a new contact.
- Scrub the waveform, then immediately tap Play and Next. Verify no delayed or duplicate activation.
- Test artwork diagonals, direction reversal, two fingers, capture loss, and background/resume. Check EQ, A–Z, mini seeking, and visualizer recovery.
- Open Shuffle by long press. Open successive track menus and dismiss while artwork is loading; the latest action must win.
- Check Queue views with shuffle, repeat, duplicate occurrences, added songs, and queue-end settings. Verify row and header Play actions keep the selected playback order.
- Check loaded waveform data, safe areas, font scaling, portrait/landscape, reduced motion, and keyboard focus.
- Record cold and warm visits with several thousand tracks: interaction-to-paint latency, frame times/dropped frames, layout/paint time, memory, and background resource use.

Physical Galaxy A15 input and performance are not available in the implementation environment. The plan's latency and 60 fps targets are acceptance targets, not measured results. Native scrolling and viewport virtualization remain conditional on device measurements and pinch/momentum validation; this release retains the existing scrolling model. Optional visual restyling was not applied.
