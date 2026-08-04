import { describe, expect, it } from 'vitest';
import { applyTristate, resolveIndicator } from '../../src/core/indicator';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings';
import type { EnvGroup, Tristate } from '../../src/core/schema';
import { acmeGroup } from '../helpers/groups';

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

function withIndicator(indicator: EnvGroup['indicator']): EnvGroup {
  const group = acmeGroup();
  return indicator ? { ...group, indicator } : group;
}

describe('applyTristate', () => {
  it('overrides the fallback in both directions', () => {
    expect(applyTristate('on', false)).toBe(true);
    expect(applyTristate('off', true)).toBe(false);
  });

  it('defers to the fallback for default', () => {
    expect(applyTristate('default', true)).toBe(true);
    expect(applyTristate('default', false)).toBe(false);
  });

  // A group that overrides nothing stores no `indicator` object at all, so undefined
  // reaches here routinely and has to mean the same thing as 'default'. If it did not,
  // every group saved before this feature existed would read as off.
  it('treats undefined exactly like default', () => {
    expect(applyTristate(undefined, true)).toBe(true);
    expect(applyTristate(undefined, false)).toBe(false);
  });
});

describe('resolveIndicator', () => {
  it('follows the global default when the group says nothing', () => {
    const group = withIndicator(undefined);

    expect(resolveIndicator(group, settings())).toEqual({
      hidden: false,
      frame: false,
      tabIcon: false,
    });
    expect(
      resolveIndicator(group, settings({ frameByDefault: true, tabIconByDefault: true })),
    ).toEqual({ hidden: false, frame: true, tabIcon: true });
  });

  it('lets a group opt in against a default of off', () => {
    const group = withIndicator({ frame: 'on', tabIcon: 'on' });
    const resolved = resolveIndicator(group, settings());
    expect(resolved.frame).toBe(true);
    expect(resolved.tabIcon).toBe(true);
  });

  // The case the tri-state exists for. With a boolean per group, "on for everything except
  // this one site" would be unsayable.
  it('lets a group opt out against a default of on', () => {
    const group = withIndicator({ frame: 'off', tabIcon: 'off' });
    const resolved = resolveIndicator(
      group,
      settings({ frameByDefault: true, tabIconByDefault: true }),
    );
    expect(resolved.frame).toBe(false);
    expect(resolved.tabIcon).toBe(false);
  });

  it('resolves the two markers independently', () => {
    const resolved = resolveIndicator(
      withIndicator({ frame: 'on', tabIcon: 'off' }),
      settings({ frameByDefault: false, tabIconByDefault: true }),
    );
    expect(resolved).toEqual({ hidden: false, frame: true, tabIcon: false });
  });

  // Hiding is not a tri-state and must not become one by accident: there is no global
  // "hide everywhere" for it to defer to.
  it('reads hidden straight off the group, whatever the settings say', () => {
    expect(resolveIndicator(withIndicator({ hidden: true }), settings()).hidden).toBe(true);
    expect(
      resolveIndicator(
        withIndicator({ hidden: true }),
        settings({ frameByDefault: true, tabIconByDefault: true }),
      ).hidden,
    ).toBe(true);
    expect(resolveIndicator(withIndicator({ frame: 'on' }), settings()).hidden).toBe(false);
  });

  it('covers every combination of tri-state and default', () => {
    const expected: Record<Tristate, [boolean, boolean]> = {
      // [default off, default on]
      default: [false, true],
      on: [true, true],
      off: [false, false],
    };

    for (const state of ['default', 'on', 'off'] as Tristate[]) {
      for (const [index, fallback] of [false, true].entries()) {
        const resolved = resolveIndicator(
          withIndicator({ frame: state }),
          settings({ frameByDefault: fallback }),
        );
        expect(resolved.frame, `${state} over ${fallback}`).toBe(expected[state][index]);
      }
    }
  });
});
