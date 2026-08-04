/**
 * Inferring a group from a single URL.
 *
 * This is what makes "create a group from this tab" worth having. Filling in four
 * URLs and a title by hand is enough friction to stop people bothering, and an
 * extension nobody sets up does nothing. A guess that is right most of the time and
 * editable the rest of the time is far better than a blank form.
 *
 * Every guess is a starting point shown in the editor, never something saved
 * silently. Being wrong here costs a keystroke, so the heuristics lean toward
 * usefully specific rather than cautiously vague.
 *
 * Pure and dependency free: no chrome.* and no DOM.
 */

import { GUESSABLE_ENV_KEYS, type EnvKey } from './palette';
import { isLocalHost, isLoopbackHost, parseBaseUrl } from './url';

/**
 * Subdomain labels that name an environment.
 *
 * Checked against the FIRST label of the hostname, and also against a trailing
 * `-suffix` on it, so both `staging.acme.com` and `acme-staging.com` are recognised.
 */
const ENV_LABELS: Readonly<Record<string, EnvKey>> = {
  local: 'local',
  dev: 'dev',
  develop: 'dev',
  development: 'dev',
  stage: 'staging',
  staging: 'staging',
  stg: 'staging',
  test: 'qa',
  qa: 'qa',
  uat: 'qa',
  preview: 'preview',
  pr: 'preview',
  demo: 'preview',
  sandbox: 'preview',
};

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

export interface GuessedEnvironment {
  key: EnvKey;
  baseUrl: string;
  enabled: boolean;
  /** True when this came from the tab itself rather than being inferred. */
  fromTab: boolean;
}

export interface GuessedGroup {
  title: string;
  environments: GuessedEnvironment[];
}

/**
 * Which environment a hostname looks like.
 *
 * Defaults to prod, deliberately. An unrecognised hostname is far more likely to be
 * the live site than anything else, and guessing prod puts the red pill on it, which
 * is the safe direction to be wrong in.
 */
export function guessEnvKey(host: string): EnvKey {
  const lower = host.toLowerCase();
  if (isLocalHost(lower)) return 'local';

  const labels = lower.split('.');
  const first = labels[0] ?? '';

  const direct = ENV_LABELS[first];
  if (direct) return direct;

  // `acme-staging.com`, `shop-dev.acme.com`
  const suffixMatch = /-([a-z]+)$/.exec(first);
  const suffixed = suffixMatch?.[1] ? ENV_LABELS[suffixMatch[1]] : undefined;
  if (suffixed) return suffixed;

  return 'prod';
}

/**
 * The apex domain, with any environment or noise label stripped.
 *
 * `staging.acme.com` and `www.acme.com` both give `acme.com`, which is what makes
 * sibling generation possible from any starting environment.
 */
export function apexOf(host: string): string {
  const lower = host.toLowerCase();
  if (isLocalHost(lower) || lower.startsWith('[')) return lower;

  const labels = lower.split('.');
  // Never strip below two labels; `acme.com` must stay `acme.com`.
  while (labels.length > 2) {
    const first = labels[0] ?? '';
    if (ENV_LABELS[first] || NOISE_LABELS.has(first)) labels.shift();
    else break;
  }

  // A single leading noise label on a two-label host, e.g. `www.acme` (rare).
  if (labels.length === 2 && NOISE_LABELS.has(labels[0] ?? '')) labels.shift();

  return labels.join('.');
}

/** The memorable word in a domain: `shop.acme.co.uk` gives `acme`. */
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
export function guessTitle(host: string, pageTitle: string | undefined): string {
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

export interface GuessOptions {
  /** A loopback port known to be free, for the local row. */
  localPort: number;
}

/**
 * Builds a starting group from one URL.
 *
 * The tab's own environment is filled in and enabled. The others are filled in as
 * suggestions but left DISABLED, because a guessed hostname that does not exist would
 * otherwise show up as a switch target that goes nowhere. Ticking one is a deliberate
 * "yes, that is right".
 */
export function guessGroupFromUrl(
  url: string,
  pageTitle: string | undefined,
  options: GuessOptions,
): GuessedGroup | null {
  const parsed = parseBaseUrl(url);
  if (!parsed.ok) return null;

  const { host, scheme, port, authority } = parsed.value;
  const currentKey = guessEnvKey(host);
  const apex = apexOf(host);
  const isLocal = isLocalHost(host);

  const environments: GuessedEnvironment[] = [];

  for (const key of GUESSABLE_ENV_KEYS) {
    if (key === currentKey) {
      // Exactly what the tab is on, port and all.
      environments.push({
        key,
        baseUrl: `${scheme}://${authority}`,
        enabled: true,
        fromTab: true,
      });
      continue;
    }

    if (key === 'local') {
      environments.push({
        key,
        baseUrl: `http://localhost:${options.localPort}`,
        enabled: false,
        fromTab: false,
      });
      continue;
    }

    // A local starting point tells us nothing about remote hostnames, so those rows
    // are left blank rather than guessed from a loopback address.
    if (isLocal) {
      environments.push({ key, baseUrl: '', enabled: false, fromTab: false });
      continue;
    }

    const prefix = key === 'prod' ? '' : `${key}.`;
    const guessedHost = `${prefix}${apex}`;
    const portSuffix = scheme === 'https' && port === 443 ? '' : `:${port}`;
    environments.push({
      key,
      baseUrl: `${scheme}://${guessedHost}${portSuffix}`,
      enabled: false,
      fromTab: false,
    });
  }

  return { title: guessTitle(host, pageTitle), environments };
}
