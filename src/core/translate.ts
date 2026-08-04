/**
 * URL translation: the same page, on a different environment.
 *
 * One of the two functions the whole product rests on. Pure and dependency free,
 * so every rule below is directly unit tested.
 *
 * Given where you are and where you want to go:
 *
 *   current:      https://staging.acme.com/shop/products/42?ref=email#reviews
 *   matched base: https://staging.acme.com
 *   target base:  http://localhost:3000
 *   result:       http://localhost:3000/shop/products/42?ref=email#reviews
 *
 * Scheme, host and port always come from the TARGET, never the source, which is
 * what lets a single hop cross from https on 443 to http on 3000.
 */

import { DEFAULT_PORTS, type ParsedBase, type Scheme } from './url';

/**
 * Removes a base path prefix from a pathname, segment-aware.
 *
 * The segment awareness is the point. A base path of `/shop` covers `/shop` and
 * `/shop/items`, but NOT `/shopping`, which a naive `startsWith` would happily
 * mangle into nonsense.
 *
 * Returns null when the pathname is not under the base path at all.
 */
export function stripBasePath(pathname: string, basePath: string): string | null {
  if (!basePath) return pathname;
  if (pathname === basePath) return '';
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return null;
}

/** Joins a target base path and a remainder without doubling or dropping slashes. */
export function joinPath(basePath: string, remainder: string): string {
  if (!basePath) return remainder;
  if (!remainder || remainder === '/') return basePath;
  return `${basePath}${remainder.startsWith('/') ? '' : '/'}${remainder}`;
}

function explicitPort(url: URL): number {
  const scheme = url.protocol.replace(':', '');
  if (url.port) return Number(url.port);
  return DEFAULT_PORTS[scheme as Scheme] ?? 0;
}

/** The origin of a live URL, in the same explicit-port form as ParsedBase.origin. */
export function originOf(url: URL): string {
  return `${url.protocol.replace(':', '')}://${url.hostname.toLowerCase()}:${explicitPort(url)}`;
}

/**
 * Rewrites `currentUrl` from one environment to another.
 *
 * Returns null when the current URL is not actually under `from`, so a caller that
 * passes a mismatched pair gets nothing rather than a plausible wrong answer.
 *
 * The result is canonicalized through `URL`, which means an empty path comes back
 * as `/`. That is deliberate: it is always a valid absolute URL, and browsers
 * display `https://acme.com/` as `acme.com` anyway.
 */
export function translateUrl(
  currentUrl: string,
  from: ParsedBase,
  to: ParsedBase,
): string | null {
  let url: URL;
  try {
    url = new URL(currentUrl);
  } catch {
    return null;
  }

  const scheme = url.protocol.replace(':', '');
  if (scheme !== 'http' && scheme !== 'https') return null;

  // The current URL must belong to `from`, port and all.
  if (originOf(url) !== from.origin) return null;

  const remainder = stripBasePath(url.pathname, from.basePath);
  if (remainder === null) return null;

  const path = joinPath(to.basePath, remainder);

  // Query and fragment carry over untouched. Credentials do not: `url.username`
  // and `url.password` are simply never read.
  const raw = `${to.scheme}://${to.authority}${path}${url.search}${url.hash}`;

  try {
    return new URL(raw).href;
  } catch {
    return null;
  }
}

/**
 * Whether a URL sits under a base, using the same rules as translation.
 *
 * Exposed so the matcher and the translator cannot drift apart on what "under"
 * means.
 */
export function isUnder(currentUrl: string, base: ParsedBase): boolean {
  try {
    const url = new URL(currentUrl);
    const scheme = url.protocol.replace(':', '');
    if (scheme !== 'http' && scheme !== 'https') return false;
    return originOf(url) === base.origin && stripBasePath(url.pathname, base.basePath) !== null;
  } catch {
    return false;
  }
}
