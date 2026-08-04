/**
 * Choosing which of a page's icons to build the environment mark on top of.
 *
 * Pure and DOM free so it can be tested without a browser. The content script gathers
 * the candidates; the judgement about which one to use lives here.
 */

export interface IconCandidate {
  /** Resolved absolute URL. */
  href: string;
  /** The `sizes` attribute, verbatim. May be absent, a list, or "any". */
  sizes?: string | undefined;
  /** The `rel` attribute, verbatim. */
  rel?: string | undefined;
}

/**
 * Largest declared pixel size, or 0 when unknown.
 *
 * `sizes="any"` means a vector, which scales to anything and therefore wins. A missing
 * or unparseable value scores 0 rather than guessing, so a declared size always beats an
 * undeclared one.
 */
export function iconSize(sizes: string | undefined): number {
  if (!sizes) return 0;
  if (/\bany\b/i.test(sizes)) return Number.MAX_SAFE_INTEGER;

  const values = [...sizes.matchAll(/(\d+)\s*[x×]\s*(\d+)/gi)].map(([, w, h]) =>
    Math.min(Number(w), Number(h)),
  );
  return values.length ? Math.max(...values) : 0;
}

/**
 * Picks the icon most likely to composite well, or null if there is nothing usable.
 *
 * Preference order, and why:
 *
 *  1. Bigger declared size. The mark is drawn at 64px, so a 16px source upscales into
 *     mush while a 180px one downsamples cleanly.
 *  2. An `apple-touch-icon` over a plain `icon` at the same size. They are 180px square
 *     artwork by convention, usually the crispest thing a site ships.
 *  3. Later in the document. Sites append their preferred icon last, and it is also what
 *     Chrome itself tends to settle on.
 *
 * `data:` candidates are kept: they are legal, and reading one into a canvas is fine.
 * `.ico` files are kept too but scored last among equals, since a multi-resolution ICO
 * often decodes to its smallest frame.
 */
export function pickIcon(candidates: readonly IconCandidate[]): string | null {
  let bestHref: string | null = null;
  let bestScore = -1;

  for (const [index, candidate] of candidates.entries()) {
    const href = candidate.href?.trim();
    // A bare `data:,` is a real thing sites use to suppress the default favicon
    // request. It decodes to nothing, so compositing on it would produce an empty icon.
    if (!href || href === 'data:,' || href === 'data:') continue;

    const rel = (candidate.rel ?? '').toLowerCase();
    const score =
      iconSize(candidate.sizes) * 1000 +
      (rel.includes('apple-touch-icon') ? 100 : 0) +
      (/\.ico(\?|#|$)/i.test(href) ? 0 : 10) +
      index;

    // >= rather than > so that, all else equal, the later declaration wins.
    if (score >= bestScore) {
      bestScore = score;
      bestHref = href;
    }
  }

  return bestHref;
}

/**
 * The conventional fallback when a page declares no icon at all.
 *
 * Most sites do not declare one and rely on this; Chrome requests it by convention.
 * Returns null for anything that is not http(s), where the notion does not apply.
 */
export function conventionalIcon(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return new URL('/favicon.ico', url.origin).href;
  } catch {
    return null;
  }
}
