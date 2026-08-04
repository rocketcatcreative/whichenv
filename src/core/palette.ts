/**
 * Environment colours.
 *
 * Individual colours are NOT editable. The whole point of the indicator is that
 * "amber means staging" becomes muscle memory across every site you work on, and that
 * only holds if the mapping never varies. What you can choose is which SET is in use,
 * globally, and the mapping stays fixed within every set.
 *
 * Anything that does not vary between sets lives in ENV_META: the glyph, the label, the
 * badge code, the meaning. Only the colours vary, which keeps the sets to six lines
 * each and makes it obvious what a new set has to supply.
 *
 * Four rules govern any change here, all enforced by the unit suite:
 *
 *   1. Every bg/fg pair clears WCAG AA (4.5:1).
 *   2. No two environments in a set are perceptually close. STRICT_FLOORS puts that at
 *      CIELAB deltaE 25, and a set may declare its own lower `floors` when it is
 *      deliberately trading separation for something else. `subtle` does.
 *   3. Staging stays well clear of prod, so it cannot read as a second shade of red.
 *      This is the specific mistake the first amber made.
 *   4. Colour is never the only signal. Every environment also has a distinct glyph
 *      and always renders its label as text. Do not remove the glyphs. This is what
 *      lets a set relax rule 2 without becoming unusable.
 *
 * The `deuteranopia` set additionally holds >= 30 separation under simulated
 * deuteranopia, protanopia and tritanopia. The other three cannot: red-for-prod against
 * green-for-local is inherently confusable that way, which is exactly why that set
 * exists.
 */

/** Pipeline order, lowest risk to highest. Drives default display order. */
export const ENV_KEYS = ['local', 'dev', 'staging', 'preview', 'qa', 'prod'] as const;

export type EnvKey = (typeof ENV_KEYS)[number];

/**
 * What a blank group starts with.
 *
 * Production only, and everything else is an add-button. Four prefilled rows made a new group
 * look like a form to complete rather than a thing to build, and most sites do not have all
 * four: someone with just prod and local had to notice they should switch two rows off. One
 * row you must fill, and a row of buttons for what else exists, is a smaller ask.
 *
 * Production rather than local because an unrecognised host is guessed as prod elsewhere too:
 * it puts the red pill on it, which is the safe direction to be wrong in.
 */
export const NEW_GROUP_ENV_KEYS: readonly EnvKey[] = ['prod'];

/**
 * What "create a group from this tab" tries to guess.
 *
 * Deliberately NOT the same list as NEW_GROUP_ENV_KEYS, and this is the whole reason those
 * were split. Guessing is the opposite situation from a blank group: there, prefilled rows are
 * work you did not ask for; here, they are the entire feature. Collapsing these two back into
 * one constant would silently reduce create-from-tab to guessing prod and nothing else.
 */
export const GUESSABLE_ENV_KEYS: readonly EnvKey[] = ['local', 'dev', 'staging', 'prod'];

/**
 * Slots a user can add and rename via `EnvironmentDef.label`, without ever being able to pick
 * a colour. Their ENV_META descriptions say so.
 *
 * Capped deliberately: a group needing more than six environments is a group that should be
 * split in two.
 */
export const CUSTOM_ENV_KEYS: readonly EnvKey[] = ['preview', 'qa'];

/** Everything about an environment that does not depend on the chosen palette. */
export interface EnvMeta {
  /** Shape cue, so hue is never the only thing distinguishing environments. */
  glyph: string;
  /** Default display name, overridable per environment via `label`. */
  label: string;
  /** Three-character code for the toolbar badge, which is too small for the label. */
  badge: string;
  /** Short rationale, surfaced as a tooltip in the options page. */
  meaning: string;
}

export const ENV_META: Readonly<Record<EnvKey, EnvMeta>> = {
  local: {
    glyph: '■', // filled square
    label: 'Local',
    badge: 'LOC',
    meaning: 'Your machine. Nothing you do here can affect anyone else.',
  },
  dev: {
    glyph: '◆', // filled diamond
    label: 'Dev',
    badge: 'DEV',
    meaning: 'Integration environment. Safe to break.',
  },
  staging: {
    glyph: '▲', // filled triangle
    label: 'Staging',
    badge: 'STG',
    meaning: 'Production-like and shared. Others may be relying on it.',
  },
  preview: {
    glyph: '◇', // hollow diamond
    label: 'Preview',
    badge: 'PRV',
    meaning: 'Spare slot. Rename it to whatever your pipeline calls this.',
  },
  qa: {
    glyph: '▣', // square with inner square
    label: 'QA',
    badge: 'QA',
    meaning: 'Spare slot. Rename it to whatever your pipeline calls this.',
  },
  prod: {
    glyph: '●', // filled circle
    label: 'Production',
    badge: 'PRD',
    meaning: 'Real users, real data. Anything you break here is broken for them.',
  },
};

/** The nine colours chrome.tabGroups permits. */
export type TabGroupColor =
  | 'grey'
  | 'blue'
  | 'red'
  | 'yellow'
  | 'green'
  | 'pink'
  | 'purple'
  | 'cyan'
  | 'orange';

export interface EnvColors {
  /** Fill colour of the pill, the badge and the viewport border. */
  bg: string;
  /** Text and glyph colour, paired with bg to clear WCAG AA. */
  fg: string;
  /** Closest match among the nine colours chrome.tabGroups permits. */
  tabGroupColor: TabGroupColor;
}

export const PALETTE_IDS = ['default', 'vivid', 'muted', 'deuteranopia'] as const;

export type PaletteId = (typeof PALETTE_IDS)[number];

/**
 * The perceptual floors a set promises to hold, in CIELAB deltaE.
 *
 * Declared per set rather than fixed globally because one of the sets deliberately
 * trades separation for being unobtrusive. Keeping the floors here means that tradeoff
 * is stated in the set that makes it, and the unit suite still enforces whatever each
 * set claims, so a set cannot quietly get worse than its own promise.
 */
export interface PaletteFloors {
  /** Minimum distance between any two environments. */
  separation: number;
  /** Minimum distance from staging to prod, the pair that matters most. */
  stagingVsProd: number;
}

export const STRICT_FLOORS: Readonly<PaletteFloors> = { separation: 25, stagingVsProd: 40 };

export interface PaletteSet {
  id: PaletteId;
  label: string;
  /** One line shown next to the swatches, explaining who it is for. */
  description: string;
  colors: Readonly<Record<EnvKey, EnvColors>>;
  /** Defaults to STRICT_FLOORS. Only a set that trades separation away overrides it. */
  floors?: Readonly<PaletteFloors>;
}

export const PALETTE_SETS: Readonly<Record<PaletteId, PaletteSet>> = {
  /**
   * The original. Semantic first: red means stop and think, amber means shared, green
   * means safe. Best overall balance of legibility and meaning.
   */
  default: {
    id: 'default',
    label: 'Default',
    description: 'Semantic and calm. Red means stop and think.',
    colors: {
      local: { bg: '#15803D', fg: '#FFFFFF', tabGroupColor: 'green' },
      dev: { bg: '#1D4ED8', fg: '#FFFFFF', tabGroupColor: 'blue' },
      staging: { bg: '#F59E0B', fg: '#1C1917', tabGroupColor: 'orange' },
      preview: { bg: '#A21CAF', fg: '#FFFFFF', tabGroupColor: 'purple' },
      qa: { bg: '#475569', fg: '#FFFFFF', tabGroupColor: 'grey' },
      prod: { bg: '#C62828', fg: '#FFFFFF', tabGroupColor: 'red' },
    },
  },

  /**
   * Same hues, more chroma. The widest separation of any set (50 versus the default's
   * 41), so it is the easiest to read at a glance and the loudest on a busy page.
   */
  vivid: {
    id: 'vivid',
    label: 'Vivid',
    description: 'Brighter and higher contrast. Hardest to miss.',
    colors: {
      local: { bg: '#16A34A', fg: '#1C1917', tabGroupColor: 'green' },
      dev: { bg: '#2563EB', fg: '#FFFFFF', tabGroupColor: 'blue' },
      staging: { bg: '#FBBF24', fg: '#1C1917', tabGroupColor: 'yellow' },
      preview: { bg: '#C026D3', fg: '#FFFFFF', tabGroupColor: 'purple' },
      qa: { bg: '#64748B', fg: '#FFFFFF', tabGroupColor: 'grey' },
      prod: { bg: '#DC2626', fg: '#FFFFFF', tabGroupColor: 'red' },
    },
  },

  /**
   * Barely there. For sitting alongside a design you are actually looking at.
   *
   * The only set that deliberately trades separation for being unobtrusive, and the
   * reason `floors` exists. Chroma is capped around 25 and everything sits high in
   * lightness with dark text, which is what makes it read as a tint rather than a
   * label. That also collapses the perceptual distance between hues: the weakest pair
   * here is about 14 units where the other sets hold 30 or more.
   *
   * That is an accepted tradeoff, not an oversight. Someone who needs guaranteed
   * separation has three other sets, and one of them is built for exactly that. Anyone
   * choosing this one is saying they would rather the indicator stayed quiet, and the
   * glyph and the text label still carry the actual information.
   */
  // Keyed 'muted' though it is labelled Subtle: the id is a stored value, and renaming
  // it would silently reset the setting for anyone already on this set.
  muted: {
    id: 'muted',
    label: 'Subtle',
    description: 'Barely there. Pale tints, for when you are judging a design.',
    floors: { separation: 13, stagingVsProd: 28 },
    colors: {
      local: { bg: '#A3BFA8', fg: '#1C1917', tabGroupColor: 'green' },
      dev: { bg: '#A0B0CC', fg: '#1C1917', tabGroupColor: 'blue' },
      staging: { bg: '#DCC79A', fg: '#1C1917', tabGroupColor: 'yellow' },
      preview: { bg: '#C0A8C8', fg: '#1C1917', tabGroupColor: 'purple' },
      qa: { bg: '#CFCAC4', fg: '#1C1917', tabGroupColor: 'grey' },
      prod: { bg: '#C99AA5', fg: '#1C1917', tabGroupColor: 'red' },
    },
  },

  /**
   * Legible with red-green colour vision deficiency.
   *
   * Not a taste option. Under simulated deuteranopia the default set's prod and local
   * sit only about 10 CIELAB units apart, which is close to indistinguishable.
   *
   * The fix is not to avoid red: it is to stop relying on hue alone. This set spreads
   * the six environments across a very wide LIGHTNESS range (near-white grey, light
   * sky, amber, crimson, violet, near-black navy) so that every pair stays apart even
   * once hue collapses. That leaves prod a real red, which matters: "red means stop and
   * think" is the one association worth keeping. Every pair holds at least 32 units of
   * separation under simulated deuteranopia, protanopia AND tritanopia, versus the
   * default set's 10.
   */
  deuteranopia: {
    id: 'deuteranopia',
    label: 'Colorblind safe',
    description: 'Separated by lightness, not just hue. Readable with color blindness.',
    colors: {
      local: { bg: '#38BDF8', fg: '#1C1917', tabGroupColor: 'cyan' },
      dev: { bg: '#172554', fg: '#FFFFFF', tabGroupColor: 'blue' },
      staging: { bg: '#F59E0B', fg: '#1C1917', tabGroupColor: 'yellow' },
      preview: { bg: '#7E22CE', fg: '#FFFFFF', tabGroupColor: 'purple' },
      qa: { bg: '#A8A29E', fg: '#1C1917', tabGroupColor: 'grey' },
      prod: { bg: '#BE123C', fg: '#FFFFFF', tabGroupColor: 'pink' },
    },
  },
};

export const DEFAULT_PALETTE_ID: PaletteId = 'default';

/** Everything needed to render one environment: metadata plus the active colours. */
export type EnvStyle = EnvMeta & EnvColors;

export function isEnvKey(value: unknown): value is EnvKey {
  return typeof value === 'string' && (ENV_KEYS as readonly string[]).includes(value);
}

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === 'string' && (PALETTE_IDS as readonly string[]).includes(value);
}

export function paletteFor(id: PaletteId | undefined): PaletteSet {
  return PALETTE_SETS[id && isPaletteId(id) ? id : DEFAULT_PALETTE_ID];
}

/**
 * Resolves an environment's full style under a given palette.
 *
 * The palette argument defaults rather than being required, so a caller that genuinely
 * has no settings to hand (an error path, a test) still renders something sensible
 * instead of throwing.
 */
export function styleFor(key: EnvKey, palette: PaletteId = DEFAULT_PALETTE_ID): EnvStyle {
  return { ...ENV_META[key], ...paletteFor(palette).colors[key] };
}

/** Sorts environment keys into canonical pipeline order. */
export function byPipelineOrder(a: EnvKey, b: EnvKey): number {
  return ENV_KEYS.indexOf(a) - ENV_KEYS.indexOf(b);
}

/**
 * WCAG 2.1 relative luminance and contrast ratio.
 *
 * Lives here rather than in a test helper so this file is self checking: the unit suite
 * asserts every pair in every set clears 4.5:1, which stops a future colour tweak from
 * quietly shipping an unreadable pill.
 */
export function relativeLuminance(hex: string): number {
  const normalized = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}
