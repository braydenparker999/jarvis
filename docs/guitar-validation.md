# Guitar v1 validation — 21 September 2026

## Release status

Implementation is committed to Jarvis and the frontend is deployed to the
existing Azure Static Web Apps preview. **The production phone workflow is not
accepted or released yet.** The live Cloudflare Worker still returns 404 for
`/guitar/search`. Wrangler has no authenticated account in this environment;
the Cloudflare dashboard presents a persistent browser verification challenge.
The primary Azure Storage release pin has not been advanced.

Deploy the existing Worker using `backend/wrangler.jsonc`, verify real search,
metadata and selected revision requests from the two allowed Jarvis origins,
then repeat the browser downloads against that live backend. Only then advance
`jarvis-release.json` in `braydenparker000/Missionarytube-` and verify the primary
phone URL. No new service, database binding, or persistent Songsterr cache is
needed.

## Checks completed

- `npm run build:guitar`: successful production bundles.
- `npm test`: 89 passing tests, including existing Jarvis behavior and eight
  Guitar API/runtime tests.
- `npm run test:guitar-score`: four passing converter/render tests.
- `npx wrangler deploy --dry-run --config backend/wrangler.jsonc`: successful
  bundle, 51.87 KiB before gzip; existing `HUBS` binding retained.
- Actual first-party Songsterr searches, page metadata and revision CDN JSON
  fetched through the new service functions. The capture script uses curl as
  this environment's transport adapter; production uses Worker fetch.
- Chromium used the actual mobile page and generated real downloaded PDF
  files, using those captured responses through the test harness. This tests
  the complete frontend conversion/download path, **not a live deployed
  backend end-to-end request**.

| Arrangement | Observed result |
| --- | --- |
| Greensleeves / Anonymous, song 1664 | Single guitar selected automatically; 13 measures on one A4 page; notation, tab, 6/8, tempo, repeats and alternate endings visible. |
| Mediterranean Sundance, live Warfield arrangement / Al Di Meola, song 30926 | Al and Paco choices shown; Paco download has 291 measures across 51 A4 pages. First, middle and final pages inspected. Dense passages remain legible; final measure 291 present. The combined 98-page PDF has both complete parts, with Paco's heading on page 48 and measure 291 present in each part. |
| Sultans Of Swing / Dire Straits, song 30084 | Lead guitar PDF downloaded; bends, slides, legato, ghost notes and tuplets visible. The captured lead part contains 54 bends, 82 slides and 109 hammer-on/pull-off flags across 215 measures. |
| Money / Pink Floyd, song 15761 | Selected solo part retains its source rests, section labels, tempo changes and 7/4, 2/4, 4/4 and 6/4 meter data across 162 measures. Intro rests are intentional in this particular part. |

PDF checks used Poppler and PyMuPDF for page size, text/measure inspection and
page images. Score rendering independently checks coverage of every source
master measure. This is not a note-by-note musicological comparison with the
Songsterr player; technique fidelity remains limited by the upstream converter.

## Mobile and failure behavior

The browser harness uses a 390 × 844 CSS viewport, approximately a Galaxy A15.
The actual page had no horizontal overflow at its 375–390 px content width,
including long titles, multiple tracks and enlarged text. This is a browser
viewport test, not a physical Galaxy A15 performance measurement.

Nonsense search, unavailable song page, failed revision retrieval and failed
renderer were exercised. The page showed a useful error and restored controls.
Invalid JSON, revision races, nonsequential part IDs, same-origin canonical
redirects, missing parts, gzip bodies, stalled upstream bodies and generation
deadlines are covered in automated tests. Generation disables its controls
synchronously to prevent repeated taps.

Visual QA exposed and fixed invisible rests, octave display, duplicate section
labels and SVG/PDF baseline differences. An intermediate preview deployment
contained an empty renderer asset due to a publishing-script error; it was
repaired, the served asset was checked against the local SHA-256, and the long
score was downloaded successfully afterward. The deployment workflow now
rejects empty or missing renderer/PDF/font assets before uploading.

The temporary browser harness lives under `tests/` and is served only by
`scripts/dev-guitar.mjs`. Captured Songsterr score data and generated test PDFs
are not part of the repository or public website.
