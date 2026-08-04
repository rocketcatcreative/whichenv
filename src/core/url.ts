/**
 * Base URL parsing and normalization.
 *
 * Every URL in the extension passes through here so that one set of rules
 * governs what counts as "the same environment". Pure and dependency free:
 * no chrome.* and no DOM, so it is trivially unit testable, and it is.
 *
 * The rule that matters most: a match key always carries an EXPLICIT port.
 * `http://localhost` and `http://localhost:80` are the same server, and treating
 * them as two environments would be a silent, maddening bug. Almost every local
 * site is localhost on a different port, so the port is frequently the only thing
 * telling one group's local environment from another's.
 */

export type Scheme = 'http' | 'https';

export const DEFAULT_PORTS: Readonly<Record<Scheme, number>> = {
  http: 80,
  https: 443,
};

/** Hostnames that always mean "this machine". */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Suffixes conventionally used for local development hosts. */
const LOCAL_SUFFIXES = ['.localhost', '.test', '.local', '.internal'];

/** Single-label suffixes a wildcard may stop at, because they are local conventions. */
const BARE_WILDCARD_SUFFIXES = new Set(['localhost', 'test', 'local', 'internal']);

/**
 * The one wildcard form accepted: a single leading label, and nothing else.
 *
 * Deliberately not user-authored regex. A pattern supplied by a user runs against every
 * URL visited, and one catastrophic backtracking case is a hung browser on every page
 * load. `*.` covers what people actually need (hostnames that cannot be written down in
 * advance) with a shape that cannot be slow and cannot be ambiguous.
 */
export const WILDCARD_PREFIX = '*.';

export interface ParsedBase {
  scheme: Scheme;
  /**
   * Lowercased hostname without the port. IPv6 keeps its brackets, and a wildcard host
   * keeps its leading `*.`, so this is always what the user wrote, canonicalized.
   */
  host: string;
  /**
   * Set only for a wildcard host: the part after `*.`, which is what a live hostname is
   * matched against.
   *
   * Kept alongside `host` rather than replacing it so that `origin`, `matchKey`, `display`
   * and `normalized` all derive from one field and cannot disagree about whether the star
   * is part of the identity. It is: `*.acme.dev` and `acme.dev` are different entries, and
   * one group may legitimately hold both.
   */
  wildcardSuffix?: string;
  /** Always explicit. Filled in from the scheme when the input omitted it. */
  port: number;
  /** '' or a path with a leading slash and no trailing slash, e.g. '/shop'. */
  basePath: string;
  /** `scheme://host:port` with the port ALWAYS present. Internal use. */
  origin: string;
  /** `host` or `host:port`, omitting the port when it is the scheme default. */
  authority: string;
  /**
   * The canonical key an environment is identified by: origin plus base path,
   * with an explicit port. Two environments with the same match key are the same
   * environment, full stop.
   */
  matchKey: string;
  /** Short form for UI: 'acme.com', 'localhost:3000', 'acme.com/shop'. */
  display: string;
  /** Canonical storage form. Omits the port when it is the scheme default. */
  normalized: string;
}

export interface UrlIssue {
  code: string;
  message: string;
}

export type ParseBaseResult =
  | { ok: true; value: ParsedBase; notices: UrlIssue[] }
  | { ok: false; error: UrlIssue };

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** Whether a host is written as a wildcard, without judging whether it is a legal one. */
export function isWildcardHost(host: string): boolean {
  return host.startsWith(WILDCARD_PREFIX);
}

export interface WildcardIssue {
  code: string;
  message: string;
}

/**
 * Why a host containing a star is not usable, or null when it is fine.
 *
 * Triggered by the STAR, not by the `*.` prefix, which is the important part. `URL`
 * happily accepts `**.a.com`, `*a.com`, `a.*.com` and `*.dev` as hostnames, so without
 * this every one of them would be stored as an ordinary host that silently never matches
 * anything. Failing loudly at the field is the only version of this anyone can debug.
 *
 * Kept here rather than in schema.ts so the matcher, the permission layer and the
 * validator all agree on which wildcards exist.
 */
export function wildcardIssue(host: string): WildcardIssue | null {
  if (!host.includes('*')) return null;

  const suffix = host.slice(WILDCARD_PREFIX.length);

  // Anything other than exactly one leading `*.` label.
  if (!isWildcardHost(host) || !suffix || suffix.includes('*')) {
    return {
      code: 'wildcard-shape',
      message: 'A wildcard has to be a single leading "*.", as in *.preview.acme.dev.',
    };
  }

  // An IP address has no subdomains, so a wildcard over one can never match anything.
  if (suffix.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(suffix)) {
    return {
      code: 'wildcard-ip',
      message: 'An IP address has no subdomains, so a wildcard cannot match it.',
    };
  }

  // `*.dev` would match every site on the TLD, and the permission prompt would say so.
  // Local conventions are the exception: `*.localhost` and `*.test` are exactly how
  // multi-site local setups are addressed, and they never leave the machine.
  if (!suffix.includes('.') && !BARE_WILDCARD_SUFFIXES.has(suffix)) {
    return {
      code: 'wildcard-too-broad',
      message: `"*.${suffix}" would match every site ending in .${suffix}. Add a domain, like *.preview.${suffix}.`,
    };
  }

  return null;
}

/**
 * Whether a live hostname falls under a wildcard suffix.
 *
 * The bare suffix counts, matching Chrome's own reading of `*.example.com`, which covers
 * `example.com` as well as its subdomains. Worth keeping identical: the host permission
 * this produces is a Chrome pattern, so anything we matched but Chrome did not grant would
 * be an environment that resolves and then cannot draw its indicator.
 */
export function hostUnderWildcard(host: string, suffix: string): boolean {
  const lower = host.toLowerCase();
  return lower === suffix || lower.endsWith(`.${suffix}`);
}

/** True for hosts that conventionally live on the developer's own machine. */
export function isLocalHost(host: string): boolean {
  const lower = host.toLowerCase();
  return isLoopbackHost(lower) || LOCAL_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Whether the raw input spelled out a port.
 *
 * Needed separately from the parsed port, because the parsed port is always
 * explicit. A bare `http://localhost` is legal but almost certainly a mistake
 * (port 80 is not where dev servers live, and every group that does the same
 * thing will collide), so the editor warns about it.
 */
export function hasExplicitPort(input: string): boolean {
  return /:\d+(?:[/?#]|$)/.test(stripScheme(input.trim()));
}

function stripScheme(input: string): string {
  return input.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
}

/**
 * Guesses a scheme for input that omitted one.
 *
 * Local hosts get http, everything else https. Getting this wrong is cheap and
 * visible: parseBaseUrl reports the assumption as a notice, and the editor writes
 * the normalized value back into the field so you can see exactly what was
 * stored.
 */
function inferScheme(hostish: string): Scheme {
  const host = hostish.split('/')[0]?.split(':')[0] ?? '';
  return isLocalHost(host) ? 'http' : 'https';
}

/**
 * Parses and canonicalizes a base URL.
 *
 * Total: never throws. Returns either a normalized ParsedBase plus notices about
 * anything that was changed, or a single error explaining why the input is not
 * usable as a base URL.
 */
export function parseBaseUrl(input: string): ParseBaseResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { ok: false, error: { code: 'empty', message: 'Enter a base URL.' } };
  }

  const notices: UrlIssue[] = [];
  let candidate = trimmed;

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(candidate);
  if (!schemeMatch) {
    // A leading `word:` is ambiguous: it is a scheme in `mailto:a@b.c`, but a
    // host and port in `localhost:3000`. Digits followed by end-of-input or a
    // path delimiter mean it is a port, which is by far the more common thing
    // someone types into this field.
    const looksSchemeLike = /^[a-z][a-z0-9+.-]*:/i.test(candidate);
    const looksHostPort = /^[a-z0-9][a-z0-9.-]*:\d+(?:[/?#]|$)/i.test(candidate);

    if (looksSchemeLike && !looksHostPort) {
      // Something like "mailto:" or "chrome:" with no authority.
      return {
        ok: false,
        error: {
          code: 'unsupported-scheme',
          message: 'Only http and https URLs are supported.',
        },
      };
    }
    const inferred = inferScheme(candidate);
    candidate = `${inferred}://${candidate}`;
    notices.push({
      code: 'scheme-assumed',
      message: `No scheme given, so ${inferred}:// was assumed.`,
    });
  } else {
    const scheme = schemeMatch[1]?.toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      return {
        ok: false,
        error: {
          code: 'unsupported-scheme',
          message: `${scheme}:// is not supported. Use http or https.`,
        },
      };
    }
  }

  // Checked BEFORE handing the string to `URL`, for two reasons. `URL` throws on
  // `*.192.168.1.10` (it tries to read the last label as IPv4) and would report that as
  // "not a valid URL", which tells someone nothing about what they did wrong. And it
  // accepts the other malformed shapes outright, so there would be nothing to catch after.
  const rawHost = rawHostOf(candidate);
  const badWildcard = wildcardIssue(rawHost);
  if (badWildcard) return { ok: false, error: badWildcard };

  const wildcard = isWildcardHost(rawHost);
  if (wildcard) {
    // The star is removed before parsing and put back after, because URL implementations do
    // not agree on it. Chromium percent-encodes `*` in a hostname to `%2a`; Node leaves it
    // alone. Reading the host back off the parsed URL therefore produced a wildcard in the
    // unit suite and a host literally named "%2a.localhost" in the browser, which matched
    // nothing and looked like the feature simply did not work.
    //
    // `replace` with a string hits the FIRST occurrence only, and the host precedes the
    // path, so this can only ever take the star off the front of the hostname.
    candidate = candidate.replace(WILDCARD_PREFIX, '');
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: { code: 'unparseable', message: 'That is not a valid URL.' } };
  }

  if (!url.hostname) {
    return { ok: false, error: { code: 'no-host', message: 'That URL has no hostname.' } };
  }

  const scheme = url.protocol.replace(':', '') as Scheme;

  if (url.username || url.password) {
    notices.push({
      code: 'credentials-stripped',
      message: 'Credentials were removed from the URL.',
    });
  }

  if (url.search) {
    notices.push({
      code: 'query-stripped',
      message: 'The query string was removed. Base URLs are just scheme, host and path.',
    });
  }

  if (url.hash) {
    notices.push({
      code: 'hash-stripped',
      message: 'The fragment was removed. Base URLs are just scheme, host and path.',
    });
  }

  // URL keeps IPv6 brackets in hostname, which is what we want for round tripping.
  const host = wildcard
    ? `${WILDCARD_PREFIX}${url.hostname.toLowerCase()}`
    : url.hostname.toLowerCase();
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[scheme];

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: { code: 'bad-port', message: 'Port must be between 1 and 65535.' } };
  }

  // Collapse duplicate slashes and drop any trailing slash. '/' becomes ''.
  const basePath = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');

  if (basePath !== url.pathname.replace(/\/+$/, '')) {
    notices.push({
      code: 'path-collapsed',
      message: 'Duplicate slashes in the path were collapsed.',
    });
  }

  return { ok: true, notices, value: baseFrom({ scheme, host, port, basePath }) };
}

/**
 * The hostname out of a scheme-bearing string, without going through `URL`.
 *
 * Only used for the wildcard pre-check, which has to happen before `URL` sees the input.
 * Strips userinfo and the port; leaves IPv6 brackets alone, where there is never a star.
 */
function rawHostOf(withScheme: string): string {
  const authority = stripScheme(withScheme).split(/[/?#]/)[0] ?? '';
  const hostAndPort = authority.split('@').pop() ?? '';
  return hostAndPort.replace(/:\d*$/, '').toLowerCase();
}

/** Assembles the derived fields of a ParsedBase from its four independent ones. */
function baseFrom(parts: {
  scheme: Scheme;
  host: string;
  port: number;
  basePath: string;
}): ParsedBase {
  const { scheme, host, port, basePath } = parts;
  const isDefaultPort = port === DEFAULT_PORTS[scheme];
  const origin = `${scheme}://${host}:${port}`;
  const authority = isDefaultPort ? host : `${host}:${port}`;

  return {
    scheme,
    host,
    port,
    basePath,
    origin,
    authority,
    matchKey: `${origin}${basePath}`,
    display: `${authority}${basePath}`,
    normalized: `${scheme}://${authority}${basePath}`,
    ...(isWildcardHost(host) ? { wildcardSuffix: host.slice(WILDCARD_PREFIX.length) } : {}),
  };
}

/**
 * The same base with a real hostname in place of its wildcard.
 *
 * This is what makes a wildcard usable as an origin to switch AWAY from. Translation
 * requires `from.origin` to equal the tab's actual origin, so the matcher hands
 * downstream code a base pinned to the host the tab is really on. Without it, switching
 * off a preview deploy would compute a target from `https://*.preview.acme.dev` and get
 * nothing.
 *
 * Scheme, port and base path stay as written: the wildcard covers the hostname only.
 */
export function concreteBase(base: ParsedBase, host: string): ParsedBase {
  if (!base.wildcardSuffix) return base;
  return baseFrom({
    scheme: base.scheme,
    host: host.toLowerCase(),
    port: base.port,
    basePath: base.basePath,
  });
}

/** Convenience wrapper for callers that only care about success. */
export function tryParseBaseUrl(input: string): ParsedBase | null {
  const result = parseBaseUrl(input);
  return result.ok ? result.value : null;
}

/**
 * Canonical match key for a full page URL, for use by the matcher in Phase 2.
 *
 * Deliberately shares parseBaseUrl's normalization so a tab and a stored base URL
 * can never disagree about what counts as the same origin.
 */
export function matchKeyForUrl(href: string): string | null {
  const parsed = tryParseBaseUrl(href);
  return parsed ? parsed.matchKey : null;
}

/**
 * The other spellings of the same loopback server.
 *
 * Chrome treats `localhost:3000` and `127.0.0.1:3000` as different origins even
 * though they are the same dev server, so the editor offers the counterparts as
 * aliases rather than making you notice the problem yourself.
 */
export function loopbackAliasesFor(base: ParsedBase): string[] {
  if (base.wildcardSuffix || !isLoopbackHost(base.host)) return [];

  const suffix = `:${base.port}${base.basePath}`;
  const candidates = ['localhost', '127.0.0.1', '[::1]']
    .filter((host) => host !== base.host)
    .map((host) => `${base.scheme}://${host}${suffix}`);

  return candidates;
}
