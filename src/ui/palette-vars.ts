/**
 * Environment colours as CSS custom properties, for the options page.
 *
 * The options page renders environment colours in a dozen places: group cards, the
 * editor's rows, the add-environment buttons, the port registry. Threading the active
 * palette to all of them would mean every one of those renderers taking a `paletteId`
 * argument, and changing the set would mean re-rendering all of them.
 *
 * Instead the palette is published once onto the document root as `--env-<key>-bg` and
 * `--env-<key>-fg`, and those renderers reference the variables. Switching sets becomes
 * one assignment: the browser repaints everything, no re-render, no lost focus and no
 * scroll jump while someone is trying the sets out.
 *
 * The content script deliberately does NOT use this. Its shadow root is closed
 * specifically so that nothing on the host page can influence it, and inheriting custom
 * properties from the page would hand that influence straight back.
 */

import { ENV_KEYS, paletteFor, type EnvKey, type PaletteId } from '@core/palette';

export const envBg = (key: EnvKey): string => `var(--env-${key}-bg)`;
export const envFg = (key: EnvKey): string => `var(--env-${key}-fg)`;

/** Publishes a palette's colours onto an element, defaulting to the document root. */
export function applyPaletteVars(
  palette: PaletteId,
  target: HTMLElement = document.documentElement,
): void {
  const { colors } = paletteFor(palette);
  for (const key of ENV_KEYS) {
    target.style.setProperty(`--env-${key}-bg`, colors[key].bg);
    target.style.setProperty(`--env-${key}-fg`, colors[key].fg);
  }
}
