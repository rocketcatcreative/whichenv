/**
 * Chrome tab groups for new-tab switches.
 *
 * When a switch opens a new tab, that tab joins a Chrome tab group named after the
 * environment group. The point is adjacency: comparing prod against staging means
 * two tabs about the same site, and they should stay together rather than scattering
 * into thirty unrelated ones.
 *
 * One group per ENVIRONMENT GROUP, not per environment. A group titled
 * "Acme Storefront" holding a prod tab and a staging tab is the useful arrangement;
 * splitting it into "Acme · Prod" and "Acme · Staging" would be four tab groups for
 * one site and defeat the purpose.
 *
 * That leaves the question of colour, since the tabs inside can span environments.
 * The rule is **the highest-risk environment currently in the group**: one prod tab
 * anywhere in there and the whole group reads red. ENV_KEYS is ordered
 * lowest-to-highest risk, so this is just a max.
 *
 * The tab a SWITCH came from is pulled in too, but only when it is currently ungrouped.
 * Grouping only the new tab would leave the pair split, which defeats the point: the two
 * tabs you are comparing end up in different places. A tab that is already in some group
 * is left exactly where it is, because that arrangement is the user's and not ours to
 * rearrange.
 *
 * Open-all is the deliberate exception. It takes the originating tab whatever state it is
 * in, and it orders the whole set; see `groupTabsInOrder`.
 */

import { lookup, resolveMatch } from '@core/match';
import { ENV_KEYS, styleFor, type EnvKey, type PaletteId } from '@core/palette';
import type { EnvGroup } from '@core/schema';
import { listGroups } from '@core/storage';
import { getIndex } from './index-cache';

/** Remembers which Chrome tab group belongs to which environment group, per window. */
const CACHE_KEY = 'tabgroups';

type Assignments = Record<string, number>;

const assignmentKey = (windowId: number, envGroupId: string): string =>
  `${windowId}:${envGroupId}`;

async function readAssignments(): Promise<Assignments> {
  const stored = await chrome.storage.session.get(CACHE_KEY);
  const value = stored[CACHE_KEY];
  return typeof value === 'object' && value !== null ? (value as Assignments) : {};
}

async function writeAssignment(
  windowId: number,
  envGroupId: string,
  tabGroupId: number,
): Promise<void> {
  const assignments = await readAssignments();
  assignments[assignmentKey(windowId, envGroupId)] = tabGroupId;
  await chrome.storage.session.set({ [CACHE_KEY]: assignments });
}

/**
 * Finds the tab group to use, or null to create a fresh one.
 *
 * Tries the remembered id first, then falls back to matching on title. The
 * remembered id is what survives a user renaming the tab group; the title match is
 * what survives the service worker losing its session storage.
 */
async function findExistingGroup(
  windowId: number,
  envGroup: EnvGroup,
): Promise<number | null> {
  const assignments = await readAssignments();
  const remembered = assignments[assignmentKey(windowId, envGroup.id)];

  if (remembered !== undefined) {
    try {
      const group = await chrome.tabGroups.get(remembered);
      if (group.windowId === windowId) return remembered;
    } catch {
      // The group was closed. Fall through to the title match.
    }
  }

  try {
    const byTitle = await chrome.tabGroups.query({ windowId, title: envGroup.title });
    if (byTitle[0]) return byTitle[0].id;
  } catch {
    // tabGroups.query is unavailable or the window has gone.
  }

  return null;
}

/**
 * Chrome's sentinel for "this tab is not in any group".
 *
 * Read lazily rather than at module scope. Touching `chrome.*` while a module is
 * still being evaluated is fragile in a service worker, and it makes the module
 * impossible to import in any context where the API is not there yet.
 */
function tabGroupIdNone(): number {
  return chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;
}

/**
 * Whether the originating tab should be pulled into the group as well.
 *
 * True only when it is ungrouped and in the same window. Anything already in a group
 * belongs to an arrangement the user made, and moving it would be presumptuous.
 */
async function shouldAdoptOrigin(
  originTabId: number | undefined,
  newTabId: number,
  windowId: number,
): Promise<boolean> {
  if (originTabId === undefined || originTabId === newTabId) return false;

  try {
    const tab = await chrome.tabs.get(originTabId);
    if (tab.windowId !== windowId) return false;
    return tab.groupId === undefined || tab.groupId === tabGroupIdNone();
  } catch {
    return false; // The origin tab has gone.
  }
}

/** The riskiest environment among the tabs currently in a Chrome tab group. */
async function riskiestEnvIn(tabGroupId: number, fallback: EnvKey): Promise<EnvKey> {
  let riskiest = fallback;

  try {
    const tabs = await chrome.tabs.query({ groupId: tabGroupId });
    const index = await getIndex();
    const groups = await listGroups();

    for (const tab of tabs) {
      // Unreadable URL means an origin we hold no permission for, which is also an
      // origin that cannot be in any group. Skipping it is correct, not a gap.
      if (!tab.url) continue;
      const entry = lookup(index, tab.url);
      if (!entry) continue;
      const match = resolveMatch(groups, entry);
      if (!match) continue;

      if (ENV_KEYS.indexOf(match.envKey) > ENV_KEYS.indexOf(riskiest)) {
        riskiest = match.envKey;
      }
    }
  } catch {
    // Fall back to the environment we just switched into.
  }

  return riskiest;
}

/**
 * Reorders tabs already inside a group, without letting any of them out of it.
 *
 * Moved one at a time and left to right, starting at the group's own first index.
 * `chrome.tabs.move` takes an array, but it reindexes as it goes and the array form is
 * only correct when every tab in the group is one being ordered, which is not true here:
 * a group can already hold tabs from earlier switches. Anchoring to the group's first
 * index is what keeps the moves inside the group, since a tab moved past a group's
 * boundary is silently dropped out of it.
 */
async function arrange(tabGroupId: number, tabIds: readonly number[]): Promise<void> {
  try {
    const inGroup = await chrome.tabs.query({ groupId: tabGroupId });
    const indexes = inGroup.map((tab) => tab.index);
    if (indexes.length === 0) return;

    let index = Math.min(...indexes);
    for (const tabId of tabIds) {
      await chrome.tabs.move(tabId, { index });
      index += 1;
    }
  } catch {
    // Ordering is cosmetic. Failing it must not undo the grouping that just worked.
  }
}

/**
 * Find-or-create the group, put these tabs in it, and paint it.
 *
 * Best effort throughout: tab grouping is a convenience, and a failure here must
 * never break the switch or the open-all that triggered it. Every step is wrapped
 * rather than allowed to reject into the caller.
 */
async function attach(
  tabIds: [number, ...number[]],
  windowId: number,
  envGroup: EnvGroup,
  fallbackEnv: EnvKey,
  paletteId: PaletteId,
  ordered: boolean,
): Promise<void> {
  try {
    const existing = await findExistingGroup(windowId, envGroup);

    // Explicitly against null rather than truthiness: a tab group id of 0 would be
    // falsy, and relying on Chrome never issuing one is not a guarantee worth taking.
    const tabGroupId =
      existing !== null
        ? await chrome.tabs.group({ tabIds, groupId: existing })
        : await chrome.tabs.group({ tabIds, createProperties: { windowId } });

    await writeAssignment(windowId, envGroup.id, tabGroupId);

    if (ordered) await arrange(tabGroupId, tabIds);

    // Recomputed on every add, so opening a prod tab turns the group red. It is
    // deliberately NOT recomputed on close: leaving it at the high-water mark errs
    // toward caution rather than quietly downgrading a group that had prod in it.
    const riskiest = await riskiestEnvIn(tabGroupId, fallbackEnv);

    await chrome.tabGroups.update(tabGroupId, {
      title: envGroup.title,
      color: styleFor(riskiest, paletteId).tabGroupColor,
    });
  } catch (error) {
    console.warn('[WhichEnv] could not group those tabs', error);
  }
}

/**
 * Puts a tab into the Chrome tab group for its environment group.
 *
 * Position is left alone: a switch adds one tab next to the tab it came from, and
 * Chrome has already put it in the right place.
 */
export async function groupTab(
  tabId: number,
  windowId: number,
  envGroup: EnvGroup,
  envKey: EnvKey,
  paletteId: PaletteId,
  originTabId?: number,
): Promise<void> {
  // Origin first, so the tab strip keeps the order they were already in.
  // Typed as a non-empty tuple because that is what chrome.tabs.group requires.
  const adoptOrigin = await shouldAdoptOrigin(originTabId, tabId, windowId);
  const tabIds: [number, ...number[]] =
    adoptOrigin && originTabId !== undefined ? [originTabId, tabId] : [tabId];

  await attach(tabIds, windowId, envGroup, envKey, paletteId, false);
}

/**
 * Puts a whole set of tabs into the group, in the order given.
 *
 * Unlike `groupTab`, the originating tab is pulled in unconditionally. Open-all is an
 * explicit request to gather this site's environments together, and leaving the tab you
 * pressed it from outside the group would be the one arrangement nobody wants.
 */
export async function groupTabsInOrder(
  tabIds: [number, ...number[]],
  windowId: number,
  envGroup: EnvGroup,
  fallbackEnv: EnvKey,
  paletteId: PaletteId,
): Promise<void> {
  await attach(tabIds, windowId, envGroup, fallbackEnv, paletteId, true);
}

/** Drops remembered assignments for a window that has closed. */
export async function forgetWindow(windowId: number): Promise<void> {
  const assignments = await readAssignments();
  const prefix = `${windowId}:`;
  let changed = false;

  for (const key of Object.keys(assignments)) {
    if (key.startsWith(prefix)) {
      delete assignments[key];
      changed = true;
    }
  }

  if (changed) await chrome.storage.session.set({ [CACHE_KEY]: assignments });
}
