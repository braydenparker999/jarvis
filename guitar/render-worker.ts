import { parse } from 'opentype.js';
import { renderScore } from './render-score';

// Turn SMuFL music glyphs into vector paths. PDFs then need no external music
// font, and rests, flags, clefs and techniques cannot turn into missing glyphs.
export function outlineMusic(svg, font, baseSize) {
  return svg.replace(/<g transform="([^"]+)" class="at"\s*><text([^>]*)>(.*?)<\/text><\/g>/g, (_, transform, attrs, entities) => {
    const chars = entities.replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)));
    const percent = Number(attrs.match(/font-size:\s*([\d.]+)%/)?.[1] || 100);
    const size = baseSize * percent / 100;
    const x = attrs.includes('text-anchor="middle"') ? -font.getAdvanceWidth(chars, size) / 2 : 0;
    const path = font.getPath(chars, x, 0, size).toPathData(3);
    const fill = attrs.match(/fill="([^"]+)"/)?.[1] || '#000000';
    return `<g transform="${transform}"><path d="${path}" fill="${fill}"/></g>`;
  });
}
self.onmessage = async ({ data }) => {
  try {
    const r = await fetch(new URL('./vendor/Bravura.otf', self.location.href), { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw Error('Notation font unavailable');
    const font = parse(await r.arrayBuffer());
    const result = renderScore(data);
    for (const system of result.systems) system.svg = outlineMusic(system.svg, font, result.musicFontSize);
    self.postMessage({ ok: true, ...result });
  } catch { self.postMessage({ ok: false }); }
};
