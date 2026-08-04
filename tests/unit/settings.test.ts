import { describe, expect, it } from 'vitest';
import {
  CORNERS,
  CORNER_LABELS,
  DEFAULT_FRAME_WIDTH,
  DEFAULT_SETTINGS,
  FRAME_WIDTHS,
  INDICATOR_SIZES,
  INDICATOR_SIZE_LABELS,
  MAX_AUTO_COLLAPSE_MS,
  isCorner,
  isIndicatorSize,
  normalizeFrameWidth,
  normalizeSettings,
} from '../../src/core/settings';

describe('settings', () => {
  it('defaults the indicator to the top right corner', () => {
    expect(DEFAULT_SETTINGS.corner).toBe('tr');
    expect(normalizeSettings(undefined).corner).toBe('tr');
  });

  it('offers exactly the four viewport corners, each with a label', () => {
    expect([...CORNERS]).toEqual(['tl', 'tr', 'bl', 'br']);
    for (const corner of CORNERS) {
      expect(CORNER_LABELS[corner]).toBeTruthy();
    }
    expect(new Set(Object.values(CORNER_LABELS)).size).toBe(CORNERS.length);
  });

  it('recognizes valid corners and rejects anything else', () => {
    for (const corner of CORNERS) expect(isCorner(corner)).toBe(true);
    expect(isCorner('top-right')).toBe(false);
    expect(isCorner('TR')).toBe(false);
    expect(isCorner(null)).toBe(false);
    expect(isCorner(0)).toBe(false);
  });

  // normalizeSettings is the seam that lets every other context read settings
  // without defensive checks, so it has to be total: never throw, never return
  // a partial object.
  describe('normalizeSettings', () => {
    it('returns defaults for anything that is not an object', () => {
      for (const input of [undefined, null, 'tr', 42, true, []]) {
        expect(normalizeSettings(input)).toEqual(DEFAULT_SETTINGS);
      }
    });

    it('keeps valid values', () => {
      const input = {
        schemaVersion: 1,
        corner: 'bl',
        autoCollapseMs: 1500,
        openInNewTabByDefault: true,
        createTabGroupOnNewTab: false,
        paletteId: 'vivid' as const,
        indicatorSize: 'large' as const,
        frameByDefault: true,
        frameWidth: 12 as const,
        tabIconByDefault: true,
        theme: 'dark',
      };
      expect(normalizeSettings(input)).toEqual(input);
    });

    it('falls back per field rather than discarding the whole object', () => {
      const result = normalizeSettings({ corner: 'nope', theme: 'neon', autoCollapseMs: 2000 });
      expect(result.corner).toBe(DEFAULT_SETTINGS.corner);
      expect(result.theme).toBe(DEFAULT_SETTINGS.theme);
      expect(result.autoCollapseMs).toBe(2000);
    });

    it('clamps autoCollapseMs into range and rounds it', () => {
      expect(normalizeSettings({ autoCollapseMs: -500 }).autoCollapseMs).toBe(0);
      expect(normalizeSettings({ autoCollapseMs: 1e9 }).autoCollapseMs).toBe(MAX_AUTO_COLLAPSE_MS);
      expect(normalizeSettings({ autoCollapseMs: 1234.6 }).autoCollapseMs).toBe(1235);
    });

    it('treats 0 as a real value, meaning never collapse', () => {
      expect(normalizeSettings({ autoCollapseMs: 0 }).autoCollapseMs).toBe(0);
    });

    // Regression guard: every one of these coerces to 0 via Number(), which
    // would silently mean "never collapse" instead of falling back.
    it('rejects non-finite and non-numeric collapse values', () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'soon', null, {}, [], '', false, true, '2000']) {
        expect(normalizeSettings({ autoCollapseMs: bad }).autoCollapseMs).toBe(
          DEFAULT_SETTINGS.autoCollapseMs,
        );
      }
    });

    it('does not trust non-boolean values for boolean fields', () => {
      const result = normalizeSettings({
        openInNewTabByDefault: 'yes',
        createTabGroupOnNewTab: 0,
      });
      expect(result.openInNewTabByDefault).toBe(DEFAULT_SETTINGS.openInNewTabByDefault);
      expect(result.createTabGroupOnNewTab).toBe(DEFAULT_SETTINGS.createTabGroupOnNewTab);
    });

    it('drops unknown keys instead of passing them through to storage', () => {
      const result = normalizeSettings({ corner: 'br', wat: 'nope', __proto__: { evil: true } });
      expect(Object.keys(result).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
      expect('wat' in result).toBe(false);
    });

    it('always stamps the current schema version', () => {
      expect(normalizeSettings({ schemaVersion: 99 }).schemaVersion).toBe(1);
    });

    it('is idempotent', () => {
      const once = normalizeSettings({ corner: 'tl', autoCollapseMs: 9999.4 });
      expect(normalizeSettings(once)).toEqual(once);
    });

    it('does not trust non-boolean values for the marker defaults', () => {
      const result = normalizeSettings({ frameByDefault: 'yes', tabIconByDefault: 1 });
      expect(result.frameByDefault).toBe(false);
      expect(result.tabIconByDefault).toBe(false);
    });

    it('rejects an unknown indicator size', () => {
      expect(normalizeSettings({ indicatorSize: 'huge' }).indicatorSize).toBe('normal');
      expect(normalizeSettings({ indicatorSize: 'large' }).indicatorSize).toBe('large');
    });
  });

  describe('indicator size', () => {
    // The whole point of `normal` is that nobody's indicator changes size on upgrade, so
    // this is a guard on the default rather than on the type.
    it('defaults to the size that shipped before the setting existed', () => {
      expect(DEFAULT_SETTINGS.indicatorSize).toBe('normal');
      expect(INDICATOR_SIZES[0]).toBe('normal');
    });

    it('labels every size', () => {
      for (const size of INDICATOR_SIZES) {
        expect(INDICATOR_SIZE_LABELS[size]?.trim().length).toBeGreaterThan(0);
      }
    });

    it('recognizes valid sizes and rejects anything else', () => {
      expect(isIndicatorSize('large')).toBe(true);
      expect(isIndicatorSize('LARGE')).toBe(false);
      expect(isIndicatorSize(undefined)).toBe(false);
      expect(isIndicatorSize(2)).toBe(false);
    });
  });

  describe('frame width', () => {
    it('defaults to the width the frame was hard-coded to', () => {
      expect(DEFAULT_FRAME_WIDTH).toBe(5);
      expect(DEFAULT_SETTINGS.frameWidth).toBe(5);
    });

    it('offers only widths in ascending order, none of them a hairline', () => {
      expect([...FRAME_WIDTHS].sort((a, b) => a - b)).toEqual([...FRAME_WIDTHS]);
      expect(Math.min(...FRAME_WIDTHS)).toBeGreaterThanOrEqual(3);
    });

    it('keeps a width it already offers', () => {
      for (const width of FRAME_WIDTHS) {
        expect(normalizeFrameWidth(width)).toBe(width);
      }
    });

    // Snapping rather than reverting to the default, so a value from a hand-edited storage
    // entry or a newer build still draws something close to what was asked for.
    it('snaps anything else to the nearest offered width', () => {
      expect(normalizeFrameWidth(1)).toBe(3);
      expect(normalizeFrameWidth(4)).toBe(3);
      expect(normalizeFrameWidth(6)).toBe(5);
      expect(normalizeFrameWidth(10)).toBe(8);
      expect(normalizeFrameWidth(40)).toBe(16);
      expect(normalizeFrameWidth(-9)).toBe(3);
    });

    it('falls back to the default for anything that is not a finite number', () => {
      for (const input of [undefined, null, 'five', NaN, Infinity, {}, []]) {
        expect(normalizeFrameWidth(input)).toBe(DEFAULT_FRAME_WIDTH);
      }
    });

    it('normalizes a bad stored width rather than dropping the whole object', () => {
      const result = normalizeSettings({ corner: 'bl', frameWidth: 999 });
      expect(result.frameWidth).toBe(16);
      expect(result.corner).toBe('bl');
    });
  });
});
