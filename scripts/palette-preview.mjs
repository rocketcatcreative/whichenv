/**
 * Regenerates docs/palette-preview.html from the real palette sets.
 *
 * The previous version of that file was hand-written during the staging-colour
 * decision and went stale the moment the colours changed, which is the worst kind of
 * design doc: authoritative-looking and wrong. This imports src/core/palette.ts, so it
 * cannot disagree with what ships.
 *
 * What it adds over the options page (which shows the ACTIVE set, live) is the four
 * sets side by side, each simulated under three forms of colour vision deficiency, with
 * the measured numbers next to them. That is the view you want when judging a set or
 * adding a new one, and it is also where the Chrome Web Store screenshots come from.
 *
 *   npm run palette:preview
 *
 * Node imports the TypeScript directly (type stripping, Node 22+), so there is no build
 * step and no second copy of the colours. `scripts/ts-resolve.mjs` supplies the one
 * thing Node will not do by itself, which is resolve the extensionless relative imports
 * `src/` uses; run this via `npm run palette:preview` rather than bare node.
 */

import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENV_KEYS,
  ENV_META,
  PALETTE_IDS,
  PALETTE_SETS,
  contrastRatio,
} from '../src/core/palette.ts';
import { markSvg } from '../src/core/marks.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'docs/palette-preview.html');

// ------------------------------------------------------------------ colour maths
// Duplicated from tests/unit/palette.test.ts on purpose: this is a throwaway reporting
// script, and importing test internals to build a doc would couple the two for no gain.

const toLinear = (hex) =>
  [0, 2, 4].map((offset) => {
    const value = Number.parseInt(hex.slice(1).slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  });

function toLab(hex) {
  const [r, g, b] = toLinear(hex);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function deltaE(a, b) {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Machado, Oliveira and Fernandes (2009), full severity, applied in linear RGB. */
const CVD = {
  Deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  Protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  Tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

function simulate(hex, kind) {
  const linear = toLinear(hex);
  const channels = CVD[kind].map((row) =>
    Math.min(1, Math.max(0, row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2])),
  );
  return `#${channels
    .map((value) => {
      const encoded =
        value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
      return Math.round(encoded * 255).toString(16).padStart(2, '0').toUpperCase();
    })
    .join('')}`;
}

/** Text colour that reads on a simulated fill, since the real fg is simulated too. */
const readableOn = (hex) => (contrastRatio('#FFFFFF', hex) >= contrastRatio('#1C1917', hex)
  ? '#FFFFFF'
  : '#1C1917');

const PAIRS = ENV_KEYS.flatMap((a, i) => ENV_KEYS.slice(i + 1).map((b) => [a, b]));

const minSeparation = (colors, kind) =>
  Math.min(
    ...PAIRS.map(([a, b]) =>
      kind
        ? deltaE(simulate(colors[a].bg, kind), simulate(colors[b].bg, kind))
        : deltaE(colors[a].bg, colors[b].bg),
    ),
  );

// ------------------------------------------------------------------------ render

const escape = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const pill = (bg, fg, key) =>
  `<span class="pill" style="background:${bg};color:${fg}"><b>${ENV_META[key].glyph}</b>${escape(
    ENV_META[key].label.toUpperCase(),
  )}</span>`;

function sectionFor(id) {
  const set = PALETTE_SETS[id];
  const { colors } = set;

  const stats = [
    `min separation <b>${minSeparation(colors).toFixed(0)}</b>`,
    `staging vs prod <b>${deltaE(colors.staging.bg, colors.prod.bg).toFixed(0)}</b>`,
    `lowest contrast <b>${Math.min(
      ...ENV_KEYS.map((key) => contrastRatio(colors[key].fg, colors[key].bg)),
    ).toFixed(2)}:1</b>`,
  ];

  const rows = [
    `<div class="row"><span class="lbl">Normal vision</span>${ENV_KEYS.map((key) =>
      pill(colors[key].bg, colors[key].fg, key),
    ).join('')}</div>`,
    ...Object.keys(CVD).map((kind) => {
      const worst = minSeparation(colors, kind);
      return `<div class="row cvd"><span class="lbl">${kind}<em>min ${worst.toFixed(
        0,
      )}</em></span>${ENV_KEYS.map((key) => {
        const bg = simulate(colors[key].bg, kind);
        return pill(bg, readableOn(bg), key);
      }).join('')}</div>`;
    }),
    `<div class="row"><span class="lbl">Collapsed edge</span><span class="tabs">${ENV_KEYS.map(
      (key) => `<span class="tab" style="background:${colors[key].bg}"></span>`,
    ).join('')}</span></div>`,
    `<div class="row"><span class="lbl">Tab marks</span><span class="marks">${ENV_KEYS.map(
      (key) => `<span class="mark">${markSvg(key, id)}</span>`,
    ).join('')}</span></div>`,
    `<div class="row"><span class="lbl">Tab groups</span><span class="chrome">${ENV_KEYS.map(
      (key) => `<span class="tg">${escape(colors[key].tabGroupColor)}</span>`,
    ).join('')}</span></div>`,
  ];

  return `<section><h2>${escape(set.label)} <code>${escape(id)}</code></h2>
<p class="note">${escape(set.description)}</p>
<p class="stats">${stats.join(' &nbsp;·&nbsp; ')}</p>
${rows.join('\n')}
<details><summary>Hex values</summary><table>${ENV_KEYS.map(
    (key) =>
      `<tr><td>${escape(ENV_META[key].label)}</td><td><code>${colors[key].bg}</code></td><td><code>${
        colors[key].fg
      }</code></td><td>${contrastRatio(colors[key].fg, colors[key].bg).toFixed(2)}:1</td></tr>`,
  ).join('')}</table></details>
</section>`;
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>WhichEnv colour sets</title>
<style>
:root { color-scheme: light dark }
body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  margin: 0; padding: 40px; background: light-dark(#fbfbfa, #18181b); color: light-dark(#1c1917, #e7e5e4) }
h1 { font-size: 22px; margin: 0 0 6px }
.sub { color: light-dark(#78716c, #a1a1aa); margin: 0 0 8px; max-width: 74ch }
.generated { color: light-dark(#a8a29e, #71717a); font-size: 12px; margin: 0 0 30px }
section { background: light-dark(#fff, #232326); border: 1px solid light-dark(#e7e5e4, #3f3f46);
  border-radius: 12px; padding: 20px 22px; margin-bottom: 18px }
h2 { font-size: 15px; font-weight: 650; margin: 0 0 4px }
h2 code { font-size: 11.5px; font-weight: 450; color: light-dark(#a8a29e, #71717a) }
.note { font-size: 13px; color: light-dark(#78716c, #a1a1aa); margin: 0 0 6px }
.stats { font-size: 12px; color: light-dark(#78716c, #a1a1aa); margin: 0 0 18px }
.stats b { font-variant-numeric: tabular-nums }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 9px }
.cvd { margin-bottom: 7px }
.lbl { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em;
  color: light-dark(#a8a29e, #71717a); width: 108px; flex: none; line-height: 1.3 }
.lbl em { display: block; font-style: normal; letter-spacing: 0; text-transform: none;
  font-variant-numeric: tabular-nums }
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px 6px 9px;
  border-radius: 999px; font-size: 11px; font-weight: 650; letter-spacing: .02em;
  box-shadow: 0 1px 3px rgba(0,0,0,.22) }
.pill b { font-size: 9px; line-height: 1 }
.tabs, .chrome, .marks { display: flex; gap: 10px; align-items: center }
/* Rendered at the size Chrome actually draws a favicon, since that is the only size
   worth judging these at. */
.mark svg { display: block; width: 16px; height: 16px }
.tab { display: block; width: 9px; height: 30px; border-radius: 5px 0 0 5px;
  box-shadow: 0 1px 3px rgba(0,0,0,.22) }
.tg { font-size: 11px; color: light-dark(#78716c, #a1a1aa);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace }
details { margin-top: 14px; font-size: 12px }
summary { cursor: pointer; color: light-dark(#78716c, #a1a1aa) }
table { border-collapse: collapse; margin-top: 8px }
td { padding: 2px 14px 2px 0; font-variant-numeric: tabular-nums }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px }
</style></head><body>
<h1>WhichEnv colour sets</h1>
<p class="sub">The four selectable sets, each shown as the pills would render, then
simulated under three forms of colour vision deficiency. Separation figures are CIELAB
deltaE across every pair of environments; the unit suite enforces 25 for normal vision,
40 between staging and prod, and 30 under all three simulations for the colourblind-safe
set. Individual colours are not editable, by design: only the set can be changed.</p>
<p class="generated">Generated from src/core/palette.ts by scripts/palette-preview.mjs.
Do not edit by hand; run <code>npm run palette:preview</code>.</p>
${PALETTE_IDS.map(sectionFor).join('\n')}
</body></html>
`;

await writeFile(out, html);
console.log(`OK  docs/palette-preview.html  ${PALETTE_IDS.length} sets, ${ENV_KEYS.length} environments each.`);
