/**
 * The message protocol between the content script, the popup and the service
 * worker.
 *
 * The service worker owns matching and navigation. The content script owns
 * rendering and knows nothing about groups, storage or URL rules. That split is
 * why the content script bundle stays small and why the interesting logic is
 * testable without a browser.
 *
 * Target URLs are deliberately NOT part of the resolve response. They are computed
 * at switch time from the URL the tab is on right then, so a single page app that
 * has changed route since the indicator rendered still switches to the route you
 * are actually looking at.
 */

import type { EnvKey, PaletteId } from './palette';
import type { Corner, FrameWidth, IndicatorSize } from './settings';

export type OpenMode = 'current' | 'newTab' | 'newWindow';

/** What the indicator needs in order to render. */
export interface ResolvedTab {
  groupId: string;
  groupTitle: string;
  envKey: EnvKey;
  /** Display label for the current environment, honouring any override. */
  label: string;
  /** Whether this group asks for the indicator to be hidden on its sites. */
  hidden: boolean;
  /**
   * Whether to frame the viewport in this environment's colour.
   *
   * Already resolved: the group's tri-state applied over the global default. The content
   * script never sees the tri-state, so there is one place that decides and it is unit
   * tested.
   */
  frame: boolean;
  /** Whether to mark the tab icon. Resolved the same way as the frame. */
  tabIcon: boolean;
  /** The other environments, without URLs. See the note above. */
  siblings: {
    envKey: EnvKey;
    label: string;
    display: string;
    confirmOnEnter: boolean;
  }[];
  /** Global indicator settings, sent along to save a second round trip. */
  corner: Corner;
  indicatorSize: IndicatorSize;
  /** How thick the frame is, when there is one. Sent even when `frame` is false. */
  frameWidth: FrameWidth;
  autoCollapseMs: number;
  /**
   * The active colour set.
   *
   * Sent rather than read from storage by the content script so the pill's colours and
   * its position always come from the same snapshot. Reading them separately would let
   * the two disagree for a frame after a change.
   */
  paletteId: PaletteId;
  /**
   * Whether a plain selection opens a new tab.
   *
   * The modifier INVERTS this rather than forcing a new tab, which is the
   * conventional behaviour and the only way the setting can mean anything: if
   * Cmd-click always meant "new tab", someone who prefers new tabs by default would
   * have no gesture left for replacing the current one.
   */
  openInNewTabByDefault: boolean;
}

export type Request =
  | { type: 'resolve'; url: string }
  /**
   * Asks for the URL a switch WOULD go to, without going there.
   *
   * Exists so the switcher can offer "copy this environment's link" while target URLs stay
   * out of the content script, per the note above. The worker still computes the
   * destination; the content script only receives one on request and only to put it on the
   * clipboard, which it can do reliably because it has a focused document and the worker
   * does not.
   */
  | { type: 'urlFor'; groupId: string; envKey: EnvKey; url: string }
  | { type: 'switch'; groupId: string; envKey: EnvKey; url: string; mode: OpenMode }
  | { type: 'hideForTab' }
  | { type: 'openOptions' };

export type Response =
  | { type: 'resolved'; tab: ResolvedTab | null }
  | { type: 'url'; url: string }
  | { type: 'switched'; ok: true; url: string }
  | { type: 'error'; message: string }
  | { type: 'ok' };

/** Sent from the service worker to a tab's content script, not a reply. */
export type Push =
  | { type: 'refresh' }
  | { type: 'hide' }
  | { type: 'openSwitcher' };

/**
 * Typed wrapper around sendMessage.
 *
 * Resolves to null rather than throwing when the service worker is not reachable.
 * That happens routinely: the worker may be asleep, or the extension may have just
 * been reloaded while a page is still open. An indicator that quietly does not
 * render is far better than one that throws into the host page's console.
 */
export async function send(request: Request): Promise<Response | null> {
  try {
    return (await chrome.runtime.sendMessage(request)) as Response;
  } catch {
    return null;
  }
}
