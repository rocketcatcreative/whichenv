/**
 * Rasterises the environment marks to PNG files in public/marks/.
 *
 * Why files at all, rather than the data URL this started as: a page's Content Security
 * Policy applies to its favicon, because favicons go through `img-src`. Any site
 * shipping `img-src 'self'` (which is most production sites) makes Chrome refuse a
 * `data:` favicon outright, in either PNG or SVG form. It logs "Refused to load the
 * image" and shows the site's own icon, so the feature silently did nothing on exactly
 * the sites people care about. Extension resources are exempt from the page's CSP, so
 * the mark has to be a real file behind a `chrome-extension://` URL.
 *
 * Rasterised in a real browser via Path2D, using the SAME path data core/marks.ts uses
 * for the SVG, so there is still one definition of each shape.
 *
 * Committed to the repo like the toolbar icons, and for the same reason: the build must
 * not need a browser. Re-run this ONLY when a palette colour or a mark shape changes:
 *
 *   npm install --no-save playwright && npx playwright install chromium
 *   npm run marks
 *
 * `npm run verify:dist` fails if a mark a palette needs is missing, so a forgotten
 * regeneration cannot ship.
 */

import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV_KEYS, PALETTE_IDS, PALETTE_SETS } from '../src/core/palette.ts';
import { MARK_BOX, MARK_SHAPES, PLATE_PATH, markFileName } from '../src/core/marks.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(root, 'public');
const out = resolve(publicDir, 'marks');

/** Chrome asks for 16 or 32 depending on density; downscaling a 64 beats upscaling. */
const SIZE = 64;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    [
      'FAIL  Playwright is not installed.',
      '',
      '  It is kept out of devDependencies so a normal checkout does not have to',
      '  download a browser. The marks are committed, so you only need this when a',
      '  palette colour or a mark shape has changed:',
      '',
      '    npm install --no-save playwright && npx playwright install chromium',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage();

/** Draws one mark in the browser and returns it as base64 PNG. */
const render = (spec) =>
  page.evaluate(
    ({ plate, shapes, bg, fg, box, size }) => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      context.scale(size / box, size / box);

      context.fillStyle = bg;
      context.fill(new Path2D(plate));

      for (const op of shapes) {
        const path = new Path2D(op.d);
        if (op.stroke === undefined) {
          context.fillStyle = fg;
          context.fill(path);
        } else {
          context.strokeStyle = fg;
          context.lineWidth = op.stroke;
          context.lineJoin = 'miter';
          context.stroke(path);
        }
      }
      return canvas.toDataURL('image/png').split(',')[1];
    },
    spec,
  );

await mkdir(out, { recursive: true });

// Clear first, so a renamed palette or environment cannot leave an orphan behind that
// verify:dist would happily wave through.
for (const entry of await readdir(out).catch(() => [])) {
  if (entry.endsWith('.png')) await rm(resolve(out, entry));
}

let written = 0;
let bytes = 0;

for (const palette of PALETTE_IDS) {
  for (const key of ENV_KEYS) {
    const { bg, fg } = PALETTE_SETS[palette].colors[key];
    const base64 = await render({
      plate: PLATE_PATH,
      shapes: MARK_SHAPES[key].map((op) => ({ ...op })),
      bg,
      fg,
      box: MARK_BOX,
      size: SIZE,
    });
    const buffer = Buffer.from(base64, 'base64');
    await writeFile(resolve(publicDir, markFileName(key, palette)), buffer);
    written += 1;
    bytes += buffer.length;
  }
}

await browser.close();

console.log(
  `OK  public/marks/  ${written} files at ${SIZE}px, ${(bytes / 1024).toFixed(1)} KB total.`,
);
