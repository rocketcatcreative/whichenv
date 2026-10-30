/**
 * Naming a group from a single URL.
 *
 * All that is left of what used to be `guess.ts`. That module also invented sibling
 * hostnames (`staging.` + apex, and so on) to prefill the other environments in
 * create-from-tab. Those were wrong far more often than right: environment URLs follow
 * no convention worth betting on, and a plausible-looking wrong URL is worse than a
 * blank field because it reads as authoritative and gets saved unread.
 *
 * A title is a different bet. It is visible in the editor before anything is saved, and
 * being wrong costs one keystroke rather than a switch target pointing somewhere real
 * and unintended. So the title stays and the URLs do not.
 *
 * Pure and dependency free: no chrome.* and no DOM.
 */

import { isLocalHost, isLoopbackHost } from './url';

/**
 * Subdomain labels that name an environment, and so are not part of a site's name.
 *
 * Only used to strip a label off the front of a hostname before naming the group, so
 * `staging.acme.com` is called "Acme" and not "Staging". Nothing here decides which
 * environment anything IS any more.
 */
const ENV_LABELS = new Set([
  'local',
  'dev',
  'develop',
  'development',
  'stage',
  'staging',
  'stg',
  'test',
  'qa',
  'uat',
  'preview',
  'pr',
  'demo',
  'sandbox',
]);

/** Labels that are not environments and should be dropped from the apex. */
const NOISE_LABELS = new Set(['www', 'www2', 'web']);

/**
 * Second-level labels that are really part of a public suffix.
 *
 * A full public suffix list is a megabyte of data and a maintenance commitment, and
 * this is only used to pick a default title, so a short list of the common ones is
 * the right trade. Being wrong means a slightly odd suggested title.
 */
const CC_SLDS = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne']);

/**
 * The apex domain, with any environment or noise label stripped.
 *
 * `staging.acme.com` and `www.acme.com` both give `acme.com`. Used for naming only.
 */
export function apexOf(host: string): string {
  const lower = host.toLowerCase();
  if (isLocalHost(lower) || lower.startsWith('[')) return lower;

  const labels = lower.split('.');
  // Never strip below two labels; `acme.com` must stay `acme.com`.
  while (labels.length > 2) {
    const first = labels[0] ?? '';
    if (ENV_LABELS.has(first) || NOISE_LABELS.has(first)) labels.shift();
    else break;
  }

  // A single leading noise label on a two-label host, e.g. `www.acme` (rare).
  if (labels.length === 2 && NOISE_LABELS.has(labels[0] ?? '')) labels.shift();

  return labels.join('.');
}

/** The memorable word in a domain: `shop.acme.co.uk` gives `Acme`. */
export function siteWordOf(host: string): string {
  const apex = apexOf(host);
  if (isLoopbackHost(apex)) return 'Local site';

  const labels = apex.split('.').filter(Boolean);
  if (labels.length === 0) return apex;
  if (labels.length === 1) return labels[0] ?? apex;

  const secondToLast = labels[labels.length - 2] ?? '';
  // `acme.co.uk`, where the interesting label is one further back.
  const word =
    labels.length >= 3 && CC_SLDS.has(secondToLast)
      ? (labels[labels.length - 3] ?? secondToLast)
      : secondToLast;

  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * A title for the group, from the page title where that is useful.
 *
 * Page titles are usually "Some Page | Site Name", so the last segment is the site
 * name far more often than not. Anything long or empty falls back to the domain,
 * which is short and always sensible.
 */
export function titleFromTab(host: string, pageTitle: string | undefined): string {
  const fallback = siteWordOf(host);
  if (!pageTitle) return fallback;

  const segments = pageTitle
    .split(/[|–—·•»:]/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const candidate = segments.at(-1) ?? '';
  if (!candidate || candidate.length > 40 || candidate.length < 2) return fallback;

  // A segment that is just the hostname adds nothing over the fallback.
  if (candidate.toLowerCase().replace(/^www\./, '') === host.toLowerCase()) return fallback;

  return candidate;
}
