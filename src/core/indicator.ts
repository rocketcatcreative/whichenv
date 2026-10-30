/**
 * Resolving what the indicator should actually do for a given group.
 *
 * Two levels, no more: a global default, overridable per group. Not per environment,
 * which was where the frame and the tab icon lived before. That was up to twelve
 * switches per group for a decision people make once per site, and it could not express
 * "all my sites do this" at all.
 *
 * Pure and dependency free on purpose. Both callers matter and neither is easy to test
 * in place: the service worker builds the resolved shape for every tab, and the content
 * script re-resolves it when a setting changes to decide whether it needs to rebuild.
 * Getting "did this actually change?" wrong there means either a stale frame or a pill
 * that rebuilds itself under the user's cursor.
 */

import type { EnvGroup, Tristate } from './schema';
import type { Settings } from './settings';

export interface ResolvedIndicator {
  /**
   * Whether the pill is suppressed for this group's sites. Suppressing the pill
   * suppresses the frame and the tab icon too, since both are mounted with it.
   */
  hidden: boolean;
  /** Whether to frame the viewport in the current environment's colour. */
  frame: boolean;
  /** Whether to mark the tab icon with the current environment's colour. */
  tabIcon: boolean;
}

/**
 * Applies one override to one default.
 *
 * `undefined` means the same thing as `'default'`, which matters because a group that
 * overrides nothing stores no `indicator` object at all.
 */
export function applyTristate(value: Tristate | undefined, fallback: boolean): boolean {
  if (value === 'on') return true;
  if (value === 'off') return false;
  return fallback;
}

export function resolveIndicator(group: EnvGroup, settings: Settings): ResolvedIndicator {
  return {
    // Hiding stays a plain boolean rather than a tri-state. There is no global "hide the
    // indicator everywhere" default for it to defer to, and there should not be: an
    // extension whose entire job is showing you which environment you are on does not
    // need a switch that turns that off for every site at once.
    hidden: group.indicator?.hidden === true,
    frame: applyTristate(group.indicator?.frame, settings.frameByDefault),
    tabIcon: applyTristate(group.indicator?.tabIcon, settings.tabIconByDefault),
  };
}

/**
 * The group with its indicator shown or hidden, for the popup's switch.
 *
 * Writes only what differs from the default, the same rule `draftToGroup` follows: showing
 * deletes the `hidden` key rather than storing `false`, and an `indicator` object left
 * empty is dropped. So hiding and then showing again returns the group byte for byte to
 * what it was, which keeps it identical to one the editor saved.
 */
export function withHidden(group: EnvGroup, hidden: boolean): EnvGroup {
  const { hidden: _previous, ...rest } = group.indicator ?? {};
  const indicator: NonNullable<EnvGroup['indicator']> = hidden ? { ...rest, hidden: true } : rest;
  const { indicator: _old, ...base } = group;
  return Object.keys(indicator).length > 0 ? { ...base, indicator } : base;
}
