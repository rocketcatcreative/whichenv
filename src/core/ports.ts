/**
 * Local port bookkeeping.
 *
 * Because almost every local site is `localhost` on a different port, the port is
 * usually the only thing distinguishing one group's local environment from
 * another's. Two groups on the same port cannot be told apart by any amount of
 * URL inspection, so uniqueness is enforced rather than hoped for, and this module
 * exists to make that constraint feel like a helpful map instead of an arbitrary
 * rejection.
 *
 * Pure and dependency free: no chrome.* and no DOM.
 */

import type { EnvKey } from './palette';
import { matchKeysForEnvironment, type EnvGroup } from './schema';
import { isLoopbackHost, parseBaseUrl, type ParsedBase } from './url';

export interface PortClaim {
  port: number;
  scheme: string;
  host: string;
  basePath: string;
  groupId: string;
  groupTitle: string;
  envKey: EnvKey;
  /** True for the environment's own base URL, false for an alias. */
  primary: boolean;
}

export interface Collision {
  matchKey: string;
  /** Human readable form of the colliding URL. */
  display: string;
  claimants: { groupId: string; groupTitle: string; envKey: EnvKey }[];
}

/**
 * Every loopback port claimed across all groups, in ascending port order.
 *
 * Feeds the port registry in the options page and the port guess when creating a
 * group from the current tab.
 */
/**
 * Whether a base occupies a port on this machine.
 *
 * A wildcard over a loopback suffix counts. `*.localhost:3000` is one dev server on port
 * 3000 serving many hostnames, which is exactly how multi-site local setups are addressed,
 * and the registry's job is to say which local ports are spoken for. Leaving it out would
 * mean suggesting 3000 to the next group as if it were free.
 */
function claimsLoopbackPort(base: ParsedBase): boolean {
  return isLoopbackHost(base.wildcardSuffix ?? base.host);
}

export function loopbackClaims(groups: readonly EnvGroup[]): PortClaim[] {
  const claims: PortClaim[] = [];

  for (const group of groups) {
    for (const env of group.environments) {
      if (!env.enabled) continue;

      const candidates: { value: string; primary: boolean }[] = [
        { value: env.baseUrl, primary: true },
        ...(env.aliases ?? []).map((alias) => ({ value: alias, primary: false })),
      ];

      for (const candidate of candidates) {
        const parsed = parseBaseUrl(candidate.value);
        if (!parsed.ok || !claimsLoopbackPort(parsed.value)) continue;

        claims.push({
          port: parsed.value.port,
          scheme: parsed.value.scheme,
          host: parsed.value.host,
          basePath: parsed.value.basePath,
          groupId: group.id,
          groupTitle: group.title,
          envKey: env.key,
          primary: candidate.primary,
        });
      }
    }
  }

  return claims.sort((a, b) => a.port - b.port || a.groupTitle.localeCompare(b.groupTitle));
}

/** The set of loopback ports already in use, ignoring which group owns them. */
export function claimedLoopbackPorts(groups: readonly EnvGroup[]): Set<number> {
  return new Set(loopbackClaims(groups).map((claim) => claim.port));
}

/** Who, if anyone, already claims a given loopback port. */
export function whoClaimsPort(
  groups: readonly EnvGroup[],
  port: number,
  excludeGroupId?: string,
): PortClaim | null {
  return (
    loopbackClaims(groups).find(
      (claim) => claim.port === port && claim.groupId !== excludeGroupId,
    ) ?? null
  );
}

/**
 * Common dev server defaults, tried in order before falling back to a scan.
 *
 * Suggesting 3000 first and 3001 next matches what people actually run, which
 * makes the suggestion feel like a good guess rather than an arbitrary number.
 */
const PREFERRED_PORTS = [3000, 3001, 4200, 5173, 5174, 8000, 8080, 8081, 8888, 9000];

/**
 * The port to prefill when adding a local environment.
 *
 * Never returns a port another group already claims, which is what keeps the
 * uniqueness constraint from turning into a validation error you have to go and
 * fix by hand.
 */
export function suggestLoopbackPort(
  groups: readonly EnvGroup[],
  preferred?: number,
): number {
  const taken = claimedLoopbackPorts(groups);

  if (preferred !== undefined && isUsablePort(preferred) && !taken.has(preferred)) {
    return preferred;
  }

  for (const port of PREFERRED_PORTS) {
    if (!taken.has(port)) return port;
  }

  // Everything conventional is taken; walk up from 3000 for the first gap.
  for (let port = 3000; port <= 65535; port += 1) {
    if (!taken.has(port)) return port;
  }

  return 3000;
}

function isUsablePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Finds every match key claimed by more than one group.
 *
 * Validation already blocks creating a collision, so this is a safety net for
 * config that arrived another way: an import, a sync merge from another machine,
 * or a change to normalization rules in a later version.
 */
export function findCollisions(groups: readonly EnvGroup[]): Collision[] {
  const byKey = new Map<
    string,
    { display: string; claimants: Collision['claimants'] }
  >();

  for (const group of groups) {
    for (const env of group.environments) {
      if (!env.enabled) continue;

      for (const key of matchKeysForEnvironment(env)) {
        const entry = byKey.get(key);
        const claimant = { groupId: group.id, groupTitle: group.title, envKey: env.key };

        if (entry) {
          // Two environments in the same group are a separate, in-group problem.
          if (!entry.claimants.some((c) => c.groupId === group.id)) {
            entry.claimants.push(claimant);
          }
        } else {
          const parsed = parseBaseUrl(key);
          byKey.set(key, {
            display: parsed.ok ? parsed.value.display : key,
            claimants: [claimant],
          });
        }
      }
    }
  }

  return [...byKey.entries()]
    .filter(([, entry]) => entry.claimants.length > 1)
    .map(([matchKey, entry]) => ({
      matchKey,
      display: entry.display,
      claimants: entry.claimants,
    }));
}
