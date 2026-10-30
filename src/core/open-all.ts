/**
 * Opening every environment in a group at once.
 *
 * The switcher answers "take me to staging". This answers a different question: "show me
 * all of them, side by side, right now." That is what you want before a release, or when
 * a bug reproduces on one environment and you need to know which others have it.
 *
 * The whole set goes into one Chrome tab group, in PIPELINE order rather than the order
 * the group is configured in. Configured order is a per-group preference and it drives
 * the switcher list; a wall of tabs is a different thing, and the useful property there
 * is that the leftmost tab is always the safest environment and the rightmost is always
 * production. That holds across every group, so the strip reads the same way every time.
 *
 * Pure and dependency free: no chrome.* and no DOM. The worker does the opening.
 */

import { byPipelineOrder, type EnvKey } from './palette';
import { switchTargets, type Match } from './match';

export interface OpenAllStop {
  envKey: EnvKey;
  label: string;
  url: string;
  confirmOnEnter: boolean;
  /** True for the environment the tab is already on, which is never opened again. */
  current: boolean;
}

/**
 * Every environment in the group that has somewhere to go, in pipeline order.
 *
 * Built on `switchTargets`, so it inherits every exclusion that already applies to the
 * switcher: disabled rows, unparseable base URLs, wildcards with no single destination,
 * and paths that do not translate. The environment the tab is already on is added back,
 * because `switchTargets` omits it by design and here it is a stop like any other.
 */
export function openAllPlan(match: Match, currentUrl: string): OpenAllStop[] {
  const stops: OpenAllStop[] = [
    {
      envKey: match.envKey,
      label: match.label,
      url: currentUrl,
      // The guard is about ENTERING an environment. You are already here.
      confirmOnEnter: false,
      current: true,
    },
    ...switchTargets(match, currentUrl).map((target) => ({
      envKey: target.envKey,
      label: target.label,
      url: target.url,
      confirmOnEnter: target.confirmOnEnter,
      current: false,
    })),
  ];

  return stops.sort((a, b) => byPipelineOrder(a.envKey, b.envKey));
}

/**
 * Whether this action would enter a guarded environment, and so needs confirming.
 *
 * Takes the sibling list rather than a plan so both surfaces can ask the question from
 * what they already have, and so there is one definition of it instead of two. One
 * confirm covers the whole action: the alternative is a per-environment prompt for a
 * button whose entire purpose is opening several at once.
 */
export function guardsInPlay(siblings: readonly { confirmOnEnter: boolean }[]): boolean {
  return siblings.some((sibling) => sibling.confirmOnEnter);
}

/**
 * Normalises a URL for "is this tab already showing this?".
 *
 * A trailing slash on the root path is the only difference worth forgiving. `https://acme.com`
 * and `https://acme.com/` are the same page and the two sides of this comparison genuinely
 * disagree about it: one comes from `translateUrl`, the other from whatever Chrome reports for
 * an open tab. Query and fragment are kept, because a tab on `?tab=2` is not the tab you asked
 * for and SPA routes live in the fragment often enough to matter.
 */
function normalizeForCompare(url: string): string | null {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

/** Whether an already-open tab is showing the page a stop would open. */
export function sameTarget(a: string, b: string): boolean {
  const left = normalizeForCompare(a);
  return left !== null && left === normalizeForCompare(b);
}
