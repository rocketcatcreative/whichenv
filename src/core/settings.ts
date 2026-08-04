/**
 * Global extension settings.
 *
 * These apply everywhere, across every group. The indicator corner in
 * particular is deliberately NOT per group: you build a habit of glancing at one
 * spot on the screen, and that habit is worth more than the flexibility of
 * moving it per site. Per group, you can only hide the indicator entirely.
 *
 * Stored under a single `settings` key in chrome.storage.sync. Groups get one key
 * each; settings are small enough to stay in one item well inside the 8 KB per
 * item limit.
 */

import { DEFAULT_PALETTE_ID, isPaletteId, type PaletteId } from './palette';

export const SETTINGS_KEY = 'settings';

/** Viewport corner, as top/bottom + left/right. */
export const CORNERS = ['tl', 'tr', 'bl', 'br'] as const;

export type Corner = (typeof CORNERS)[number];

export const CORNER_LABELS: Readonly<Record<Corner, string>> = {
  tl: 'Top left',
  tr: 'Top right',
  bl: 'Bottom left',
  br: 'Bottom right',
};

export type Theme = 'auto' | 'light' | 'dark';

/**
 * How big the pill is.
 *
 * Global, for the same reason the corner is: the argument for a fixed spot on the
 * screen applies just as well to a fixed size. `normal` is exactly what shipped
 * before this setting existed, so nobody's indicator changes size on upgrade.
 */
export const INDICATOR_SIZES = ['normal', 'large'] as const;

export type IndicatorSize = (typeof INDICATOR_SIZES)[number];

export const INDICATOR_SIZE_LABELS: Readonly<Record<IndicatorSize, string>> = {
  normal: 'Normal',
  large: 'Large',
};

/**
 * Frame widths on offer, in CSS pixels.
 *
 * A fixed set rather than a number input. A frame is a signal, not a design
 * surface: 1px is invisible on a busy page and 40px is a picture mount. Five
 * choices cover "just noticeable" through "cannot possibly miss it", and every one
 * of them is a value the corner-offset arithmetic has been checked against.
 */
export const FRAME_WIDTHS = [3, 5, 8, 12, 16] as const;

export type FrameWidth = (typeof FRAME_WIDTHS)[number];

/** Unchanged from the hard-coded width the frame shipped with. */
export const DEFAULT_FRAME_WIDTH: FrameWidth = 5;

export interface Settings {
  schemaVersion: 1;
  /**
   * Where the indicator sits, for every group.
   *
   * Defaults to top right: it is the most noticeable corner on a typical page,
   * and it is far less likely to collide with the things sites habitually pin to
   * the bottom of the viewport (cookie banners, chat widgets, toasts).
   */
  corner: Corner;
  /** Milliseconds before the expanded pill collapses. 0 disables collapsing. */
  autoCollapseMs: number;
  /** Whether selecting an environment opens a new tab instead of replacing. */
  openInNewTabByDefault: boolean;
  /** Whether new-tab switches are gathered into a Chrome tab group. */
  createTabGroupOnNewTab: boolean;
  /**
   * Which colour set is in use, globally.
   *
   * Global rather than per group on purpose: the value of the indicator is that
   * "amber means staging" is the same everywhere, so the mapping cannot vary between
   * sites. Choosing a different SET keeps the mapping fixed and only changes how it
   * looks. Individual colours are still not editable.
   */
  paletteId: PaletteId;
  /** How big the pill is, everywhere. */
  indicatorSize: IndicatorSize;
  /**
   * Whether groups frame the viewport unless they say otherwise.
   *
   * Off by default. A frame on every site you have a group for is just a border, and
   * a border that is always there stops being a signal.
   */
  frameByDefault: boolean;
  /** How thick that frame is, when a group draws one. */
  frameWidth: FrameWidth;
  /**
   * Whether groups mark the tab icon unless they say otherwise.
   *
   * Off by default, and more cautiously than the frame: the tab icon belongs to the
   * site, so taking it over is something to opt into rather than inherit.
   */
  tabIconByDefault: boolean;
  theme: Theme;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  schemaVersion: 1,
  corner: 'tr',
  autoCollapseMs: 4000,
  openInNewTabByDefault: false,
  createTabGroupOnNewTab: true,
  paletteId: DEFAULT_PALETTE_ID,
  indicatorSize: 'normal',
  frameByDefault: false,
  frameWidth: DEFAULT_FRAME_WIDTH,
  tabIconByDefault: false,
  theme: 'auto',
};

/** Upper bound on autoCollapseMs. Beyond a minute, use 0 (never) instead. */
export const MAX_AUTO_COLLAPSE_MS = 60_000;

export function isCorner(value: unknown): value is Corner {
  return typeof value === 'string' && (CORNERS as readonly string[]).includes(value);
}

function isTheme(value: unknown): value is Theme {
  return value === 'auto' || value === 'light' || value === 'dark';
}

export function isIndicatorSize(value: unknown): value is IndicatorSize {
  return typeof value === 'string' && (INDICATOR_SIZES as readonly string[]).includes(value);
}

/**
 * Snaps any number to the nearest offered frame width.
 *
 * Snapping rather than rejecting, because the plausible ways a bad value gets here are
 * a hand-edited storage entry and a future build that offers a width this one does not.
 * Both are better served by the closest thing we can draw than by silently reverting to
 * the default, which would read as the setting not sticking.
 */
export function normalizeFrameWidth(value: unknown): FrameWidth {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_FRAME_WIDTH;
  return FRAME_WIDTHS.reduce((best, candidate) =>
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best,
  );
}

/**
 * Coerces whatever is in storage into a valid Settings object.
 *
 * Pure and total: it never throws and never returns a partial object. Anything
 * unrecognised falls back to its default. This is the seam that makes settings
 * safe to read from a content script without defensive checks at every use, and
 * it is where schema migrations will land.
 */
export function normalizeSettings(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };
  const input = raw as Partial<Record<keyof Settings, unknown>>;

  // Must be a real number, not merely coercible to one. `Number(null)`,
  // `Number('')`, `Number([])` and `Number(false)` are all 0, which would
  // silently turn a corrupt value into "never collapse" rather than falling back
  // to the default.
  const autoCollapse = input.autoCollapseMs;
  const hasValidCollapse = typeof autoCollapse === 'number' && Number.isFinite(autoCollapse);

  return {
    schemaVersion: 1,
    corner: isCorner(input.corner) ? input.corner : DEFAULT_SETTINGS.corner,
    autoCollapseMs: hasValidCollapse
      ? Math.min(Math.max(Math.round(autoCollapse), 0), MAX_AUTO_COLLAPSE_MS)
      : DEFAULT_SETTINGS.autoCollapseMs,
    openInNewTabByDefault:
      typeof input.openInNewTabByDefault === 'boolean'
        ? input.openInNewTabByDefault
        : DEFAULT_SETTINGS.openInNewTabByDefault,
    createTabGroupOnNewTab:
      typeof input.createTabGroupOnNewTab === 'boolean'
        ? input.createTabGroupOnNewTab
        : DEFAULT_SETTINGS.createTabGroupOnNewTab,
    paletteId: isPaletteId(input.paletteId) ? input.paletteId : DEFAULT_SETTINGS.paletteId,
    indicatorSize: isIndicatorSize(input.indicatorSize)
      ? input.indicatorSize
      : DEFAULT_SETTINGS.indicatorSize,
    frameByDefault:
      typeof input.frameByDefault === 'boolean'
        ? input.frameByDefault
        : DEFAULT_SETTINGS.frameByDefault,
    frameWidth:
      input.frameWidth === undefined
        ? DEFAULT_SETTINGS.frameWidth
        : normalizeFrameWidth(input.frameWidth),
    tabIconByDefault:
      typeof input.tabIconByDefault === 'boolean'
        ? input.tabIconByDefault
        : DEFAULT_SETTINGS.tabIconByDefault,
    theme: isTheme(input.theme) ? input.theme : DEFAULT_SETTINGS.theme,
  };
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

/** Merges a patch over current settings and persists the result. */
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalizeSettings({ ...(await getSettings()), ...patch });
  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * Subscribes to settings changes. Returns an unsubscribe function.
 *
 * Fires in every context that has the extension loaded, including content
 * scripts, which is what lets the indicator move corners without a page reload.
 */
export function onSettingsChanged(listener: (settings: Settings) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'sync' || !(SETTINGS_KEY in changes)) return;
    listener(normalizeSettings(changes[SETTINGS_KEY]?.newValue));
  };

  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
