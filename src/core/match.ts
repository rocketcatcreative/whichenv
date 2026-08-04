/**
 * URL matching: which group and environment does this tab belong to?
 *
 * The other function the whole product rests on. Pure and dependency free.
 *
 * Matching is exact on origin (scheme, host AND port) and longest-prefix on base
 * path. Longest prefix is what lets `acme.com` and `acme.com/shop` be separate
 * groups; exact-on-port is what lets `localhost:3000` and `localhost:3001` be
 * different environments, which is the common case for local development.
 *
 * The index is a plain serializable object so the service worker can cache it in
 * `chrome.storage.session` and skip rebuilding it on every cold start.
 */

import type { EnvKey } from './palette';
import { displayLabel, type EnvGroup, type EnvironmentDef } from './schema';
import { originOf, stripBasePath, translateUrl } from './translate';
import {
  DEFAULT_PORTS,
  concreteBase,
  hostUnderWildcard,
  parseBaseUrl,
  type ParsedBase,
} from './url';

export interface IndexEntry {
  /** Origin with an explicit port, e.g. 'http://localhost:3000'. */
  origin: string;
  /** '' or '/shop'. Never has a trailing slash. */
  basePath: string;
  groupId: string;
  envKey: EnvKey;
  /**
   * The canonical base this entry came from. May be an alias rather than the
   * environment's own base URL, which matters: translation has to strip the base
   * that actually matched, not the one we would have preferred.
   */
  base: ParsedBase;
  isAlias: boolean;
}

export interface MatchIndex {
  /** Entries grouped by origin, each list sorted longest base path first. */
  byOrigin: Record<string, IndexEntry[]>;
  /**
   * Wildcard entries, in one flat list sorted most specific first.
   *
   * A separate bucket rather than a synthetic origin key, because these cannot be looked up
   * by equality: finding them means walking the list. Keeping them out of `byOrigin` is
   * also what makes the ranking rule structural rather than something to remember. Exact
   * matches are consulted first and completely, so a wildcard can never shadow one.
   */
  wildcards: IndexEntry[];
  /** Number of groups the index was built from, for cache sanity checks. */
  groupCount: number;
}

export const EMPTY_INDEX: MatchIndex = { byOrigin: {}, wildcards: [], groupCount: 0 };

/**
 * Builds a lookup index from the stored groups.
 *
 * Only enabled environments are indexed. Thanks to the schema invariant that
 * `enabled` implies a parseable base URL, there is nothing to skip defensively
 * here beyond aliases, which are user-entered and may not parse.
 */
export function buildIndex(groups: readonly EnvGroup[]): MatchIndex {
  const byOrigin: Record<string, IndexEntry[]> = {};
  const wildcards: IndexEntry[] = [];

  const add = (entry: IndexEntry): void => {
    if (entry.base.wildcardSuffix) {
      wildcards.push(entry);
      return;
    }
    const list = byOrigin[entry.origin];
    if (list) list.push(entry);
    else byOrigin[entry.origin] = [entry];
  };

  for (const group of groups) {
    for (const env of group.environments) {
      if (!env.enabled) continue;

      const primary = parseBaseUrl(env.baseUrl);
      if (primary.ok) {
        add({
          origin: primary.value.origin,
          basePath: primary.value.basePath,
          groupId: group.id,
          envKey: env.key,
          base: primary.value,
          isAlias: false,
        });
      }

      for (const alias of env.aliases ?? []) {
        const parsed = parseBaseUrl(alias);
        if (!parsed.ok) continue;
        add({
          origin: parsed.value.origin,
          basePath: parsed.value.basePath,
          groupId: group.id,
          envKey: env.key,
          base: parsed.value,
          isAlias: true,
        });
      }
    }
  }

  // Longest base path first, so the first hit is the most specific one.
  for (const list of Object.values(byOrigin)) {
    list.sort((a, b) => b.basePath.length - a.basePath.length);
  }

  // Longest suffix first, then longest base path, so `*.preview.acme.dev` is consulted
  // before `*.acme.dev` and the more specific wildcard wins. Without this the order would
  // be whatever order the groups happen to be stored in, which is not a rule anyone could
  // predict from looking at their own config.
  wildcards.sort(
    (a, b) =>
      (b.base.wildcardSuffix?.length ?? 0) - (a.base.wildcardSuffix?.length ?? 0) ||
      b.basePath.length - a.basePath.length,
  );

  return { byOrigin, wildcards, groupCount: groups.length };
}

/**
 * Finds the index entry covering a URL, or null.
 *
 * Non-http(s) URLs never match, which is how `chrome://`, `file://`, extension
 * pages and the new tab page stay silent without special casing.
 */
export function lookup(index: MatchIndex, currentUrl: string): IndexEntry | null {
  let url: URL;
  try {
    url = new URL(currentUrl);
  } catch {
    return null;
  }

  const scheme = url.protocol.replace(':', '');
  if (scheme !== 'http' && scheme !== 'https') return null;

  const origin = originOf(url);

  // Exact first, and exhaustively. A wildcard is only ever a fallback, so an origin written
  // out in full always wins, whichever group it belongs to and whatever order they are in.
  for (const entry of index.byOrigin[origin] ?? []) {
    if (stripBasePath(url.pathname, entry.basePath) !== null) return entry;
  }

  const host = url.hostname.toLowerCase();
  for (const entry of index.wildcards ?? []) {
    const suffix = entry.base.wildcardSuffix;
    if (!suffix) continue;
    // The port is still exact. A wildcard covers the hostname and nothing else, which keeps
    // it consistent with the rule that localhost:3000 and localhost:3001 are different
    // environments, and stops one entry quietly claiming every port on a domain.
    if (entry.base.scheme !== scheme) continue;
    if (entry.base.port !== portOf(url, scheme)) continue;
    if (!hostUnderWildcard(host, suffix)) continue;
    if (stripBasePath(url.pathname, entry.basePath) === null) continue;

    // Handed on with the tab's REAL host in place of the star. Everything downstream (the
    // switcher, translation, the copy action) needs an origin it can actually rewrite from,
    // and this is the one place that knows which concrete host matched.
    return { ...entry, origin, base: concreteBase(entry.base, host) };
  }

  return null;
}

function portOf(url: URL, scheme: 'http' | 'https'): number {
  return url.port ? Number(url.port) : DEFAULT_PORTS[scheme];
}

export interface SwitchTarget {
  envKey: EnvKey;
  label: string;
  /** Short host form for the switcher list, e.g. 'localhost:3000'. */
  display: string;
  /** Where selecting this row goes, computed from the current URL. */
  url: string;
  /** Whether entering this environment asks for confirmation first. */
  confirmOnEnter: boolean;
}

export interface Match {
  group: EnvGroup;
  env: EnvironmentDef;
  envKey: EnvKey;
  label: string;
  /** The base that actually matched. May be an alias. */
  matchedBase: ParsedBase;
  matchedViaAlias: boolean;
}

/** Resolves an index hit against the full group list. */
export function resolveMatch(
  groups: readonly EnvGroup[],
  entry: IndexEntry,
): Match | null {
  const group = groups.find((candidate) => candidate.id === entry.groupId);
  if (!group) return null;

  const env = group.environments.find((candidate) => candidate.key === entry.envKey);
  if (!env) return null;

  return {
    group,
    env,
    envKey: env.key,
    label: displayLabel(env),
    matchedBase: entry.base,
    matchedViaAlias: entry.isAlias,
  };
}

/** Convenience for tests and simple callers: build, look up and resolve in one go. */
export function findMatch(groups: readonly EnvGroup[], currentUrl: string): Match | null {
  const entry = lookup(buildIndex(groups), currentUrl);
  return entry ? resolveMatch(groups, entry) : null;
}

/**
 * The other environments in a match's group, with the URL each would open.
 *
 * Computed from the CURRENT url every time rather than cached, so a single page
 * app that has changed route since the indicator rendered still switches to the
 * route you are actually looking at.
 *
 * An environment whose target cannot be computed is omitted rather than offered
 * as a row that would do nothing.
 */
export function switchTargets(match: Match, currentUrl: string): SwitchTarget[] {
  const targets: SwitchTarget[] = [];

  for (const env of match.group.environments) {
    if (!env.enabled || env.key === match.envKey) continue;

    const parsed = parseBaseUrl(env.baseUrl);
    if (!parsed.ok) continue;
    // A wildcard is a place you can arrive, not a place you can be sent. There is no way to
    // pick which host `*.preview.acme.dev` meant, so offering it would be a row that either
    // does nothing or navigates to a literal asterisk. The environment still matches, still
    // colours the tab, and still appears in the group; it just has no destination.
    if (parsed.value.wildcardSuffix) continue;

    const url = translateUrl(currentUrl, match.matchedBase, parsed.value);
    if (!url) continue;

    targets.push({
      envKey: env.key,
      label: displayLabel(env),
      display: parsed.value.display,
      url,
      confirmOnEnter: env.confirmOnEnter === true,
    });
  }

  return targets;
}
