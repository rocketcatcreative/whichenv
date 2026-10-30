/**
 * Opening every environment in a group at once.
 *
 * Lives here rather than in the worker's message switch for the same reason tab-groups.ts
 * does: it is several Chrome calls with real decisions between them, and a module the unit
 * suite can drive against a fake chrome is worth more than one inlined in a listener.
 *
 * `core/open-all.ts` decides WHAT to open and in what order. This decides HOW: which tabs
 * already exist, which need creating, and how the result gets gathered and ordered.
 */

import { openAllPlan, sameTarget } from '@core/open-all';
import type { Match } from '@core/match';
import type { PaletteId } from '@core/palette';
import { groupTabsInOrder } from './tab-groups';

export interface OpenAllResult {
  /** Tabs this created. */
  opened: number;
  /** Tabs that were already showing one of the destinations and were pulled in instead. */
  adopted: number;
}

/**
 * Opens the group's environments into one ordered Chrome tab group.
 *
 * Returns null when there is nothing to do, which is a group whose only reachable
 * environment is the one you are already on.
 *
 * Two things make this more than a loop over `chrome.tabs.create`. Tabs already showing one
 * of the destinations are ADOPTED rather than duplicated, so pressing the button twice
 * leaves you with one set rather than two. And every tab it creates opens in the background,
 * so a run that opens five tabs does not drag focus through five page loads and leave you
 * wherever the last one happened to land.
 *
 * Adoption depends on reading a tab's URL, which needs host permission for that origin. In
 * practice those are exactly the origins the user configured and granted, so the case that
 * matters is covered. Anywhere else it quietly falls back to opening a fresh tab, which is
 * the behaviour you would have had anyway rather than a failure.
 */
export async function openAllEnvironments(
  match: Match,
  currentUrl: string,
  originTabId: number,
  windowId: number,
  paletteId: PaletteId,
): Promise<OpenAllResult | null> {
  const plan = openAllPlan(match, currentUrl);
  if (plan.length < 2) return null;

  const openHere = await chrome.tabs.query({ windowId });
  const ordered: number[] = [];
  let opened = 0;
  let adopted = 0;

  for (const stop of plan) {
    if (stop.current) {
      ordered.push(originTabId);
      continue;
    }

    // `pendingUrl` covers a tab still loading, which a fast second press would otherwise
    // miss and duplicate. Ids already claimed are skipped so two stops cannot adopt one tab.
    const existing = openHere.find(
      (tab) =>
        tab.id !== undefined &&
        tab.id !== originTabId &&
        !ordered.includes(tab.id) &&
        sameTarget(tab.url || tab.pendingUrl || '', stop.url),
    );

    if (existing?.id !== undefined) {
      ordered.push(existing.id);
      adopted += 1;
      continue;
    }

    try {
      const created = await chrome.tabs.create({ url: stop.url, windowId, active: false });
      if (created.id !== undefined) {
        ordered.push(created.id);
        opened += 1;
      }
    } catch {
      // One environment refusing to open is not a reason to abandon the rest.
    }
  }

  const [first, ...rest] = ordered;
  if (first === undefined) return null;

  // The environment the tab is on is the colour fallback. `groupTabsInOrder` recomputes
  // the real one from everything that ends up in the group, which after this is all of them.
  await groupTabsInOrder([first, ...rest], windowId, match.group, match.envKey, paletteId);

  return { opened, adopted };
}
