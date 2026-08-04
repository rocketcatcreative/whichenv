/**
 * The toolbar icon badge, coloured per tab.
 *
 * A secondary signal, deliberately. The pill is the primary one; the badge exists
 * for the cases the pill cannot cover: a group with the indicator hidden, a page
 * whose origin has not been granted, or a tab you are looking at in the tab strip
 * rather than on screen.
 *
 * Note on permissions: reading `tab.url` needs host access for that tab, which is
 * exactly the set of tabs that could match anything. For every other tab the URL
 * comes back undefined and the badge is cleared, which is the correct outcome
 * reached for free rather than by special casing.
 */

import { lookup, resolveMatch } from '@core/match';
import { styleFor, type PaletteId } from '@core/palette';
import { getSettings } from '@core/settings';
import { listGroups } from '@core/storage';
import { getIndex } from './index-cache';

/**
 * The toolbar tooltip when a tab matches nothing.
 *
 * Read from the manifest rather than written out, so it cannot drift from the name Chrome
 * shows everywhere else. `short_name` because this is a tooltip, not a store listing.
 */
function shortName(): string {
  const manifest = chrome.runtime.getManifest();
  return manifest.short_name ?? manifest.name;
}

async function clear(tabId: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.action.setTitle({ tabId, title: shortName() });
  } catch {
    // The tab closed while we were resolving. Entirely normal.
  }
}

/**
 * Paints one tab's badge.
 *
 * `paletteId` is optional so single-tab callers (a navigation, a tab activation) can
 * stay one-liners, and is threaded explicitly by the all-tabs path so a window full of
 * tabs does not read settings once per tab.
 */
export async function updateBadge(
  tabId: number,
  url: string | undefined,
  paletteId?: PaletteId,
): Promise<void> {
  if (!url) return clear(tabId);

  const entry = lookup(await getIndex(), url);
  if (!entry) return clear(tabId);

  const match = resolveMatch(await listGroups(), entry);
  if (!match) return clear(tabId);

  const style = styleFor(match.envKey, paletteId ?? (await getSettings()).paletteId);

  try {
    await chrome.action.setBadgeText({ tabId, text: style.badge });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: style.bg });
    await chrome.action.setBadgeTextColor({ tabId, color: style.fg });
    await chrome.action.setTitle({
      tabId,
      title: `${match.label} on ${match.group.title}`,
    });
  } catch {
    // Same as above: the tab may have gone.
  }
}

/** Refreshes the badge for a tab we only know by id. */
export async function refreshBadge(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateBadge(tabId, tab.url);
  } catch {
    // Tab gone.
  }
}

/** Refreshes every tab's badge, for after a group edit or a palette change. */
export async function refreshAllBadges(): Promise<void> {
  const [tabs, settings] = await Promise.all([chrome.tabs.query({}), getSettings()]);
  await Promise.all(
    tabs.map((tab) =>
      tab.id === undefined ? undefined : updateBadge(tab.id, tab.url, settings.paletteId),
    ),
  );
}
