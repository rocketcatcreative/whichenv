/**
 * Renders the Chrome Web Store promotional tiles.
 *
 * 440x280 small tile, which the store requires, and the optional 1400x560 marquee, which is the
 * only way to be eligible for featured placement.
 *
 * Colours and mark shapes are imported from `src/core/`, not retyped, for the same reason
 * `docs/palette-preview.html` is generated: a promo image showing the wrong red is a promise the
 * product does not keep, and nobody would ever notice.
 *
 * Run:
 *   xvfb-run -a npm run store:tile
 */

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PALETTE_SETS } from '../src/core/palette.ts';
import { MARK_BOX, MARK_SHAPES } from '../src/core/marks.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const OUT = join(root, 'store');
mkdirSync(OUT, { recursive: true });

const SET = PALETTE_SETS.default.colors;

/**
 * The pill's drop shadow, in units that get multiplied by the scale.
 *
 * Declared once so the padding that has to CONTAIN it is computed from the same numbers. Hard
 * coding a padding guess is how the first crop clipped the shadows off the bottom row.
 */
const SHADOW = [
  { y: 1, blur: 2, alpha: 0.28 },
  { y: 4, blur: 12, alpha: 0.16 },
];

/**
 * How far the shadow reaches past the pill's own box, per side.
 *
 * A CSS blur of B extends B/2 beyond the shadow's edge, and the shadow is already displaced
 * downwards by its y offset. So the bottom reach is y + B/2 while the top reach is B/2 - y, and
 * the sides are B/2. Taken across every layer, plus three pixels of slack: a Gaussian
 * approximation has a faint tail past its nominal radius.
 */
function shadowReach(scale) {
  const reach = (fn) => Math.ceil(Math.max(...SHADOW.map(fn)) * scale) + 3;
  return {
    bottom: reach((s) => s.y + s.blur / 2),
    top: reach((s) => Math.max(0, s.blur / 2 - s.y)),
    side: reach((s) => s.blur / 2),
  };
}

/** The pill as it actually renders, at whatever scale the tile needs. */
function pill(envKey, label, scale) {
  const { bg, fg } = SET[envKey];
  // MARK_SHAPES holds an ARRAY of path objects per environment, not a single string. Interpolating
  // the array yields "[object Object]" as a d attribute, which renders nothing at all and looks
  // exactly like a glyph that is simply too small to see.
  const glyph =
    `<svg viewBox="0 0 ${MARK_BOX} ${MARK_BOX}" width="${11 * scale}" height="${11 * scale}" ` +
    `style="flex:none">` +
    MARK_SHAPES[envKey].map((part) => `<path d="${part.d}" fill="${fg}"/>`).join('') +
    `</svg>`;

  return `
    <div style="
      display:flex; align-items:center; gap:${7 * scale}px;
      height:${34 * scale}px; padding:0 ${13 * scale}px 0 ${11 * scale}px;
      background:${bg}; color:${fg};
      border-radius:${999 * scale}px 0 0 ${999 * scale}px;
      font-size:${12 * scale}px; line-height:1; white-space:nowrap;
      box-shadow:${SHADOW.map((s) => `0 ${s.y * scale}px ${s.blur * scale}px rgba(0,0,0,${s.alpha})`).join(', ')};
    ">
      ${glyph}
      <span style="font-weight:650; letter-spacing:.02em">${label}</span>
    </div>`;
}

/**
 * One tile.
 *
 * The composition is the product's own argument: four stacked pills, one per environment, each
 * flush to the right edge the way they sit on a real page. No screenshot of a browser, no device
 * frame, nothing that has to be read at 440px wide.
 */
function tile(width, height) {
  const scale = width / 440;
  // No group name on the pills. Flush to the right edge is how they really sit, so the flat right
  // side reads as correct, but a group name cut off mid-word reads as a broken image.
  const rows = [
    ['local', 'Local'],
    ['dev', 'Dev'],
    ['staging', 'Staging'],
    ['prod', 'Production'],
  ];

  return `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  html,body { margin:0; padding:0; }
  body {
    width:${width}px; height:${height}px; overflow:hidden;
    font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background:#fbfbfa;
    display:grid; grid-template-columns:1fr auto; align-items:center;
  }
</style></head>
<body>
  <div style="padding-left:${34 * scale}px">
    <div style="
      font-size:${30 * scale}px; font-weight:680; letter-spacing:-.025em;
      color:#1c1917; margin-bottom:${9 * scale}px;
    ">WhichEnv</div>
    <div style="
      font-size:${14.5 * scale}px; line-height:1.4; color:#57534e; max-width:${20 * scale}ch;
    ">Know which environment<br />every tab is on.</div>
  </div>
  <div style="display:grid; gap:${9 * scale}px; justify-items:end">
    ${rows.map(([key, label]) => pill(key, label, scale)).join('')}
  </div>
</body></html>`;
}

/**
 * The pill stack on its own, on pure white, cropped to the artwork.
 *
 * For the Rocket Cat site rather than the store. Two variants, because a pill's silhouette only
 * reads as deliberate in the right context:
 *
 *   indicators-white       left aligned, capped both ends. Free standing, so the clean edge is on
 *                          the left where it can line up with body text. The default.
 *   indicators-white-edge  right aligned with a flat right side, exactly how a pill sits against
 *                          the viewport edge in the product. Only looks right when the image
 *                          itself is placed flush against its container's right edge, otherwise
 *                          the flat side reads as a crop that went wrong.
 *
 * Cropped by screenshotting the container element rather than the viewport, so the output is the
 * artwork and nothing else, with no margin to trim by hand.
 */
function stack(scale, edge) {
  const reach = shadowReach(scale);
  const rows = [
    ['local', 'Local'],
    ['dev', 'Dev'],
    ['staging', 'Staging'],
    ['prod', 'Production'],
  ];

  const radius = edge ? `${999 * scale}px 0 0 ${999 * scale}px` : `${999 * scale}px`;

  return `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  html, body { margin:0; padding:0; background:#ffffff; }
  body { font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
  /* Pure white, explicitly, not the off-white the store tiles use. */
  /*
   * Padding sized to contain the drop shadows, so the element crop cannot clip them.
   *
   * The right side is the exception in the edge variant: there the pill is flat and meant to sit
   * against a container's edge, so it has no shadow to show on that side and any padding there
   * would leave a white gutter where the artwork should meet the edge.
   */
  #stack {
    display:inline-grid; gap:${10 * scale}px;
    justify-items:${edge ? 'end' : 'start'};
    background:#ffffff;
    padding:${reach.top}px ${edge ? 0 : reach.side}px ${reach.bottom}px ${reach.side}px;
  }
  #stack > div { border-radius:${radius} !important; }
</style></head>
<body><div id="stack">
  ${rows.map(([key, label]) => pill(key, label, scale)).join('')}
</div></body></html>`;
}

const { chromium } = await import('playwright');
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

try {
  for (const [name, width, height] of [
    ['promo-tile-440x280', 440, 280],
    ['promo-marquee-1400x560', 1400, 560],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(tile(width, height), { waitUntil: 'load' });
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    await page.close();
    console.log(`  ${name}.png`);
  }
  // The website assets. Rendered at deviceScaleFactor 2 so they stay crisp on a retina display
  // at whatever CSS size the page gives them.
  for (const [name, edge] of [
    ['indicators-white', false],
    ['indicators-white-edge', true],
  ]) {
    const page = await browser.newPage({
      viewport: { width: 900, height: 600 },
      deviceScaleFactor: 2,
    });
    await page.setContent(stack(1.6, edge), { waitUntil: 'load' });

    /*
     * Clipped to measured geometry rather than to the element's own box.
     *
     * Two reasons. The element box overshot the widest pill by a fraction of a CSS pixel, which
     * left a two device-pixel strip of shadow tail to the right of a pill that is supposed to be
     * flush with the edge. And in the edge variant the right boundary has to land exactly on the
     * pill's flat side: a gutter there defeats the point, and cropping into the pill would shave
     * its colour.
     */
    const clip = await page.evaluate((flush) => {
      const stack = document.querySelector('#stack').getBoundingClientRect();
      const pills = [...document.querySelectorAll('#stack > div')];
      const right = flush
        ? Math.max(...pills.map((pill) => pill.getBoundingClientRect().right))
        : stack.right;
      return {
        x: stack.left,
        y: stack.top,
        width: right - stack.left,
        height: stack.height,
      };
    }, edge);

    await page.screenshot({ path: join(OUT, `${name}.png`), clip });
    await page.close();
    console.log(`  ${name}.png`);
  }
} finally {
  await browser.close();
}
