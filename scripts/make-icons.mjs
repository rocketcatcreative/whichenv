/**
 * Generates the extension icons.
 *
 * The mark is three left-aligned bars of increasing width in local green, staging
 * amber and production red: a stack of environments growing toward the one that
 * matters most. It borrows the pill's own shape language, so the toolbar and the page
 * indicator read as the same product.
 *
 * Three constraints drove the design, and they are worth keeping if it is ever redrawn:
 *
 *  1. **It has to survive 16px.** Thin horizontal strokes are the first thing to turn
 *     to mush when downsampled, so the bars are deliberately thick with generous gaps,
 *     and everything is rendered at 8x then reduced with Lanczos.
 *  2. **Chrome's badge covers the bottom.** With `LOC` or `PRD` shown, roughly the
 *     bottom 40% is obscured, so the mark sits above centre rather than centred.
 *  3. **It sits on light and dark toolbars.** The near-black plate works on both, which
 *     a light plate would not.
 *
 * Requires Python with Pillow. Run: npm run icons
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'public/icons');
const storeOut = resolve(root, 'store');
mkdirSync(out, { recursive: true });
mkdirSync(storeOut, { recursive: true });

const python = `
from PIL import Image, ImageDraw
import os

OUT = ${JSON.stringify(out)}
STORE_OUT = ${JSON.stringify(storeOut)}

# Straight from src/core/palette.ts. If those change, change these.
GREEN = (21, 128, 61)
AMBER = (245, 158, 11)
RED = (198, 40, 40)
PLATE = (28, 25, 23)

SUPERSAMPLE = 8

# Bars grow toward production, the one that matters most.
BARS = [(GREEN, 0.42), (AMBER, 0.64), (RED, 0.86)]

BAR_THICKNESS = 0.135   # of the icon edge
BAR_GAP = 0.075
SIDE_PAD = 0.19
# Lifts the mark clear of Chrome's badge, which covers the bottom of the icon.
TOP_BIAS = 0.085
CORNER = 0.22


def draw(size):
    s = size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * CORNER), fill=PLATE + (255,))

    thickness = s * BAR_THICKNESS
    gap = s * BAR_GAP
    total = len(BARS) * thickness + (len(BARS) - 1) * gap
    y = (s - total) / 2 - s * TOP_BIAS
    x0 = s * SIDE_PAD
    span = s - 2 * x0

    for color, width in BARS:
        d.rounded_rectangle(
            [x0, y, x0 + span * width, y + thickness],
            radius=thickness / 2,
            fill=color + (255,),
        )
        y += thickness + gap

    return img.resize((size, size), Image.LANCZOS)


for size in (16, 32, 48, 128):
    draw(size).save(os.path.join(OUT, f"{size}.png"))
    print(f"  wrote {size}.png")

# The large one goes to store/, not into the package. The listing icon is uploaded
# separately from the extension, so shipping a 512 inside the zip is pure weight.
draw(512).save(os.path.join(STORE_OUT, "icon-512.png"))
print("  wrote store/icon-512.png")
`;

const result = spawnSync('python3', ['-c', python], { stdio: 'inherit' });
if (result.status !== 0) {
  console.error('FAIL  icon generation needs Python with Pillow (pip install Pillow)');
  process.exit(result.status ?? 1);
}
console.log('OK  icons written to public/icons/');
