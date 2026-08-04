import { describe, expect, it } from 'vitest';
import {
  MARK_BOX,
  MARK_SHAPES,
  PLATE_PATH,
  allMarks,
  markSvg,
  markSvgDataUrl,
} from '../../src/core/marks';
import { ENV_KEYS, PALETTE_IDS, PALETTE_SETS, type PaletteId } from '../../src/core/palette';

describe('markSvg', () => {
  it('produces a mark for every environment', () => {
    for (const key of ENV_KEYS) {
      expect(markSvg(key), key).toMatch(/^<svg [^>]*viewBox="0 0 32 32">.*<\/svg>$/s);
    }
  });

  it('fills the plate with the environment colour and draws the shape in its text colour', () => {
    for (const id of PALETTE_IDS) {
      for (const key of ENV_KEYS) {
        const { bg, fg } = PALETTE_SETS[id].colors[key];
        const svg = markSvg(key, id);
        expect(svg, `${id}/${key}`).toContain(`<path d="${PLATE_PATH}" fill="${bg}"/>`);
        expect(svg, `${id}/${key}`).toContain(fg);
      }
    }
  });

  // Without an intrinsic size an SVG renders at the 150px CSS default, which is wrong
  // anywhere a natural size is what gets asked for.
  it('declares an intrinsic size as well as a viewBox', () => {
    for (const key of ENV_KEYS) {
      expect(markSvg(key), key).toContain(`width="${MARK_BOX}" height="${MARK_BOX}"`);
    }
  });

  // The shape is what keeps this readable for anyone who cannot separate the hues, and
  // it is the reason these are paths rather than text in a font that may not resolve.
  it('gives every environment a visually distinct shape', () => {
    const shapes = ENV_KEYS.map((key) => JSON.stringify(MARK_SHAPES[key]));
    expect(new Set(shapes).size).toBe(ENV_KEYS.length);
  });

  it('keeps the geometry identical across palettes, so only colour varies', () => {
    const strip = (svg: string): string => svg.replaceAll(/#[0-9A-F]{6}/g, '');
    for (const key of ENV_KEYS) {
      const variants = PALETTE_IDS.map((id) => strip(markSvg(key, id)));
      expect(new Set(variants).size, key).toBe(1);
    }
  });

  it('falls back to the default palette for a bad id', () => {
    for (const key of ENV_KEYS) {
      expect(markSvg(key, 'nope' as PaletteId)).toBe(markSvg(key, 'default'));
    }
  });

  it('keeps every shape inside the 32 unit box', () => {
    // Any coordinate outside 0..32 would be clipped, which at tab size reads as a shape
    // with a flat side rather than as a bug.
    for (const key of ENV_KEYS) {
      for (const op of MARK_SHAPES[key]) {
        for (const value of op.d.match(/-?\d+(\.\d+)?/g) ?? []) {
          expect(Number(value), `${key} has ${value}`).toBeGreaterThanOrEqual(0);
          expect(Number(value), `${key} has ${value}`).toBeLessThanOrEqual(MARK_BOX);
        }
      }
    }
  });
});

/**
 * The path data is the single source of truth for the shapes: core/marks.ts renders it
 * as `<path d>` and content/mark-canvas.ts feeds the same string to `new Path2D()`. If
 * these strings are not valid SVG path syntax, the SVG degrades visibly while the canvas
 * silently draws nothing, so they are checked directly rather than through either
 * renderer.
 */
describe('mark path data', () => {
  const ALL = [PLATE_PATH, ...ENV_KEYS.flatMap((key) => MARK_SHAPES[key].map((op) => op.d))];

  it('uses only path commands Path2D and SVG both accept', () => {
    for (const d of ALL) {
      expect(d, d).toMatch(/^[MLHVAZ0-9.,\s-]+$/i);
    }
  });

  it('starts with an absolute move and closes', () => {
    for (const d of ALL) {
      expect(d.startsWith('M'), d).toBe(true);
      expect(d.trimEnd().endsWith('Z'), d).toBe(true);
    }
  });

  it('gives stroked shapes a usable width and filled shapes none', () => {
    for (const key of ENV_KEYS) {
      for (const op of MARK_SHAPES[key]) {
        if (op.stroke === undefined) continue;
        expect(op.stroke, key).toBeGreaterThan(1);
        expect(op.stroke, key).toBeLessThan(8);
      }
    }
  });
});

describe('markSvgDataUrl', () => {
  it('is a usable svg data URL', () => {
    for (const key of ENV_KEYS) {
      expect(markSvgDataUrl(key), key).toMatch(/^data:image\/svg\+xml,%3Csvg /);
    }
  });

  // The bug this exists to prevent: every colour starts with '#', which terminates a
  // URL at the first fill and leaves a blank icon.
  it('escapes the characters that would break the URL', () => {
    for (const id of PALETTE_IDS) {
      for (const key of ENV_KEYS) {
        const url = markSvgDataUrl(key, id);
        expect(url, `${id}/${key}`).not.toContain('#');
        expect(url, `${id}/${key}`).not.toContain('<');
        expect(url, `${id}/${key}`).not.toContain('>');
        expect(url, `${id}/${key}`).not.toContain('"');
      }
    }
  });

  it('round trips back to the SVG it came from', () => {
    for (const key of ENV_KEYS) {
      const decoded = decodeURIComponent(markSvgDataUrl(key).replace('data:image/svg+xml,', ''));
      // Attribute quotes are single in the URL form, which is valid XML and avoids
      // escaping every one of them.
      expect(decoded.replaceAll("'", '"')).toBe(markSvg(key));
    }
  });

  it('changes with the palette', () => {
    for (const key of ENV_KEYS) {
      expect(markSvgDataUrl(key, 'vivid')).not.toBe(markSvgDataUrl(key, 'default'));
    }
  });

  // A favicon href over about 8 KB is a sign something has gone wrong, and these are
  // hand-written paths that should be a few hundred bytes.
  it('stays small', () => {
    for (const key of ENV_KEYS) {
      expect(markSvgDataUrl(key).length, key).toBeLessThan(1024);
    }
  });
});

describe('allMarks', () => {
  it('returns one entry per environment', () => {
    const marks = allMarks('muted');
    expect(Object.keys(marks).sort()).toEqual([...ENV_KEYS].sort());
    for (const key of ENV_KEYS) expect(marks[key]).toBe(markSvg(key, 'muted'));
  });
});
