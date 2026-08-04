/**
 * Navigation. The service worker owns this, not the content script.
 *
 * Content scripts could set `location.href` for a same-tab switch, but they cannot
 * open a tab or a window, and a page that is navigating away is a bad place to be
 * running the rest of a switch. Keeping it all here means one code path regardless
 * of how the switch was triggered: the pill, the popup, or a keyboard shortcut.
 *
 * Returns the id of any tab it created, so the caller can put it in a Chrome tab
 * group. The grouping itself lives in tab-groups.ts: it is a convenience layered on
 * top of navigation, not part of it, and it must never be able to break a switch.
 */

import type { OpenMode } from '@core/messages';

export interface NavigateOptions {
  url: string;
  mode: OpenMode;
  /** The tab the switch came from. Required for 'current'. */
  tabId?: number | undefined;
  windowId?: number | undefined;
}

export interface NavigateResult {
  /** The tab a new-tab switch created, if it created one. */
  createdTabId?: number;
  /** The window that tab landed in. */
  createdWindowId?: number;
}

export async function navigate({
  url,
  mode,
  tabId,
  windowId,
}: NavigateOptions): Promise<NavigateResult> {
  switch (mode) {
    case 'current': {
      if (tabId === undefined) {
        // No originating tab, which happens for a switch triggered from the popup
        // against a tab that has since closed. Falling back to a new tab is better
        // than silently doing nothing.
        const created = await chrome.tabs.create({ url });
        return created.id === undefined
          ? {}
          : { createdTabId: created.id, createdWindowId: created.windowId };
      }
      await chrome.tabs.update(tabId, { url });
      return {};
    }

    case 'newTab': {
      const created = await chrome.tabs.create({
        url,
        // Open immediately after the tab it came from rather than at the end of
        // the strip, so a switch keeps related tabs together.
        ...(tabId === undefined ? {} : { openerTabId: tabId }),
        ...(windowId === undefined ? {} : { windowId }),
        active: true,
      });
      return created.id === undefined
        ? {}
        : { createdTabId: created.id, createdWindowId: created.windowId };
    }

    case 'newWindow': {
      // Deliberately not grouped. Opening a new window is a request to separate
      // this tab from the rest, and gathering it into a group would undo that.
      await chrome.windows.create({ url, focused: true });
      return {};
    }
  }
}
