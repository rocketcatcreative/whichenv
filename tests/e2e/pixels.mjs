/**
 * Reads a rendered pixel out of a Playwright screenshot.
 *
 * Needed because the indicator lives in a CLOSED shadow root: no selector reaches
 * inside it and `getComputedStyle` cannot see it, which is the entire point of it
 * being closed. For a feature whose whole job is "a colour appears on screen", the
 * only honest assertion left is to look at the screen.
 *
 * Decoding is deliberately minimal rather than pulling in a PNG library: Chromium
 * emits 8-bit non-interlaced PNGs, so this handles exactly that and throws on
 * anything else instead of guessing.
 */

import { inflateSync } from 'node:zlib';

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function decode(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let offset = 8;
  let header = null;
  const data = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }

    offset += 12 + length;
  }

  if (!header) throw new Error('PNG has no IHDR');
  if (header.depth !== 8) throw new Error(`unsupported bit depth ${header.depth}`);
  if (header.interlace !== 0) throw new Error('interlaced PNG is not supported');

  const channels = CHANNELS[header.colorType];
  if (!channels) throw new Error(`unsupported colour type ${header.colorType}`);

  const raw = inflateSync(Buffer.concat(data));
  const stride = header.width * channels;
  const out = Buffer.alloc(header.height * stride);

  // Undo the per-scanline filters. Each row is prefixed with its filter type, and
  // filters reference the pixel to the left (a) and the row above (b).
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = (y * (stride + 1)) + 1;
    const dst = y * stride;

    for (let i = 0; i < stride; i += 1) {
      const x = raw[src + i];
      const a = i >= channels ? out[dst + i - channels] : 0;
      const b = y > 0 ? out[dst + i - stride] : 0;
      const c = i >= channels && y > 0 ? out[dst + i - stride - channels] : 0;

      let value;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: {
          // Paeth: pick whichever neighbour the gradient predictor lands closest to.
          const p = a + b - c;
          const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
      out[dst + i] = value & 0xff;
    }
  }

  return { ...header, channels, pixels: out, stride };
}

const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();

/** The colour at one viewport coordinate, as '#RRGGBB'. */
export async function pixelAt(page, x, y) {
  const image = decode(await page.screenshot({ clip: { x, y, width: 1, height: 1 } }));
  const [r, g, b] = image.pixels;
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Whether two colours are within `tolerance` per channel.
 *
 * Screenshots are not guaranteed to be byte-exact: subpixel positioning and any
 * compositing on the way to the framebuffer can shift a channel by one or two, so
 * asserting equality would produce a flaky test that means nothing.
 */
export function near(actual, expected, tolerance = 4) {
  const parse = (value) =>
    [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const [a, b] = [parse(actual), parse(expected)];
  return a.every((channel, i) => Math.abs(channel - b[i]) <= tolerance);
}
