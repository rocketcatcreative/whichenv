/**
 * Swaps the tab's favicon for an environment mark.
 *
 * The destructive part of the feature, hence opt in per environment and fully
 * reversible. Three things make this harder than setting an href:
 *
 *  1. **Chrome picks from all the icon links in the document**, not just the first.
 *     Leaving the site's own links in place and adding ours is a coin flip, so the
 *     originals are detached and remembered, and restored on the way out.
 *  2. **Sites rewrite their own favicon.** Gmail and Slack paint unread counts into
 *     it; SPAs re-render `<head>` on navigation. A one-shot swap gets silently
 *     reverted seconds later, so a MutationObserver re-asserts ours.
 *  3. **Our own writes trigger that observer.** Every mutation is checked against
 *     the element we own before reacting, or this is an infinite loop.
 *
 * Restoring puts the original nodes back rather than re-creating them from their
 * attributes: the site may have set properties or listeners we cannot see, and the
 * original element is the only faithful copy of it.
 *
 * A fourth thing, learned the hard way: a GENERATED icon must be a `data:` URL, and a
 * site with `img-src 'self'` refuses those, along with blob URLs from either origin.
 * Extension resources are exempt from page CSP, so the packaged mark always works and a
 * composited one only works where the page permits it. Hence the two tier approach here:
 * write the packaged mark immediately, then upgrade to the composite if it is available.
 */

import { markFileName } from '@core/marks';
import type { EnvKey, PaletteId } from '@core/palette';
import {
  compositeIcon,
  compositeLooksAllowed,
  knownBlocked,
  onIconRefused,
  rememberBlocked,
} from './composite';

const ICON_SELECTOR = 'link[rel~="icon"], link[rel~="shortcut"], link[rel="shortcut icon"]';

export interface FaviconHandle {
  /** Repaints the mark, for a palette change. */
  update: (palette: PaletteId) => void;
  /** Puts the page's own icons back. */
  restore: () => void;
}

/**
 * Applies the mark for `envKey` and returns a handle to undo it.
 *
 * Returns null when there is no head to write into, which happens on the non-HTML
 * documents Chrome sometimes injects into (a bare XML or plain text response).
 */
export function applyMark(
  envKey: EnvKey,
  palette: PaletteId,
): FaviconHandle | null {
  const head = document.head;
  if (!head) return null;

  interface Displaced {
    node: Element;
    parent: Node;
    next: Node | null;
  }

  /**
   * The icon links present when we took over. Captured once.
   */
  const original: Displaced[] = [];

  /**
   * The most recent icon link the page added AFTER we took over, if any.
   *
   * Only the latest is kept, and deliberately so. A site that repaints its favicon on
   * a timer (an unread count) would otherwise grow this list forever and, on restore,
   * flood the head with dozens of stale links. The page superseded its own earlier
   * icons; the newest one is the only one it would want back.
   */
  let theirLatest: Displaced | null = null;

  let taken = false;

  const detachTheirs = (): void => {
    for (const node of document.querySelectorAll(ICON_SELECTOR)) {
      if (node === ours || !node.parentNode) continue;
      const record: Displaced = { node, parent: node.parentNode, next: node.nextSibling };
      if (taken) theirLatest = record;
      else original.push(record);
      node.remove();
    }
  };

  const ours = document.createElement('link');
  ours.rel = 'icon';
  ours.type = 'image/png';
  // Marked so a restore can find it again even if something moved it, and so the end
  // to end suite can assert on it without guessing at the href.
  ours.dataset.whichenv = envKey;

  /**
   * The packaged solid mark: a real file behind a chrome-extension:// URL.
   *
   * Always available, because extension resources are exempt from the page's CSP. Used
   * immediately so the tab is marked within a frame, and used permanently on any page
   * where the composite cannot be delivered.
   */
  const packaged = (id: PaletteId): string => chrome.runtime.getURL(markFileName(envKey, id));

  let current = palette;

  const write = (id: PaletteId): void => {
    current = id;
    ours.href = packaged(id);
    void upgrade(id);
  };

  /**
   * Replaces the solid mark with the site's own favicon plus an environment bar.
   *
   * Runs after the packaged mark is already showing, so a slow or missing favicon costs
   * nothing: the tab is correctly coloured throughout and simply gains the site's
   * artwork a moment later.
   *
   * The original links have already been detached by the time this runs, which is why the
   * candidates come from what was recorded rather than from a fresh query.
   */
  /**
   * Whether a composite may be attempted at all.
   *
   * Combines what the document's meta tags say with what this origin has already been seen
   * to refuse, and gives up for good the moment the browser refuses one, which is the only
   * way to learn about a header-delivered policy.
   */
  const origin = window.location.origin;

  /**
   * Resolved once: may a composite be attempted on this origin at all?
   *
   * A promise rather than a flag because the session lookup is async and the first upgrade
   * starts immediately. Reading a plain boolean here would race, and the losing side of
   * that race is a console refusal on an origin already known to refuse.
   */
  const permitted: Promise<boolean> = compositeLooksAllowed()
    ? knownBlocked(origin).then((blocked) => !blocked)
    : Promise.resolve(false);

  /** Flipped for good the moment the browser refuses one of ours. */
  let compositeAllowed = true;

  const stopWatchingCsp = onIconRefused(() => {
    // Once refused, stop trying. Retrying on every palette change, or on every page load,
    // would fill the site's own console with the same complaint and read as our bug.
    compositeAllowed = false;
    ours.href = packaged(current);
    void rememberBlocked(origin);
  });

  const upgrade = async (id: PaletteId): Promise<void> => {
    if (!compositeAllowed || !(await permitted)) return;

    const composite = await compositeIcon(
      original.map((entry) => entry.node),
      window.location.href,
      envKey,
      id,
    );

    // Bail on anything that changed underneath: a restore, a palette switch that started
    // its own upgrade while this one was loading, or a refusal that arrived in between.
    if (!composite || !live || !compositeAllowed || id !== current) return;
    ours.href = composite;
  };

  // Order matters: detach first so `original` is populated before upgrade() reads it.
  detachTheirs();
  taken = true;
  write(palette);
  head.append(ours);

  // Re-assert after the page fights back. Batched into a microtask so a head full of
  // rewritten links costs one repair rather than one per node.
  let pending = false;
  let live = true;

  const observer = new MutationObserver((records) => {
    const touchedByThem = records.some((record) =>
      record.type === 'childList'
        ? [...record.addedNodes, ...record.removedNodes].some(
            (node) => node !== ours && node instanceof Element && node.matches(ICON_SELECTOR),
          )
        : record.target !== ours,
    );
    if (!touchedByThem || pending) return;

    pending = true;
    void Promise.resolve().then(() => {
      pending = false;
      // Guarded on an explicit flag, NOT on ours.isConnected. A page that swaps its
      // favicon typically removes every icon link first, ours included, so by the time
      // this runs we are detached: that is precisely the case worth repairing, and
      // testing isConnected here silently skipped it.
      if (!live) return;
      detachTheirs();
      // Last in the document wins in practice, so move back to the end rather than
      // trusting position. Re-appending an attached node moves it; it does not clone.
      head.append(ours);
    });
  });

  observer.observe(head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'rel'] });

  return {
    update: write,
    restore: () => {
      live = false;
      stopWatchingCsp();
      observer.disconnect();
      ours.remove();

      // The page's own later icon supersedes what we found, so it goes back last and
      // therefore wins. Originals are re-inserted in reverse so a run of siblings ends
      // up in its original sequence rather than mirrored.
      for (const { node, parent, next } of [...original].reverse()) {
        try {
          parent.insertBefore(node, next);
        } catch {
          // The parent left the document while we held the mark. Nothing to restore
          // to, and forcing it somewhere else would be worse than leaving it out.
        }
      }
      if (theirLatest) {
        try {
          theirLatest.parent.insertBefore(theirLatest.node, theirLatest.next);
        } catch {
          head.append(theirLatest.node);
        }
      }

      original.length = 0;
      theirLatest = null;
    },
  };
}
