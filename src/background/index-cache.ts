/**
 * The match index, cached in `chrome.storage.session`.
 *
 * Service workers are killed aggressively, so module scope cannot be trusted to
 * survive between messages. Rebuilding the index from `chrome.storage.sync` on
 * every resolve would mean a sync read on every page load. `storage.session` sits
 * between the two: in memory, cleared on browser restart, and it survives the
 * worker being torn down.
 *
 * The cache is invalidated by any change to a group key, not by a timer, so it
 * cannot serve stale results after an edit.
 */

import { buildIndex, type MatchIndex } from '@core/match';
import { listGroups } from '@core/storage';
import type { EnvGroup } from '@core/schema';

const CACHE_KEY = 'match:index';

/** Module-scope memo, valid only for as long as this worker instance lives. */
let memo: MatchIndex | null = null;

export async function getIndex(): Promise<MatchIndex> {
  if (memo) return memo;

  const cached = await chrome.storage.session.get(CACHE_KEY);
  const stored = cached[CACHE_KEY] as MatchIndex | undefined;
  // Both buckets have to be present, not just one. `storage.session` outlives an extension
  // reload, so a cache written by a build that predates wildcard matching can still be
  // sitting here; treating it as valid would mean no wildcard resolves until the browser is
  // restarted. Checking the shape rebuilds instead, which costs one sync read, once.
  if (stored && typeof stored === 'object' && 'byOrigin' in stored && 'wildcards' in stored) {
    memo = stored;
    return stored;
  }

  return rebuild();
}

export async function rebuild(groups?: readonly EnvGroup[]): Promise<MatchIndex> {
  const index = buildIndex(groups ?? (await listGroups()));
  memo = index;
  await chrome.storage.session.set({ [CACHE_KEY]: index });
  return index;
}

export function invalidate(): void {
  memo = null;
  void chrome.storage.session.remove(CACHE_KEY);
}
