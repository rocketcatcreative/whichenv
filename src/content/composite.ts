/**
 * Builds the tab icon by drawing an environment bar across the bottom of the site's own
 * favicon, rather than replacing it.
 *
 * Replacing it outright was the first design and it was wrong. With a lot of tabs open
 * the site's favicon is how you find the site at all; the environment is the SECOND
 * question, not the first. A bar across the bottom answers the second without destroying
 * the answer to the first.
 *
 * Two things can stop this working, and both fall back to the packaged solid mark rather
 * than failing visibly:
 *
 *  1. **Content Security Policy.** Favicons are fetched under `img-src`, and a composite
 *     has to be generated at page load, so it can only be delivered as a `data:` URL.
 *     A site with `img-src 'self'` refuses that. Measured: `data:`, `blob:` from the
 *     page, and `blob:` from the extension are ALL refused, so there is no way to serve
 *     a generated image to such a page. `dataUrlsAllowed()` finds out before committing.
 *  2. **A tainted canvas.** A cross-origin favicon with no CORS headers cannot be read
 *     back out of a canvas. Same-origin favicons, which is the overwhelming majority,
 *     are fine.
 *
 * The bar is colour only, with no glyph: at the size Chrome draws a tab icon it is about
 * four pixels tall, which fits no shape. That is a real weakening of the rule that colour
 * is never the only signal, and it is why the pill and the toolbar badge keep the glyph
 * and the label, and why this is opt in.
 */

import { allowsDataImages } from '@core/csp';
import { BAR_FRACTION } from '@core/marks';
import { paletteFor, type EnvKey, type PaletteId } from '@core/palette';
import { pickIcon, conventionalIcon, type IconCandidate } from '@core/icon-pick';

/** Rendered at 64: Chrome asks for 16 or 32, and downscaling beats upscaling. */
const SIZE = 64;

/** How long to wait for the site's favicon before giving up on compositing. */
const LOAD_TIMEOUT_MS = 3000;

/**
 * Whether this page's CSP permits a `data:` image, and therefore a composite.
 *
 * Two sources, because a header-delivered CSP is not readable from JavaScript at all:
 *
 *  1. Any `<meta http-equiv="Content-Security-Policy">` in the document. Free to read.
 *  2. Failing that, an optimistic attempt plus a `securitypolicyviolation` listener: if
 *     the browser refuses our icon we hear about it and revert.
 *
 * What this deliberately does NOT do is load a data URL from here and see whether it
 * works. A content script runs in an isolated world and is exempt from the page's CSP for
 * its own requests, so such a probe always says yes, while the browser's favicon fetch,
 * which IS subject to the policy, refuses it. That measured the wrong thing and is why the
 * fallback shipped broken once already.
 */
export function metaPolicies(): string[] {
  return [...document.querySelectorAll('meta[http-equiv]')]
    .filter(
      (node) =>
        (node.getAttribute('http-equiv') ?? '').toLowerCase() === 'content-security-policy',
    )
    .map((node) => node.getAttribute('content') ?? '');
}

/** Verdict from everything readable without provoking the browser. */
export function compositeLooksAllowed(): boolean {
  return allowsDataImages(metaPolicies());
}

const VERDICT_KEY = 'csp:blocked';

/**
 * Origins already known to refuse a generated icon, remembered for the browser session.
 *
 * Without this, every page load on a CSP-restricted site logs one "Refused to load the
 * image" to the site's own console. Once is a diagnosis; on every navigation it reads as a
 * bug in this extension, which is worse than the noise suggests.
 *
 * In `storage.session` rather than module scope because module scope dies with the
 * document, which is exactly the granularity that does not help. The service worker grants
 * content scripts access to it; the values are a list of origins and nothing more.
 */
export async function knownBlocked(origin: string): Promise<boolean> {
  try {
    const stored = await chrome.storage.session.get(VERDICT_KEY);
    const list = stored[VERDICT_KEY];
    return Array.isArray(list) && list.includes(origin);
  } catch {
    // Access not granted, or the worker is mid-restart. Treat as unknown and probe.
    return false;
  }
}

export async function rememberBlocked(origin: string): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(VERDICT_KEY);
    const list: unknown = stored[VERDICT_KEY];
    const origins = new Set(Array.isArray(list) ? (list as string[]) : []);
    origins.add(origin);
    await chrome.storage.session.set({ [VERDICT_KEY]: [...origins] });
  } catch {
    // Nothing to do. The cost is one repeated console message, not a broken icon.
  }
}

/**
 * Calls back if the page refuses one of our generated icons.
 *
 * The safety net for a header-delivered policy, which cannot be read any other way.
 * Chrome reports `blockedURI` for a data URL as just "data", so both forms are matched.
 */
export function onIconRefused(handle: () => void): () => void {
  const listener = (event: Event): void => {
    const violation = event as SecurityPolicyViolationEvent;
    const directive = violation.effectiveDirective || violation.violatedDirective || '';
    if (!/^img-src|^default-src/.test(directive)) return;
    if (!(violation.blockedURI ?? '').startsWith('data')) return;
    handle();
  };

  document.addEventListener('securitypolicyviolation', listener);
  return () => document.removeEventListener('securitypolicyviolation', listener);
}

/** Every icon the document declares, as absolute URLs. */
export function declaredIcons(links: readonly Element[]): IconCandidate[] {
  return links
    .filter((node): node is HTMLLinkElement => node instanceof HTMLLinkElement)
    .map((link) => ({
      // `link.href` resolves relative paths against the document for us.
      href: link.href,
      sizes: link.getAttribute('sizes') ?? undefined,
      rel: link.getAttribute('rel') ?? undefined,
    }));
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (value: HTMLImageElement | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // Ask for CORS so a cross-origin favicon that allows it stays readable. Same-origin
    // requests are unaffected by this, and one that refuses CORS fails onerror, where it
    // is retried without the request below.
    image.crossOrigin = 'anonymous';
    image.onload = () => finish(image);
    image.onerror = () => {
      const plain = new Image();
      plain.onload = () => finish(plain);
      plain.onerror = () => finish(null);
      plain.src = src;
    };
    image.src = src;

    setTimeout(() => finish(null), LOAD_TIMEOUT_MS);
  });
}

/**
 * The site's favicon with an environment bar across the bottom, as a PNG data URL.
 *
 * Returns null when the icon cannot be loaded or read back, which the caller treats as
 * "use the packaged mark instead".
 */
export async function compositeIcon(
  links: readonly Element[],
  pageUrl: string,
  envKey: EnvKey,
  palette: PaletteId,
): Promise<string | null> {
  const source = pickIcon(declaredIcons(links)) ?? conventionalIcon(pageUrl);
  if (!source) return null;

  const image = await loadImage(source);
  if (!image || !image.naturalWidth || !image.naturalHeight) return null;

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext('2d');
  if (!context) return null;

  // Drawn at full size and the bar laid over it, rather than squashing the icon into the
  // space above the bar. Squashing distorts artwork that is usually square, and shrinking
  // it wastes the pixels that identify the site. Most favicons carry edge padding, so the
  // bottom band costs little.
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, SIZE, SIZE);

  const barHeight = Math.round(SIZE * BAR_FRACTION);
  const { bg } = paletteFor(palette).colors[envKey];

  // A hairline of the icon's own backdrop above the bar would need reading pixels back,
  // which a tainted canvas forbids. A flat bar is legible without it.
  context.fillStyle = bg;
  context.fillRect(0, SIZE - barHeight, SIZE, barHeight);

  try {
    return canvas.toDataURL('image/png');
  } catch {
    // Tainted: a cross-origin favicon that allows neither CORS nor readback.
    return null;
  }
}
