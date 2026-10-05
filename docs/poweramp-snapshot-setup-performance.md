# Shared-player setup: compact authored-style snapshots

October 5, 2026. Candidate repair based on the V5 downloaded preview's actual
Chrome operation report. Publication, screenshot review and phone acceptance
remain with the release owner.

## Observed bottleneck

The V5 5,000-track report measured synchronous, inclusive shared creation at
514.1 ms on the first mini tap and 442.3 ms on the repeated tap. Thirteen clone
calls accounted for 459.2 ms and 400.9 ms respectively. Held-drag setup took
323.9 ms (293.3 ms cloning), and regrab setup took 212.5 ms (190.9 ms cloning).
Normal paints were usually 0.2–1 ms. The lazy history fix already reduced
release history saves to 0–0.1 ms. These are CI Chrome measurements, not A15
FPS or phone touch latency. Nested operation durations overlap.

The clone path enumerated every computed property for every eligible source
node and generated pseudo, built a long CSS string, then parsed it back into
inline declarations. Native raster icons additionally exposed their large
inline custom `--icon` URL and the resolved mask-image URL in the computed
snapshot. Browser-default properties and inherited custom-variable strings
were repeated across otherwise small controls. The earlier 16-property fake
DOM could count calls but could not represent this serialization/parse cost.

## Candidate change

A scene-local usage plan reads the actual document stylesheets, including
nested/imported and adopted rules. Each source receives the properties authored
by its matching rules plus source inline declarations. Ancestor property names
are carried conservatively to descendants to preserve inherited font/color
and other appearance. The values are always the source's current computed
values, not raw authored expressions. There is no handwritten paint whitelist.

Authored shorthand and vendor aliases are expanded by the browser's CSSOM
using `initial`, against its complete computed-property inventory. This avoids
empty computed shorthand values when different longhands cannot be serialized
as one shorthand (such as unequal borders). Before/after declarations belong
to their originating source's property vocabulary. Other pseudo types are
conservative global entries. Properties immediately overridden by the existing
clone's disabled animation/transition/pointer policy are omitted.

Resolved longhands already freeze custom variables' used values. Unused
custom variables are omitted, avoiding duplicate normal native-icon payloads.
Class rules and real pseudos survive clone ID removal: only variables referenced
by matching pseudo or !important declarations are retained at their computed
values. This preserves local pseudo/important paint and missing-variable
fallbacks without serializing the whole inherited schema. Source classes, tags, attributes, generated spans, geometry,
canvas copies and dynamic artwork/seek/play refreshes keep their existing
owners and behavior. IDs are still removed and clones remain inert and hidden
from accessibility.

The plan and appearance cache live only for one clone group/scene. Every new
scene rereads CSSOM declarations and source inline values; no persistent cache
needs speculative theme, class, artwork, inline, resize or stylesheet-edit
invalidation. An unreadable stylesheet, absent stylesheet API, or uncertain
selector match retains the previous exhaustive snapshot path.

## Checks and remaining evidence

- All 389 non-browser Poweramp checks passed locally, including compact
  vocabulary, shorthand expansion, inline/CSSOM changes, live pseudo/important
  local variables, missing-variable fallbacks and exhaustive fallback
- The existing actual-runtime checks still cover accepted geometry, suppression,
  native pseudo reconstruction, inertness, pointer ownership, transparent
  canvases, artwork/seek updates, cleanup and unchanged settle durations
- A new mandatory Chrome suite compares every standard computed property of
  actual compact clones with the exhaustive baseline across the real full/mini
  surfaces, art, labels, buttons, seeks and backdrop in dark/light themes
- That renderer suite also checks actual native masks, generated spans and live clone pseudos,
  checks local class-pseudo/important mask and color variables, discovers new
  CSSOM/inline properties, and records property-read and CSS-text
  reductions in snapshot-parity-dark/light JSON artifacts
- Existing downloaded-preview trusted first/repeated tap, held drag and regrab
  profiling measures the end-to-end setup result at 60 and 5,000 tracks

Local Chromium was not relaunched after the verified environment EPERM blocker.
The new renderer checks and after timings must run in the release owner's
browser CI before any speedup or visual-parity claim. Screenshot review and
phone acceptance are still required. No merge or production deploy is implied.
