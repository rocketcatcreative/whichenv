import { describe, expect, it } from 'vitest';
import {
  CUSTOM_ENV_KEYS,
  DEFAULT_PALETTE_ID,
  GUESSABLE_ENV_KEYS,
  NEW_GROUP_ENV_KEYS,
  ENV_KEYS,
  ENV_META,
  PALETTE_IDS,
  PALETTE_SETS,
  STRICT_FLOORS,
  byPipelineOrder,
  contrastRatio,
  isEnvKey,
  isPaletteId,
  paletteFor,
  styleFor,
  type EnvKey,
  type PaletteId,
} from '../../src/core/palette';

const TAB_GROUP_COLORS = new Set([
  'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange',
]);

/** Every pair of environment keys, once each. */
function pairs(): [EnvKey, EnvKey][] {
  const out: [EnvKey, EnvKey][] = [];
  for (let i = 0; i < ENV_KEYS.length; i += 1) {
    for (let j = i + 1; j < ENV_KEYS.length; j += 1) {
      out.push([ENV_KEYS[i]!, ENV_KEYS[j]!]);
    }
  }
  return out;
}

describe('environment metadata', () => {
  it('has an entry for every environment key, and no extras', () => {
    for (const key of ENV_KEYS) expect(ENV_META[key]).toBeDefined();
    expect(Object.keys(ENV_META)).toHaveLength(ENV_KEYS.length);
  });

  // Colour must never be the only signal, for colourblind users and for anyone
  // glancing at a greyscale screenshot. This is why the glyphs live outside the sets:
  // a new palette cannot accidentally drop them.
  it('gives every environment a distinct glyph, label and badge', () => {
    for (const field of ['glyph', 'label', 'badge'] as const) {
      const values = ENV_KEYS.map((key) => ENV_META[key][field]);
      expect(new Set(values).size, field).toBe(values.length);
      for (const value of values) expect(value.trim().length, field).toBeGreaterThan(0);
    }
  });

  // The badge is drawn in a very small space on the toolbar icon.
  it('keeps badge codes short enough for the toolbar', () => {
    for (const key of ENV_KEYS) {
      expect(ENV_META[key].badge.length, key).toBeLessThanOrEqual(3);
    }
  });

  // Three lists over the same six keys, each answering a different question. They were one
  // constant until a blank group stopped starting with four environments, at which point
  // sharing them would have silently reduced create-from-tab to guessing prod alone.
  it('starts a blank group with production alone', () => {
    expect(NEW_GROUP_ENV_KEYS).toEqual(['prod']);
  });

  it('guesses the four common environments from a tab', () => {
    expect(GUESSABLE_ENV_KEYS).toEqual(['local', 'dev', 'staging', 'prod']);
  });

  it('accounts for every key between the guessable ones and the spare slots', () => {
    expect([...GUESSABLE_ENV_KEYS, ...CUSTOM_ENV_KEYS].sort()).toEqual([...ENV_KEYS].sort());
  });

  it('only ever starts a group with something it would also guess', () => {
    for (const key of NEW_GROUP_ENV_KEYS) expect(GUESSABLE_ENV_KEYS).toContain(key);
  });

  it('describes both spare slots as spare, since nothing else labels them now', () => {
    for (const key of CUSTOM_ENV_KEYS) {
      expect(ENV_META[key].meaning.toLowerCase(), key).toContain('spare slot');
    }
  });

  it('orders environments from lowest risk to highest', () => {
    expect(ENV_KEYS.indexOf('local')).toBeLessThan(ENV_KEYS.indexOf('prod'));
    expect([...GUESSABLE_ENV_KEYS].reverse().sort(byPipelineOrder)).toEqual([
      'local', 'dev', 'staging', 'prod',
    ]);
  });

  it('recognizes valid keys and rejects anything else', () => {
    expect(isEnvKey('prod')).toBe(true);
    expect(isEnvKey('production')).toBe(false);
    expect(isEnvKey(undefined)).toBe(false);
    expect(isEnvKey(7)).toBe(false);
  });
});

/**
 * The guard rail on the colour decisions.
 *
 * Run over every set rather than just the default, because the whole point of making
 * the palette selectable is that a user might be looking at any one of them. A set that
 * fails these is not a taste difference, it is a broken indicator.
 */
describe.each(PALETTE_IDS)('palette set: %s', (id) => {
  const set = PALETTE_SETS[id];
  // A set may declare lower floors when it trades separation for something else. It is
  // still held to whatever it declared, so it cannot drift below its own promise.
  const floors = set.floors ?? STRICT_FLOORS;

  it('is registered under its own id and describes itself', () => {
    expect(set.id).toBe(id);
    expect(set.label.trim().length).toBeGreaterThan(0);
    expect(set.description.trim().length).toBeGreaterThan(0);
  });

  it('has colours for every environment key, and no extras', () => {
    for (const key of ENV_KEYS) expect(set.colors[key], key).toBeDefined();
    expect(Object.keys(set.colors)).toHaveLength(ENV_KEYS.length);
  });

  it('uses six digit uppercase hex, so string comparisons and CSS both behave', () => {
    for (const key of ENV_KEYS) {
      expect(set.colors[key].bg, `${key} bg`).toMatch(/^#[0-9A-F]{6}$/);
      expect(set.colors[key].fg, `${key} fg`).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  // If someone tweaks a hex and drops below AA, this fails rather than shipping an
  // unreadable pill.
  it('clears WCAG AA (4.5:1) for every text-on-fill pair', () => {
    for (const key of ENV_KEYS) {
      const { fg, bg } = set.colors[key];
      expect(contrastRatio(fg, bg), `${key} (${fg} on ${bg})`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('gives every environment a distinct fill, so no two can be confused', () => {
    const fills = ENV_KEYS.map((key) => set.colors[key].bg);
    expect(new Set(fills).size).toBe(fills.length);
  });

  // Distinct hex strings are not enough: two colours can differ numerically and still
  // look the same. The strict floor of 25 is roughly where a difference survives a
  // glance at a small pill in peripheral vision.
  it(`keeps every pair perceptually apart (deltaE >= ${floors.separation})`, () => {
    for (const [a, b] of pairs()) {
      const separation = deltaE(set.colors[a].bg, set.colors[b].bg);
      expect(separation, `${a} vs ${b} (${separation.toFixed(1)})`).toBeGreaterThanOrEqual(
        floors.separation,
      );
    }
  });

  it(`separates staging from prod (deltaE >= ${floors.stagingVsProd})`, () => {
    // The original amber sat ~28 CIELAB units from prod red and read as a second shade
    // of red. The strict floor of 40 exists to stop a return to that.
    expect(deltaE(set.colors.staging.bg, set.colors.prod.bg)).toBeGreaterThanOrEqual(
      floors.stagingVsProd,
    );
  });

  // A relaxed floor has to be a deliberate, documented choice, not a way to sneak a
  // weak set past the suite. Only one set is allowed to declare one.
  it('only relaxes its floors if it is the subtle set', () => {
    if (set.floors) expect(id).toBe('muted');
    expect(set.floors?.separation ?? STRICT_FLOORS.separation).toBeGreaterThan(10);
  });

  it('maps every environment to a real chrome.tabGroups colour', () => {
    for (const key of ENV_KEYS) {
      expect(TAB_GROUP_COLORS.has(set.colors[key].tabGroupColor), key).toBe(true);
    }
  });

  it('uses a distinct tab group colour per environment', () => {
    const colors = ENV_KEYS.map((key) => set.colors[key].tabGroupColor);
    expect(new Set(colors).size).toBe(colors.length);
  });
});

/**
 * The colourblind-safe set has to earn its name.
 *
 * The default set's prod and local sit only about 10 CIELAB units apart under simulated
 * deuteranopia, which is close to indistinguishable. That is not a bug in the default
 * (red for prod against green for local is worth the tradeoff for most people), it is
 * the reason this set exists, so it is asserted here rather than in the shared block.
 */
describe('the colourblind-safe set', () => {
  it.each([
    ['deuteranopia', 30],
    ['protanopia', 30],
    ['tritanopia', 30],
  ] as const)('holds %s separation of at least %i', (kind, floor) => {
    const set = PALETTE_SETS.deuteranopia;
    for (const [a, b] of pairs()) {
      const separation = deltaE(
        simulate(set.colors[a].bg, kind),
        simulate(set.colors[b].bg, kind),
      );
      expect(separation, `${a} vs ${b} (${separation.toFixed(1)})`).toBeGreaterThanOrEqual(floor);
    }
  });

  // The tab strip only offers nine fixed colours, so it cannot express the lightness
  // range this set relies on. Avoiding the red/green pair there is the closest it gets.
  it('stays off the red/green pairing in the tab strip too', () => {
    const colors = ENV_KEYS.map((key) => PALETTE_SETS.deuteranopia.colors[key].tabGroupColor);
    expect(colors).not.toContain('green');
  });

  // Pins the claim the default set's documentation makes about itself, so nobody
  // "fixes" the default into something that makes this set redundant without noticing.
  it('is meaningfully better than the default set it exists to replace', () => {
    const worst = (id: PaletteId): number =>
      Math.min(
        ...pairs().map(([a, b]) =>
          deltaE(
            simulate(PALETTE_SETS[id].colors[a].bg, 'deuteranopia'),
            simulate(PALETTE_SETS[id].colors[b].bg, 'deuteranopia'),
          ),
        ),
      );
    expect(worst('deuteranopia')).toBeGreaterThan(worst('default'));
  });
});

describe('palette lookup', () => {
  it('recognizes valid ids and rejects anything else', () => {
    expect(isPaletteId('vivid')).toBe(true);
    expect(isPaletteId('Vivid')).toBe(false);
    expect(isPaletteId('')).toBe(false);
    expect(isPaletteId(undefined)).toBe(false);
    expect(isPaletteId(3)).toBe(false);
  });

  it('registers every id in PALETTE_IDS and nothing else', () => {
    expect(Object.keys(PALETTE_SETS).sort()).toEqual([...PALETTE_IDS].sort());
  });

  it('defaults to the default set', () => {
    expect(DEFAULT_PALETTE_ID).toBe('default');
    expect(paletteFor(undefined)).toBe(PALETTE_SETS.default);
  });

  // Total by design: a corrupt stored value must render something rather than throw
  // inside a content script on someone's page.
  it('falls back to the default for an unknown id', () => {
    expect(paletteFor('nope' as PaletteId)).toBe(PALETTE_SETS.default);
  });

  it('resolves metadata and colours together via styleFor', () => {
    for (const id of PALETTE_IDS) {
      for (const key of ENV_KEYS) {
        expect(styleFor(key, id)).toEqual({ ...ENV_META[key], ...PALETTE_SETS[id].colors[key] });
      }
    }
  });

  it('keeps glyphs identical across every set', () => {
    for (const key of ENV_KEYS) {
      const glyphs = PALETTE_IDS.map((id) => styleFor(key, id).glyph);
      expect(new Set(glyphs).size, key).toBe(1);
    }
  });

  it('uses the default set when no palette is given', () => {
    for (const key of ENV_KEYS) {
      expect(styleFor(key)).toEqual(styleFor(key, DEFAULT_PALETTE_ID));
    }
  });
});

/** CIELAB deltaE 76 between two hex colours. */
function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

function toLinear(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  return [0, 2, 4].map((offset) => {
    const value = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
}

function toLab(hex: string): [number, number, number] {
  const [r, g, b] = toLinear(hex);

  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;

  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/**
 * Machado, Oliveira and Fernandes (2009) colour vision deficiency simulation, at full
 * severity, applied in linear RGB.
 *
 * Approximate by nature, and that is fine: it is used here as a floor on colour
 * separation, not to claim an exact rendering of anyone's vision.
 */
const CVD_MATRICES = {
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
} as const;

function simulate(hex: string, kind: keyof typeof CVD_MATRICES): string {
  const linear = toLinear(hex);

  const channels = CVD_MATRICES[kind].map((row) =>
    Math.min(1, Math.max(0, row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2])),
  );

  return `#${channels
    .map((value) => {
      const encoded =
        value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
      return Math.round(encoded * 255)
        .toString(16)
        .padStart(2, '0')
        .toUpperCase();
    })
    .join('')}`;
}
