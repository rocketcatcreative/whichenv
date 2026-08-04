/**
 * The "open this link on another environment" context menu, as data.
 *
 * Pure so the interesting decisions are unit testable: Playwright cannot open a native
 * context menu, so this is the only place the behaviour can be pinned down.
 *
 * The shape of the menu is forced by an API limitation. Chrome has no `onShown` event, so
 * items cannot be built from the link you right-clicked; they must all be registered in
 * advance. What saves it is `targetUrlPatterns`, which filters items by the LINK's URL, so
 * every group's environments are registered up front and Chrome shows only the ones whose
 * patterns match the link under the cursor. In practice that means right-clicking a link
 * shows exactly the environments of the one group that link belongs to.
 */

import { displayLabel, type EnvGroup } from './schema';
import { matchPatternsFor } from './permissions';
import { byPipelineOrder, type EnvKey } from './palette';

/**
 * The two things the menu offers, and the prefix of every item id.
 *
 * Opening and copying share everything except the last step, so they share the item
 * building, the pattern filtering and the URL resolution. Only the id prefix differs.
 */
export const MENU_ACTIONS = ['open-link-on', 'copy-link-for'] as const;

export type MenuAction = (typeof MENU_ACTIONS)[number];

/**
 * The single top-level item everything hangs off.
 *
 * One, not one per action. Chrome automatically wraps an extension's top-level context menu
 * items under the extension name as soon as there is more than one, which turned two parents
 * into three levels of hovering. With a single parent Chrome shows it directly, so opening
 * and copying are one hover away and both are visible at once.
 */
export const PARENT_ID = 'environment-switcher-link';

/** How each action labels a row. The environment name comes second so the verb scans first. */
export function titleFor(action: MenuAction, label: string, groupTitle?: string): string {
  const suffix = groupTitle ? ` (${groupTitle})` : '';
  return action === 'open-link-on'
    ? `Open on ${label}${suffix}`
    : `Copy ${label} link${suffix}`;
}

export interface MenuItem {
  /** Encodes the action, group and environment, so the handler needs no lookup table. */
  id: string;
  action: MenuAction;
  groupId: string;
  envKey: EnvKey;
  title: string;
  /** Chrome match patterns for the LINK, not the page. */
  targetUrlPatterns: string[];
}

export function itemId(action: MenuAction, groupId: string, envKey: EnvKey): string {
  return `${action}:${groupId}:${envKey}`;
}

export interface ParsedItem {
  action: MenuAction;
  groupId: string;
  envKey: EnvKey;
}

/** Parses an id back, or null for anything that is not one of ours. */
export function parseItemId(id: string): ParsedItem | null {
  const parts = id.split(':');
  if (parts.length !== 3) return null;
  const [action, groupId, envKey] = parts;
  if (!action || !groupId || !envKey) return null;
  if (!(MENU_ACTIONS as readonly string[]).includes(action)) return null;
  return { action: action as MenuAction, groupId, envKey: envKey as EnvKey };
}

/**
 * One item per enabled environment per group, in pipeline order.
 *
 * The environment the link is already on is NOT excluded, because which one that is cannot
 * be known until the click. Choosing it is harmless: it opens the link where it already
 * points, which is what "open link in new tab" does anyway.
 *
 * Groups whose patterns overlap another group's get their title appended to each label.
 * Two groups can share a host and differ only by port, which a Chrome match pattern cannot
 * express, so both groups' items appear for such a link. Without the group name the user
 * would see "Staging" twice with no way to tell them apart.
 */
export function linkMenuItems(groups: readonly EnvGroup[]): MenuItem[] {
  return MENU_ACTIONS.flatMap((action) => itemsForAction(groups, action));
}

function itemsForAction(groups: readonly EnvGroup[], action: MenuAction): MenuItem[] {
  const patterns = new Map(groups.map((group) => [group.id, matchPatternsFor(group)]));

  const overlaps = (group: EnvGroup): boolean =>
    groups.some(
      (other) =>
        other.id !== group.id &&
        (patterns.get(other.id) ?? []).some((pattern) =>
          (patterns.get(group.id) ?? []).includes(pattern),
        ),
    );

  const items: MenuItem[] = [];

  for (const group of groups) {
    const targetUrlPatterns = patterns.get(group.id) ?? [];
    if (targetUrlPatterns.length === 0) continue;

    const ambiguous = overlaps(group);
    const environments = group.environments
      .filter((env) => env.enabled)
      .sort((a, b) => byPipelineOrder(a.key, b.key));

    for (const env of environments) {
      const label = displayLabel(env);
      items.push({
        id: itemId(action, group.id, env.key),
        action,
        groupId: group.id,
        envKey: env.key,
        // Deliberately NOT flagged for `confirmOnEnter`.
        //
        // The first version appended the editor's ⚑ to guarded environments. The first
        // person to see it asked what it meant, which is the whole answer: a context menu
        // has no tooltip, so a bare glyph is a puzzle, and it promised a confirmation that
        // this path does not ask for. A marker that suggests something will happen and then
        // does not is worse than no marker.
        //
        // The guard is not weakened by leaving it out. It exists so you do not ACT on
        // production by accident, and choosing an environment by name from a menu is not an
        // accident. The page you land on carries the pill in production colours, plus the
        // frame if that environment asks for one.
        title: titleFor(action, label, ambiguous ? group.title : undefined),
        targetUrlPatterns,
      });
    }
  }

  return items;
}
