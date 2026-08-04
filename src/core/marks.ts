/**
 * Environment marks: the glyphs as vector geometry, for use as a tab favicon.
 *
 * Shapes are stored as SVG path data and nothing else, because that one string feeds
 * both renderers: `<path d="...">` for the preview page, and `new Path2D(d)` on a canvas
 * for the actual favicon. Path2D accepts SVG path syntax, which is what makes a single
 * source of truth possible here instead of the same six shapes written out twice and
 * drifting apart.
 *
 * Why not draw the ENV_META glyph as `<text>`: an icon renders in whatever font the
 * platform resolves, and `■ ◆ ▲ ◇ ▣ ●` are exactly the sort of characters that fall
 * back to a different font, shift off centre, or come out as tofu. At 16 pixels that is
 * the difference between a clear signal and a smudge.
 *
 * Why the favicon that ships is a committed PNG FILE rather than this SVG, or any data
 * URL: a page's Content Security Policy applies to its favicon, because favicons go
 * through `img-src`. Any site shipping `img-src 'self'` makes Chrome refuse a `data:`
 * favicon in either format, log "Refused to load the image", and keep its own icon. The
 * feature therefore did nothing on exactly the sites people care about. Extension
 * resources are exempt from the page's CSP, so the mark is a real file behind a
 * `chrome-extension://` URL. See content/favicon.ts and scripts/make-marks.mjs.
 *
 * Why not composite onto the site's own favicon: the tabs you cannot tell apart are
 * prod, staging and local OF THE SAME SITE, which all carry the SAME favicon. That
 * shared icon is the problem, so keeping it and adding a corner dot solves the wrong
 * half, and a 6px badge on a 16px icon is unreadable anyway.
 */

import { ENV_KEYS, PALETTE_IDS, paletteFor, type EnvKey, type PaletteId } from './palette';

/** The mark is authored in a 32 unit box and scaled to whatever size is asked for. */
export const MARK_BOX = 32;

/** Rounded plate filling the whole box, drawn in the environment's fill colour. */
export const PLATE_PATH =
  'M7 0H25A7 7 0 0 1 32 7V25A7 7 0 0 1 25 32H7A7 7 0 0 1 0 25V7A7 7 0 0 1 7 0Z';

export interface ShapeOp {
  /** SVG path data, in the 32 unit box. */
  d: string;
  /** Stroke width. Absent means fill. */
  stroke?: number;
}

/**
 * One entry per environment, drawn in the foreground colour on top of the plate.
 *
 * Inset to roughly 6..26 so nothing touches the plate edge, since a shape running into
 * the corner reads as a blob rather than as a shape. Coordinates are whole or half units
 * so edges stay predictable when the 32 unit box is scaled to 16.
 */
export const MARK_SHAPES: Readonly<Record<EnvKey, readonly ShapeOp[]>> = {
  /** Filled square. */
  local: [{ d: 'M9 9H23V23H9Z' }],
  /** Filled diamond. */
  dev: [{ d: 'M16 6L26 16L16 26L6 16Z' }],
  /** Filled triangle. */
  staging: [{ d: 'M16 6L27 25H5Z' }],
  /** Hollow diamond. Stroked rather than two stacked fills, so the hole stays plate. */
  preview: [{ d: 'M16 7.5L24.5 16L16 24.5L7.5 16Z', stroke: 3.5 }],
  /** Square within a square. */
  qa: [
    { d: 'M8 8H24V24H8Z', stroke: 3 },
    { d: 'M13.5 13.5H18.5V18.5H13.5Z' },
  ],
  /** Filled circle, as two arcs because a path cannot be a full circle in one. */
  prod: [{ d: 'M25 16A9 9 0 0 1 7 16A9 9 0 0 1 25 16Z' }],
};

/**
 * The environment bar drawn across the bottom of a composited favicon, as a fraction of
 * the icon's height.
 *
 * 0.28 of a 64px render is 18px, which lands as 4 to 5 real pixels at the size Chrome
 * draws a tab icon. Below about 4 it stops reading as a colour at a glance; much above it
 * and it starts eating the part of the icon that identifies the site, which is the whole
 * reason for compositing instead of replacing.
 */
export const BAR_FRACTION = 0.28;

/**
 * One environment mark as a standalone SVG document.
 *
 * Used by the generated palette preview and for anything that wants the mark as an
 * image file. `width` and `height` are set as well as `viewBox` so the SVG has an
 * intrinsic size: without them it renders at the 150px CSS default, which is fine in a
 * page and wrong everywhere an intrinsic size is what gets asked for.
 */
export function markSvg(key: EnvKey, palette?: PaletteId): string {
  const { bg, fg } = paletteFor(palette).colors[key];
  const shapes = MARK_SHAPES[key]
    .map((op) =>
      op.stroke === undefined
        ? `<path d="${op.d}" fill="${fg}"/>`
        : `<path d="${op.d}" fill="none" stroke="${fg}" stroke-width="${op.stroke}"/>`,
    )
    .join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MARK_BOX}" height="${MARK_BOX}" ` +
    `viewBox="0 0 ${MARK_BOX} ${MARK_BOX}">` +
    `<path d="${PLATE_PATH}" fill="${bg}"/>${shapes}</svg>`
  );
}

/**
 * The same mark as an SVG data URL.
 *
 * NOT what the extension puts in a `<link rel="icon">`; see the note at the top. This is
 * for documentation and previews, where an SVG is the better artefact.
 *
 * Encoded rather than raw: an SVG data URL is still a URL, and the `#` starting every
 * colour would otherwise terminate it at the first fill. Only the characters that
 * actually matter are escaped, so the result stays legible in devtools.
 */
export function markSvgDataUrl(key: EnvKey, palette?: PaletteId): string {
  const encoded = markSvg(key, palette)
    .replaceAll('%', '%25')
    .replaceAll('#', '%23')
    .replaceAll('<', '%3C')
    .replaceAll('>', '%3E')
    .replaceAll('"', "'");
  return `data:image/svg+xml,${encoded}`;
}

/**
 * File name for one mark's committed PNG, relative to the extension root.
 *
 * The single place the naming scheme lives, shared by the generator that writes the
 * files, the content script that references them, and the dist check that proves every
 * one a palette needs is actually present.
 */
export function markFileName(key: EnvKey, palette: PaletteId): string {
  return `marks/${palette}-${key}.png`;
}

/** Every file name the extension needs to ship, for the dist check. */
export function allMarkFileNames(): string[] {
  return PALETTE_IDS.flatMap((palette) => ENV_KEYS.map((key) => markFileName(key, palette)));
}

/** Every mark under one palette, for previews and tests. */
export function allMarks(palette?: PaletteId): Record<EnvKey, string> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, markSvg(key, palette)])) as Record<
    EnvKey,
    string
  >;
}
