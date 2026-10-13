# Poweramp web: freeze-stop evidence + proposed resume patch

Evidence from a local playback test (R2 source, desktop Chrome emulating Android) plus an **UNAPPLIED** proposed patch for `public/drawercast/player.js`.

- Finding: after a simulated 30 s background page freeze, playback pauses and never resumes (the player treats the non-user pause as final).
- Proposed patch: retry playback after unfreeze (0.4 s / 2 s / 6 s) when the user intended playback; 15 s light check only while hidden. Verified locally only (one simulated run); needs a real-phone test.
- **Lucy owns integration.** Docs only; no code changed.
- **Base caveat:** the diff targets the live deployed `player.js`, which is newer than `main` @ ed7bbd4. Apply on the branch that built the live site.

Files: `evidence-note.md`, `patch-note.md`, `proposed-patch.diff`.
