/**
 * Config export and import.
 *
 * Two jobs. Backing up or moving your setup between machines, and handing one group
 * to a teammate so onboarding is "paste this" instead of "go type four URLs".
 *
 * Generous on the way in, strict on the way out. Import accepts a full exported
 * config, a bare array of groups, or a single group object, because all three are
 * things a person will plausibly paste. Export always writes the full documented
 * shape.
 *
 * Pure and dependency free: no chrome.* and no DOM.
 */

import { normalizeGroup, summarize, type EnvGroup } from './schema';
import { normalizeSettings, type Settings } from './settings';

/**
 * Written into an export, never checked on import.
 *
 * That asymmetry is deliberate and predates the rename: import is generous, accepting a full
 * config, a bare array of groups or a single shared group, and everything comes back through
 * `normalizeGroup` regardless. So a config exported under the old name still imports cleanly,
 * with no legacy list to maintain.
 */
export const CONFIG_KIND = 'whichenv';
export const CONFIG_VERSION = 1;

export interface ExportedConfig {
  kind: typeof CONFIG_KIND;
  version: number;
  exportedAt: number;
  settings: Settings;
  groups: EnvGroup[];
}

export function serializeConfig(
  groups: readonly EnvGroup[],
  settings: Settings,
  now: number,
): string {
  const config: ExportedConfig = {
    kind: CONFIG_KIND,
    version: CONFIG_VERSION,
    exportedAt: now,
    settings,
    groups: [...groups],
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** One group on its own, for pasting into a chat. */
export function serializeGroup(group: EnvGroup): string {
  return `${JSON.stringify(group, null, 2)}\n`;
}

export interface ParsedConfig {
  groups: EnvGroup[];
  /** Present only when the input was a full exported config. */
  settings: Settings | null;
  /** How many entries were dropped as unsalvageable. */
  dropped: number;
}

export type ParseConfigResult =
  | { ok: true; value: ParsedConfig }
  | { ok: false; error: string };

/**
 * Parses pasted or uploaded text into groups.
 *
 * Never throws, and never returns a partially valid group: everything goes through
 * `normalizeGroup`, so an import cannot introduce a shape the rest of the extension
 * would have to defend against.
 */
export function parseConfig(text: string): ParseConfigResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'Nothing to import. Paste a config first.' };

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: 'That is not valid JSON.' };
  }

  // A bare array of groups.
  if (Array.isArray(raw)) return collect(raw, null);

  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Expected a config object or a list of groups.' };
  }

  const object = raw as Record<string, unknown>;

  // A full exported config.
  if (Array.isArray(object.groups)) {
    const settings =
      typeof object.settings === 'object' && object.settings !== null
        ? normalizeSettings(object.settings)
        : null;
    return collect(object.groups, settings);
  }

  // A single group, which is what the per-group share button produces.
  if (typeof object.id === 'string' && typeof object.title === 'string') {
    return collect([object], null);
  }

  return {
    ok: false,
    error: 'That JSON does not look like a WhichEnv config.',
  };
}

function collect(entries: unknown[], settings: Settings | null): ParseConfigResult {
  const groups: EnvGroup[] = [];
  let dropped = 0;

  for (const entry of entries) {
    const group = normalizeGroup(entry);
    if (group) groups.push(group);
    else dropped += 1;
  }

  if (groups.length === 0) {
    return {
      ok: false,
      error:
        dropped > 0
          ? `None of the ${dropped} group(s) in that config could be read.`
          : 'That config contains no groups.',
    };
  }

  return { ok: true, value: { groups, settings, dropped } };
}

export type ImportMode = 'merge' | 'replace';

export interface ImportPlan {
  /** Groups that will be added as new. */
  add: EnvGroup[];
  /** Groups that will overwrite an existing one with the same id. */
  update: { incoming: EnvGroup; existingTitle: string }[];
  /** Groups that cannot be imported, with the reason. */
  skip: { group: EnvGroup; reason: string }[];
  /** Ids that will be deleted. Only ever non-empty in replace mode. */
  remove: EnvGroup[];
}

/**
 * Works out what an import would do, without doing it.
 *
 * Rendered for confirmation before anything is written, because an import that
 * silently clobbered a group would be the kind of mistake you cannot undo.
 *
 * Merge keeps what you have, overwrites same-id groups, and refuses anything that
 * would create a URL collision with a group it is not replacing. Replace swaps the
 * whole set, so collisions with outgoing groups are not collisions at all.
 */
export function planImport(
  incoming: readonly EnvGroup[],
  existing: readonly EnvGroup[],
  mode: ImportMode,
): ImportPlan {
  const plan: ImportPlan = { add: [], update: [], skip: [], remove: [] };

  const existingById = new Map(existing.map((group) => [group.id, group]));

  if (mode === 'replace') {
    const incomingIds = new Set(incoming.map((group) => group.id));
    plan.remove = existing.filter((group) => !incomingIds.has(group.id));
  }

  // Match keys claimed by groups that will survive this import.
  const survivingKeys = new Map<string, string>();
  const incomingIds = new Set(incoming.map((group) => group.id));

  if (mode === 'merge') {
    for (const group of existing) {
      if (incomingIds.has(group.id)) continue; // Being replaced, so its keys are freed.
      for (const key of summarize(group).matchKeys) survivingKeys.set(key, group.title);
    }
  }

  for (const group of incoming) {
    const keys = summarize(group).matchKeys;

    const clash = keys.map((key) => survivingKeys.get(key)).find(Boolean);
    if (clash) {
      plan.skip.push({
        group,
        reason: `its URLs are already used by "${clash}"`,
      });
      continue;
    }

    // Two incoming groups colliding with each other is the same problem.
    const duplicateWithin = keys.find((key) => survivingKeys.has(key));
    if (duplicateWithin) {
      plan.skip.push({ group, reason: 'another group in this config already uses its URLs' });
      continue;
    }

    for (const key of keys) survivingKeys.set(key, group.title);

    const existingGroup = existingById.get(group.id);
    if (existingGroup) plan.update.push({ incoming: group, existingTitle: existingGroup.title });
    else plan.add.push(group);
  }

  return plan;
}

/** A one-line summary of a plan, for the confirmation prompt. */
export function describePlan(plan: ImportPlan): string {
  const parts: string[] = [];
  if (plan.add.length) parts.push(`${plan.add.length} to add`);
  if (plan.update.length) parts.push(`${plan.update.length} to overwrite`);
  if (plan.remove.length) parts.push(`${plan.remove.length} to delete`);
  if (plan.skip.length) parts.push(`${plan.skip.length} skipped`);
  return parts.length ? parts.join(', ') : 'nothing to change';
}

/** Filename for a downloaded backup. */
export function exportFilename(now: Date): string {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return `whichenv-${stamp}.json`;
}
