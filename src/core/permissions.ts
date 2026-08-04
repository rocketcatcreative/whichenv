/**
 * Host permissions, requested per origin.
 *
 * The extension asks for nothing at install time beyond `storage`, `scripting` and
 * `tabGroups`. Access to a site is requested when you save a group that mentions
 * it, and given up again when no group needs it. That is both the honest privacy
 * position and the easiest story to tell in a Chrome Web Store review: a URL
 * switcher has no business reading every page you visit.
 *
 * Two constraints from Chrome's match pattern syntax shape this file:
 *
 *  - A port is optional in a match pattern and behaves as `:*` when omitted, so
 *    host permissions are per HOST, not per host and port. `localhost:3000` and
 *    `localhost:3001` are different environments but a single permission.
 *  - IPv6 literal hosts are not supported in match patterns at all, so an
 *    `http://[::1]:3000` alias cannot be granted and is filtered out here rather
 *    than causing the whole request to fail.
 */

import type { EnvGroup } from './schema';
import { parseBaseUrl, type ParsedBase } from './url';

/**
 * Patterns already covered by the manifest, in both `host_permissions` and
 * `content_scripts`.
 *
 * Loopback hosts are the developer's own machine, and covering them by default is
 * what lets the extension work on a local site the moment it is installed, with no
 * prompt at all. Every remote origin goes through an explicit request.
 *
 * They appear in `host_permissions` as well as `content_scripts` because reading a
 * tab's URL, which the toolbar badge needs, requires host access. A content script
 * match alone does not confer it under Manifest V3.
 */
export const STATIC_MATCHES: readonly string[] = ['http://localhost/*', 'http://127.0.0.1/*'];

/** The broad grant, if a user ever chooses to give it. */
export const ALL_URLS = '*://*/*';

/**
 * The match pattern covering a base URL, or null if it cannot be expressed.
 *
 * Deliberately drops the port: Chrome treats a portless pattern as all ports, and
 * host permissions are stored per host anyway.
 */
export function patternFor(base: ParsedBase): string | null {
  if (base.host.startsWith('[')) return null; // IPv6 literal, unsupported
  return `${base.scheme}://${base.host}/*`;
}

export function isStaticallyCovered(pattern: string): boolean {
  return STATIC_MATCHES.includes(pattern);
}

/**
 * Every match pattern covering a group's origins, loopback included.
 *
 * Separate from `patternsFor` because the two callers want different things: a permission
 * request must skip what the manifest already grants statically, while a context menu
 * filter must cover every origin the group can match, loopback and all.
 */
export function matchPatternsForAll(groups: readonly EnvGroup[]): string[] {
  return [...new Set(groups.flatMap(matchPatternsFor))].sort();
}

/**
 * Every pattern a group needs GRANTING in order to show its indicator.
 *
 * Sorted and deduplicated so the result is stable, which keeps the "is anything
 * missing" comparison cheap and makes tests readable.
 */
export function matchPatternsFor(group: EnvGroup): string[] {
  const patterns = new Set<string>();

  for (const env of group.environments) {
    if (!env.enabled) continue;
    for (const candidate of [env.baseUrl, ...(env.aliases ?? [])]) {
      const parsed = parseBaseUrl(candidate);
      if (!parsed.ok) continue;
      const pattern = patternFor(parsed.value);
      if (pattern) patterns.add(pattern);
    }
  }

  return [...patterns].sort();
}

export function patternsFor(group: EnvGroup): string[] {
  const patterns = new Set<string>();

  for (const pattern of matchPatternsFor(group)) {
    if (!isStaticallyCovered(pattern)) patterns.add(pattern);
  }

  return [...patterns].sort();
}

/** Union of the patterns every group needs. */
export function patternsForAll(groups: readonly EnvGroup[]): string[] {
  return [...new Set(groups.flatMap(patternsFor))].sort();
}

async function grantedOrigins(): Promise<string[]> {
  const all = await chrome.permissions.getAll();
  return all.origins ?? [];
}

/** True when every origin a group needs is already granted. */
export async function hasAccess(group: EnvGroup): Promise<boolean> {
  const needed = patternsFor(group);
  if (needed.length === 0) return true;

  const granted = await grantedOrigins();
  if (granted.includes(ALL_URLS)) return true;

  // Ask Chrome rather than comparing strings: it understands that a granted
  // `*://*.acme.com/*` covers `https://staging.acme.com/*`, which we do not.
  try {
    return await chrome.permissions.contains({ origins: needed });
  } catch {
    return false;
  }
}

/** The patterns a group still needs. Empty when nothing is missing. */
export async function missingFor(group: EnvGroup): Promise<string[]> {
  if (await hasAccess(group)) return [];

  const missing: string[] = [];
  for (const pattern of patternsFor(group)) {
    try {
      if (!(await chrome.permissions.contains({ origins: [pattern] }))) missing.push(pattern);
    } catch {
      missing.push(pattern);
    }
  }
  return missing;
}

/**
 * Requests the origins a group needs.
 *
 * MUST be called synchronously from a user gesture. Chrome drops the gesture across
 * an await, so this has to be the first thing a click handler does, before any
 * saving or validation that involves promises.
 *
 * Returns true when access is held afterwards, including the case where there was
 * nothing to ask for.
 */
export async function requestAccess(group: EnvGroup): Promise<boolean> {
  const needed = patternsFor(group);
  if (needed.length === 0) return true;

  try {
    return await chrome.permissions.request({ origins: needed });
  } catch {
    return false;
  }
}

/**
 * Gives up access to origins no group mentions any more.
 *
 * Deliberately never touches the all-urls grant (see ALL_URLS). If a user has
 * granted blanket access on purpose, quietly revoking it because a group was
 * deleted would be presumptuous, and it is not ours to take back.
 */
export async function pruneAccess(groups: readonly EnvGroup[]): Promise<string[]> {
  const needed = new Set(patternsForAll(groups));
  const granted = await grantedOrigins();

  const stale = granted.filter(
    (pattern) =>
      pattern !== ALL_URLS && !isStaticallyCovered(pattern) && !needed.has(pattern),
  );

  if (stale.length === 0) return [];

  try {
    await chrome.permissions.remove({ origins: stale });
    return stale;
  } catch {
    return [];
  }
}
