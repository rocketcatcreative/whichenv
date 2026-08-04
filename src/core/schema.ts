/**
 * The environment group data model, its validation rules, and the boundary
 * between what the editor holds and what gets stored.
 *
 * Two distinct shapes on purpose:
 *
 *   - `GroupDraft` is what the editor holds while you type. Every field is a
 *     plain string that may be empty, half finished or wrong.
 *   - `EnvGroup` is what reaches storage. Normalized, validated, canonical.
 *
 * Keeping them apart means the editor never has to fake a valid group to render
 * a partially typed one, and nothing downstream has to defend against a group
 * that was saved mid-edit.
 *
 * Pure and dependency free: no chrome.* and no DOM.
 */

import { ENV_KEYS, ENV_META, NEW_GROUP_ENV_KEYS, isEnvKey, type EnvKey } from './palette';
import { hasExplicitPort, isLoopbackHost, loopbackAliasesFor, parseBaseUrl } from './url';

export const SCHEMA_VERSION = 1;

/**
 * A per group override of a global default.
 *
 * Three states rather than a boolean because "follow the global setting" has to be
 * expressible and has to be the starting point. With a boolean, every group would be
 * pinned the moment it was created, and changing the global default would then reach
 * nothing.
 */
export const TRISTATES = ['default', 'on', 'off'] as const;

export type Tristate = (typeof TRISTATES)[number];

export const TRISTATE_LABELS: Readonly<Record<Tristate, string>> = {
  default: 'Use the default',
  on: 'On',
  off: 'Off',
};

export function isTristate(value: unknown): value is Tristate {
  return typeof value === 'string' && (TRISTATES as readonly string[]).includes(value);
}

export const LIMITS = {
  titleMax: 80,
  descriptionMax: 280,
  labelMax: 24,
  aliasesPerEnv: 8,
  environmentsPerGroup: ENV_KEYS.length,
} as const;

// --------------------------------------------------------------- stored shape

export interface EnvironmentDef {
  key: EnvKey;
  /** Display override. Absent means use the palette's default label. */
  label?: string;
  /** Canonical normalized base URL, e.g. 'https://acme.com' or 'http://localhost:3000'. */
  baseUrl: string;
  /** Extra normalized base URLs that also resolve here. Match only, never a switch target. */
  aliases?: string[];
  enabled: boolean;
  /** Require a second confirmation before switching INTO this environment. Off by default. */
  confirmOnEnter?: boolean;
  /**
   * RESERVED for a user-supplied regex, and still unused.
   *
   * Wildcard hosts are handled in `baseUrl` itself, as a leading `*.`, not here. A regex is
   * a separate and much worse proposition: it would run against every URL visited, and one
   * catastrophic backtracking case is a hung browser on every page load. Only if asked for.
   */
  pattern?: string;
}

export interface EnvGroup {
  id: string;
  schemaVersion: number;
  title: string;
  description?: string;
  /** User ordered. The order drives the switcher list and shortcut indices. */
  environments: EnvironmentDef[];
  indicator?: {
    /**
     * Position and SIZE are GLOBAL settings, not per group ones, so neither a corner
     * nor a size appears here. What is per group is whether the indicator shows at all,
     * and the two page markers below.
     */
    hidden?: boolean;
    /**
     * Frame the viewport in the current environment's colour, for every environment in
     * this group.
     *
     * Per group rather than per environment, which is a deliberate trade. Framing
     * production alone is no longer possible; in exchange there are two switches per
     * group instead of up to twelve, and whichever environment you are on, the frame is
     * that environment's colour, so it still tells you where you are rather than only
     * that you are somewhere dangerous.
     */
    frame?: Tristate;
    /** Mark the tab icon with the current environment's colour, for this whole group. */
    tabIcon?: Tristate;
  };
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------- draft shape

export interface EnvironmentDraft {
  key: EnvKey;
  /** '' means "use the palette default". */
  label: string;
  /** Raw user input, not yet normalized. */
  baseUrl: string;
  /** Raw user input, one per line or comma separated in the UI. */
  aliases: string[];
  /**
   * False means REMOVED. The row keeps its URL, aliases and label and is simply not
   * rendered, so adding the environment back restores what was there.
   */
  enabled: boolean;
  confirmOnEnter: boolean;
}

export interface GroupDraft {
  id: string;
  title: string;
  description: string;
  environments: EnvironmentDraft[];
  hidden: boolean;
  frame: Tristate;
  tabIcon: Tristate;
}

// ----------------------------------------------------------------- validation

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  /** Dotted path to the offending field, e.g. 'title' or 'environments.2.baseUrl'. */
  path: string;
  code: string;
  message: string;
  severity: Severity;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  /** Errors block saving. Warnings do not. */
  canSave: boolean;
}

/** A group already in storage, used to detect cross-group collisions. */
export interface ExistingGroupSummary {
  id: string;
  title: string;
  /** Every match key this group claims, from base URLs and aliases alike. */
  matchKeys: string[];
}

export function emptyDraft(id: string): GroupDraft {
  return {
    id,
    title: '',
    description: '',
    environments: NEW_GROUP_ENV_KEYS.map(newEnvironmentDraft),
    hidden: false,
    frame: 'default',
    tabIcon: 'default',
  };
}

export function newEnvironmentDraft(key: EnvKey): EnvironmentDraft {
  return {
    key,
    label: '',
    baseUrl: '',
    aliases: [],
    enabled: true,
    confirmOnEnter: false,
  };
}

export function groupToDraft(group: EnvGroup): GroupDraft {
  return {
    id: group.id,
    title: group.title,
    description: group.description ?? '',
    hidden: group.indicator?.hidden ?? false,
    frame: group.indicator?.frame ?? 'default',
    tabIcon: group.indicator?.tabIcon ?? 'default',
    environments: group.environments.map((env) => ({
      key: env.key,
      label: env.label ?? '',
      baseUrl: env.baseUrl,
      aliases: [...(env.aliases ?? [])],
      enabled: env.enabled,
      confirmOnEnter: env.confirmOnEnter ?? false,
    })),
  };
}

/** The label to show for an environment: its override, or the built-in default. */
export function displayLabel(env: { key: EnvKey; label?: string }): string {
  const override = env.label?.trim();
  return override ? override : ENV_META[env.key].label;
}

/**
 * Every match key an environment claims, base URL and aliases together.
 *
 * Unparseable entries are skipped rather than throwing: validation reports those
 * separately, and callers of this function want the keys that do work.
 */
export function matchKeysForEnvironment(env: {
  baseUrl: string;
  aliases?: string[];
}): string[] {
  const keys: string[] = [];
  for (const candidate of [env.baseUrl, ...(env.aliases ?? [])]) {
    const parsed = parseBaseUrl(candidate);
    if (parsed.ok) keys.push(parsed.value.matchKey);
  }
  return keys;
}

export function summarize(group: EnvGroup): ExistingGroupSummary {
  return {
    id: group.id,
    title: group.title,
    matchKeys: group.environments
      .filter((env) => env.enabled)
      .flatMap((env) => matchKeysForEnvironment(env)),
  };
}

/**
 * Validates a draft.
 *
 * Errors block the save. Warnings are things worth saying that should not stop
 * you: a group with one environment is legitimate while you are still filling it
 * in, and a bare `http://localhost` is legal even though it is almost certainly
 * not what you meant.
 *
 * `others` should exclude the draft's own id, so editing a group does not report
 * it as colliding with itself.
 */
export function validateDraft(
  draft: GroupDraft,
  others: ExistingGroupSummary[] = [],
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (
    path: string,
    code: string,
    message: string,
    severity: Severity = 'error',
  ): void => {
    issues.push({ path, code, message, severity });
  };

  // ---------------------------------------------------------------- title
  const title = draft.title.trim();
  if (!title) {
    add('title', 'required', 'Give the group a title.');
  } else if (title.length > LIMITS.titleMax) {
    add('title', 'too-long', `Keep the title under ${LIMITS.titleMax} characters.`);
  }

  if (draft.description.trim().length > LIMITS.descriptionMax) {
    add(
      'description',
      'too-long',
      `Keep the description under ${LIMITS.descriptionMax} characters.`,
    );
  }

  // ------------------------------------------------------- environment keys
  if (draft.environments.length === 0) {
    add('environments', 'empty', 'Add at least one environment.');
  }

  const seenKeys = new Set<EnvKey>();
  for (const [index, env] of draft.environments.entries()) {
    if (!isEnvKey(env.key)) {
      add(`environments.${index}.key`, 'unknown-key', `Unknown environment "${env.key}".`);
      continue;
    }
    if (seenKeys.has(env.key)) {
      add(
        `environments.${index}.key`,
        'duplicate-key',
        `${ENV_META[env.key].label} appears more than once in this group.`,
      );
    }
    seenKeys.add(env.key);
  }

  // -------------------------------------------------------- per environment
  /** matchKey -> where it was first claimed inside this draft. */
  const claimedHere = new Map<string, { path: string; label: string }>();

  for (const [index, env] of draft.environments.entries()) {
    const label = displayLabel(env);
    const basePath = `environments.${index}`;

    // Nothing below this line may run for a removed environment. A removed row is not
    // rendered, so an error against it would be unfixable: no field to correct, no checkbox
    // to clear it, and a save button disabled for an invisible reason.
    if (!env.enabled) continue;

    if (env.label.trim().length > LIMITS.labelMax) {
      add(`${basePath}.label`, 'too-long', `Keep labels under ${LIMITS.labelMax} characters.`);
    }

    if (!env.baseUrl.trim()) {
      add(`${basePath}.baseUrl`, 'required', `${label} needs a base URL, or remove it.`);
      continue;
    }

    const parsed = parseBaseUrl(env.baseUrl);
    if (!parsed.ok) {
      add(`${basePath}.baseUrl`, parsed.error.code, `${label}: ${parsed.error.message}`);
      continue;
    }

    // A single-label host like `acme` is legitimate (docker service names,
    // intranet hosts, /etc/hosts entries) so it is not blocked, but it is far
    // more often a half-typed domain. Warn rather than guess.
    if (
      !parsed.value.host.includes('.') &&
      !isLoopbackHost(parsed.value.host) &&
      !parsed.value.host.startsWith('[')
    ) {
      add(
        `${basePath}.baseUrl`,
        'single-label-host',
        `${label} points at "${parsed.value.host}", which has no domain suffix. Did you mean ${parsed.value.host}.com?`,
        'warning',
      );
    }

    // A wildcard is match-only. Said out loud, because the consequence is invisible
    // otherwise: this environment will never appear in anyone else's switcher list, and
    // someone who typed it expecting a switch target would be left wondering why.
    if (parsed.value.wildcardSuffix) {
      add(
        `${basePath}.baseUrl`,
        'wildcard-not-a-target',
        `${label} matches any host under ${parsed.value.display}, so tabs on it are recognized. You cannot switch INTO it, since there is no way to know which host you meant.`,
        'warning',
      );
    }

    // A bare loopback host means port 80, which is not where dev servers live
    // and is guaranteed to collide with the next group that does the same.
    if (isLoopbackHost(parsed.value.host) && !hasExplicitPort(env.baseUrl)) {
      add(
        `${basePath}.baseUrl`,
        'loopback-without-port',
        `${label} has no port, so it means port 80. Local sites usually need one, like http://localhost:3000.`,
        'warning',
      );
    }

    if (env.aliases.length > LIMITS.aliasesPerEnv) {
      add(
        `${basePath}.aliases`,
        'too-many',
        `${label} has more than ${LIMITS.aliasesPerEnv} aliases.`,
      );
    }

    const entries: { value: string; path: string; kind: 'base' | 'alias' }[] = [
      { value: env.baseUrl, path: `${basePath}.baseUrl`, kind: 'base' },
      ...env.aliases.map((alias, aliasIndex) => ({
        value: alias,
        path: `${basePath}.aliases.${aliasIndex}`,
        kind: 'alias' as const,
      })),
    ];

    for (const entry of entries) {
      if (!entry.value.trim()) {
        if (entry.kind === 'alias') {
          add(entry.path, 'empty-alias', `${label} has an empty alias.`);
        }
        continue;
      }

      const entryParsed = parseBaseUrl(entry.value);
      if (!entryParsed.ok) {
        if (entry.kind === 'alias') {
          add(entry.path, entryParsed.error.code, `${label} alias: ${entryParsed.error.message}`);
        }
        continue;
      }

      const key = entryParsed.value.matchKey;

      const existing = claimedHere.get(key);
      if (existing) {
        add(
          entry.path,
          'duplicate-in-group',
          existing.label === label
            ? `${label} lists ${entryParsed.value.display} twice.`
            : `${entryParsed.value.display} is already used by ${existing.label} in this group.`,
        );
      } else {
        claimedHere.set(key, { path: entry.path, label });
      }

      // Cross group collisions. Two groups claiming the same origin AND port
      // makes the indicator ambiguous in a way that is very hard to debug from
      // the outside, so it is blocked rather than warned about.
      const conflict = others.find((other) => other.matchKeys.includes(key));
      if (conflict) {
        add(
          entry.path,
          'collision',
          `${entryParsed.value.display} is already used by the group "${conflict.title}".`,
        );
      }
    }
  }

  // ------------------------------------------------------------- usefulness
  const parsedBases = draft.environments
    .filter((env) => env.enabled)
    .map((env) => parseBaseUrl(env.baseUrl))
    .filter((result) => result.ok)
    .map((result) => (result.ok ? result.value : null))
    .filter((value) => value !== null);

  const usable = parsedBases.length;
  /** Environments something can actually be switched TO. A wildcard is not one. */
  const switchable = parsedBases.filter((base) => !base.wildcardSuffix).length;

  // The state a wildcard group falls into by accident: several environments, but only one
  // real destination, so every row but that one has an empty switcher. Worth saying,
  // because "the pill shows but the list is empty" reads as a bug rather than a
  // consequence of what was set up.
  if (usable > 1 && switchable === 1) {
    add(
      'environments',
      'one-switch-target',
      'Only one environment has a fixed URL, so that is the only place a switch can go. Wildcard environments can be recognized but not switched into.',
      'warning',
    );
  } else if (usable > 1 && switchable === 0) {
    add(
      'environments',
      'no-switch-target',
      'Every environment here is a wildcard, so tabs will be recognized but there is nowhere to switch to. Add one with a fixed URL.',
      'warning',
    );
  }

  if (usable === 1) {
    add(
      'environments',
      'nothing-to-switch-to',
      'Only one environment is set up, so there is nothing to switch to yet.',
      'warning',
    );
  } else if (usable === 0 && draft.environments.length > 0) {
    add(
      'environments',
      'none-usable',
      'No environment has a valid base URL yet.',
      'warning',
    );
  }

  return { issues, canSave: !issues.some((issue) => issue.severity === 'error') };
}

/**
 * Converts a validated draft into its canonical stored form.
 *
 * Assumes `validateDraft` reported no errors. It still normalizes defensively
 * (trimming, dropping unparseable aliases, deduping) so a caller that skips
 * validation cannot write a malformed group.
 */
export function draftToGroup(draft: GroupDraft, now: number, previous?: EnvGroup): EnvGroup {
  const environments: EnvironmentDef[] = [];

  for (const env of draft.environments) {
    if (!isEnvKey(env.key)) continue;

    const parsed = parseBaseUrl(env.baseUrl);
    const label = env.label.trim();

    const seen = new Set<string>();
    const aliases: string[] = [];
    for (const alias of env.aliases) {
      const aliasParsed = parseBaseUrl(alias);
      if (!aliasParsed.ok) continue;
      const key = aliasParsed.value.matchKey;
      // An alias identical to the base URL is redundant, not wrong.
      if (parsed.ok && key === parsed.value.matchKey) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      aliases.push(aliasParsed.value.normalized);
    }

    const def: EnvironmentDef = {
      key: env.key,
      baseUrl: parsed.ok ? parsed.value.normalized : '',
      // Invariant: enabled implies a parseable base URL. An environment that is
      // switched on with nowhere to go is meaningless, and holding this here means
      // the matcher and the switcher never have to check for it.
      enabled: env.enabled && parsed.ok,
    };
    if (label) def.label = label;
    if (aliases.length) def.aliases = aliases;
    if (env.confirmOnEnter) def.confirmOnEnter = true;

    environments.push(def);
  }

  const group: EnvGroup = {
    id: draft.id,
    schemaVersion: SCHEMA_VERSION,
    title: draft.title.trim(),
    environments,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };

  const description = draft.description.trim();
  if (description) group.description = description;

  // Only what differs from the default is written. `indicator` is left off entirely for a
  // group that overrides nothing, which keeps the common group small in sync storage and
  // keeps exported snippets readable.
  const indicator: NonNullable<EnvGroup['indicator']> = {};
  if (draft.hidden) indicator.hidden = true;
  if (draft.frame !== 'default') indicator.frame = draft.frame;
  if (draft.tabIcon !== 'default') indicator.tabIcon = draft.tabIcon;
  if (Object.keys(indicator).length > 0) group.indicator = indicator;

  return group;
}

/**
 * Coerces an unknown value from storage into a valid EnvGroup, or null.
 *
 * Total: never throws. A group that cannot be salvaged is dropped rather than
 * poisoning the whole config, and this is where future migrations hook in.
 */
export function normalizeGroup(raw: unknown): EnvGroup | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const input = raw as Record<string, unknown>;

  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!id || !title) return null;

  const rawEnvironments = Array.isArray(input.environments) ? input.environments : [];
  const environments: EnvironmentDef[] = [];
  const seenKeys = new Set<EnvKey>();

  // Migration, from when the frame and the tab icon were per environment. Any single
  // environment asking for one is read as the GROUP wanting it, which is the closest
  // honest reading: someone who framed production wanted a frame, and the alternative
  // (dropping the flag) would silently switch off a marker they deliberately turned on.
  // Widening it is visible and one click to undo; losing it is neither.
  let legacyFrame = false;
  let legacyTabIcon = false;

  for (const candidate of rawEnvironments) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const env = candidate as Record<string, unknown>;
    if (!isEnvKey(env.key) || seenKeys.has(env.key)) continue;

    const baseUrl = typeof env.baseUrl === 'string' ? env.baseUrl.trim() : '';
    const parsed = parseBaseUrl(baseUrl);

    // An empty base URL is kept: it is a placeholder row the user has not filled
    // in yet, and dropping it would silently delete rows from the editor between
    // saving and reopening. A non-empty URL that cannot be parsed is genuinely
    // broken, so that one is dropped.
    if (!parsed.ok && baseUrl !== '') continue;

    seenKeys.add(env.key);

    const def: EnvironmentDef = {
      key: env.key,
      baseUrl: parsed.ok ? parsed.value.normalized : '',
      // Same invariant as draftToGroup: enabled implies a parseable base URL.
      enabled: parsed.ok && (typeof env.enabled === 'boolean' ? env.enabled : true),
    };

    if (typeof env.label === 'string' && env.label.trim()) {
      def.label = env.label.trim().slice(0, LIMITS.labelMax);
    }

    if (Array.isArray(env.aliases)) {
      const seen = new Set<string>(parsed.ok ? [parsed.value.matchKey] : []);
      const aliases: string[] = [];
      for (const alias of env.aliases) {
        if (typeof alias !== 'string') continue;
        const aliasParsed = parseBaseUrl(alias);
        if (!aliasParsed.ok || seen.has(aliasParsed.value.matchKey)) continue;
        seen.add(aliasParsed.value.matchKey);
        aliases.push(aliasParsed.value.normalized);
      }
      if (aliases.length) def.aliases = aliases.slice(0, LIMITS.aliasesPerEnv);
    }

    if (env.confirmOnEnter === true) def.confirmOnEnter = true;
    if (env.border === true) legacyFrame = true;
    if (env.tabIcon === true) legacyTabIcon = true;

    environments.push(def);
  }

  const timestamp = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

  const group: EnvGroup = {
    id,
    schemaVersion: SCHEMA_VERSION,
    title: title.slice(0, LIMITS.titleMax),
    environments,
    createdAt: timestamp(input.createdAt),
    updatedAt: timestamp(input.updatedAt),
  };

  if (typeof input.description === 'string' && input.description.trim()) {
    group.description = input.description.trim().slice(0, LIMITS.descriptionMax);
  }

  const stored =
    typeof input.indicator === 'object' && input.indicator !== null
      ? (input.indicator as Record<string, unknown>)
      : {};

  const indicator: NonNullable<EnvGroup['indicator']> = {};
  if (stored.hidden === true) indicator.hidden = true;

  // A stored tri-state wins over the legacy flag. Once someone has set the group's own
  // switch, an old per environment flag left behind in the same record is stale, and
  // reapplying it would make the group's setting impossible to turn off.
  if (isTristate(stored.frame) && stored.frame !== 'default') indicator.frame = stored.frame;
  else if (legacyFrame) indicator.frame = 'on';

  if (isTristate(stored.tabIcon) && stored.tabIcon !== 'default') {
    indicator.tabIcon = stored.tabIcon;
  } else if (legacyTabIcon) indicator.tabIcon = 'on';

  if (Object.keys(indicator).length > 0) group.indicator = indicator;

  return group;
}

/** Aliases worth offering for a base URL the user just typed. */
export function suggestedAliases(baseUrl: string): string[] {
  const parsed = parseBaseUrl(baseUrl);
  return parsed.ok ? loopbackAliasesFor(parsed.value) : [];
}

/** Environment slots not yet used by a draft, in canonical pipeline order. */
/**
 * Environments the group is not currently using, in pipeline order.
 *
 * Counts a REMOVED environment as available. Removing one only switches it off; its base URL,
 * aliases and label are kept, so adding it back restores what was there rather than handing
 * back an empty row. That is the whole point of removing rather than deleting: taking an
 * environment out of a group is usually temporary, and retyping its URL to bring it back is a
 * pointless tax.
 */
export function availableEnvKeys(draft: GroupDraft): EnvKey[] {
  const active = new Set(draft.environments.filter((env) => env.enabled).map((env) => env.key));
  return ENV_KEYS.filter((key) => !active.has(key));
}

/** The remembered, currently removed row for an environment, if there is one. */
export function removedEnvironment(
  draft: GroupDraft,
  key: EnvKey,
): EnvironmentDraft | undefined {
  return draft.environments.find((env) => env.key === key && !env.enabled);
}

/** Groups the issues by field path, for rendering next to inputs. */
export function issuesByPath(issues: ValidationIssue[]): Map<string, ValidationIssue[]> {
  const map = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    const list = map.get(issue.path);
    if (list) list.push(issue);
    else map.set(issue.path, [issue]);
  }
  return map;
}
