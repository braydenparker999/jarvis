# Google Drive music source

The public test folder is `1VlEUztloW5saoM7iF11fodDKSmCGP2ZZ` (50 songs at setup). Drive API key-only reads and byte-range requests were verified for both WebM/Opus and M4A content from the Storage origin. This integration uses `files.list` and `files.get?alt=media`; it does not scrape Drive pages or proxy music through Azure/Cloudflare.

The existing DrawerCast player, audio processing, queue, preload and waveform code remain in use. Google Drive Music is a separate library category and settings entry. A15 refresh/disconnection and Drive refresh/disconnection remove only their own source's tracks. Local files and other-source tracks remain intact. Listing follows pagination and subfolders and commits only after the complete read succeeds. Song IDs remain stable across refreshes; ratings and play counts are retained.

The owner approved public access to this folder and an embedded shared API key. `GOOGLE_DRIVE_API_KEY` is stored in the two existing repositories' Actions secrets, then injected by `scripts/configure-drive.mjs` into the deployed `assets/drive-config.json`. The tracked placeholder contains no key. No key is saved in track metadata or library exports. Existing Google Cloud API restrictions and billing settings are not changed.

## Prepared waveforms

`scripts/prepare-drive.py` downloads files to temporary directories, reads metadata and produces compact 16-bin-per-second DCW waveforms with ffmpeg. It never writes audio into the frontend or git. The initial 50 waveforms total 161,130 bytes. These small derived visualization files and `drive-prepared.json` are static frontend assets. Audio stays on Drive.

Prepared metadata is used only when the current Drive file size and MD5 match the scanned revision. New or changed songs still stream, with live waveform samples until preparation is run again. Initial preparation handles immediate audio/video children of the specified folder; recursive playback browsing is supported separately. Files over 50 MiB or 30 minutes require an explicit preparation-budget change. No scheduled preparation service is introduced.

Prepare a folder locally with:

```
python scripts/prepare-drive.py FOLDER_ID --key-file /private/path/to/key
```

Use a private key file outside the repository. Review the output and publish through the existing source/pinned-Storage workflow. Test-folder waveforms are a small initial batch; assess the frontend size budget before expanding to very large libraries or moving derived assets to Drive.

## Verification and rollback

`npm test` covers Drive pagination, recursive folders, key-free stored metadata, source isolation, failed reads, waveform revision validation, and every generated binary waveform. Browser verification must prove actual playback, seeking, switching tracks, and persistence. Screen-lock/background behavior on the physical restricted Android remains a device test, not something a desktop cloud browser can prove.

Baseline before Drive: source `55f338a3aecb3898c88665f22310fd14e9d024c1`; Storage deployment `6bc585cf3995bb24356cc31fc374703c80724048`. Use the workflow's pre-deployment blob backup or revert source and the release pin. If reverting an already-used browser, first remove Drive through its settings so an older player does not mistake persisted Drive tracks for A15 tracks. No files were changed or deleted in the source Drive folder.


## Embedded metadata after a Drive remux

Drive's file listing does not expose embedded music tags. DrawerCast now reads bounded byte ranges for visible songs and the selected song, using its existing tag parser. Opus/Ogg tags and embedded artwork are read from the file header; the full song is never downloaded for metadata or waveform analysis. Range responses must be exact HTTP 206 responses, with a 2 MiB / 8 request ceiling per metadata job. A refused range is cancelled. Jobs run one at a time, pause new work while playback buffers, prioritize the selected track, and cancel abandoned cover reads when tracks change.

Tags and 220px artwork thumbnails are cached in IndexedDB. Cache validity includes Drive ID, MD5 and file size; refresh preserves unchanged metadata and invalidates changed content. Numbered `track - artist - title.opus` filenames give immediate display labels until real tags arrive. Album/category metadata fills as songs are inspected; a complete prebuilt Drive catalog remains a future option for large libraries. No automatic full-library metadata scan or waveform preparation is added.

The now-playing cover clears on selection rather than showing the previous track while loading. The normal player visualization redraws at most 30 times per second; fullscreen visualization retains the normal animation rate. Actual first-play latency still depends on Drive and the connection. Muse replaced the initial 50 files with new Drive IDs, so the old prepared waveforms cannot be reused blindly.

Rollback for this fix: source `9a537718b28ee1e4c905864e4ae1b3546d9fc7ae`, Storage deployment `856140c507f900b0bd8304c1187b63b41f4ec139`. The existing Storage deployment creates its normal pre-upload blob backup. Drive music and Azure federation are unchanged.
