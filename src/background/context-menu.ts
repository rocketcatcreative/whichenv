/**
 * Right-click a link, open it on another environment.
 *
 * The entry point the pill cannot be: a prod link pasted into Slack, a ticket or an email
 * is on a page that is not in any group, so there is no indicator to click. This is how you
 * get from that link to the same page on local.
 *
 * Registration is rebuilt wholesale on every group change rather than diffed. The menu is a
 * few dozen items, `removeAll` is one call, and a diff would be a second model of the same
 * state waiting to disagree with the first.
 */

import { lookup, resolveMatch, switchTargets, type Match } from '@core/match';
import { linkMenuItems, parseItemId, MENU_ACTIONS, PARENT_ID, type ParsedItem } from '@core/menu';
import type { EnvGroup } from '@core/schema';
import { getSettings } from '@core/settings';
import { listGroups } from '@core/storage';
import { getIndex } from './index-cache';
import { navigate } from './navigate';
import { groupTab } from './tab-groups';

/** Rebuilds the whole menu from the current groups. */
export async function syncContextMenus(groups?: readonly EnvGroup[]): Promise<void> {
  // contextMenus is a permission; if it is somehow absent, everything else still works.
  if (!chrome.contextMenus) return;

  const items = linkMenuItems(groups ?? (await listGroups()));

  await new Promise<void>((resolve) => chrome.contextMenus.removeAll(() => resolve()));
  if (items.length === 0) return;

  const patterns = [...new Set(items.flatMap((item) => item.targetUrlPatterns))];

  // One parent, titled from the manifest so it stays right if the extension is renamed. Its
  // patterns are the union of its children's, so it disappears entirely on a link that
  // belongs to no group rather than sitting in every link menu on the web doing nothing.
  chrome.contextMenus.create({
    id: PARENT_ID,
    // short_name, not name: the manifest name is the long store title, which would be an
    // absurd context menu row.
    title: chrome.runtime.getManifest().short_name ?? chrome.runtime.getManifest().name,
    contexts: ['link'],
    targetUrlPatterns: patterns,
  });

  let needsSeparator = false;

  for (const action of MENU_ACTIONS) {
    const forAction = items.filter((item) => item.action === action);
    if (forAction.length === 0) continue;

    if (needsSeparator) {
      chrome.contextMenus.create({
        id: `${PARENT_ID}-sep-${action}`,
        parentId: PARENT_ID,
        type: 'separator',
        contexts: ['link'],
        targetUrlPatterns: patterns,
      });
    }
    needsSeparator = true;

    for (const item of forAction) {
      chrome.contextMenus.create({
        id: item.id,
        parentId: PARENT_ID,
        title: item.title,
        contexts: ['link'],
        targetUrlPatterns: item.targetUrlPatterns,
      });
    }
  }
}

/**
 * Puts text on the clipboard.
 *
 * A service worker has no document, so it cannot reach the clipboard itself. The write is
 * therefore run in the page, which Chrome permits here because activating a context menu
 * item grants `activeTab` for that tab: no host permission required, and it works on the
 * Slack or ticket page the link came from even though that page is in no group.
 *
 * `navigator.clipboard` needs a focused document and will reject if the page is not, which
 * happens often enough right after a menu closes, so the old execCommand path is kept as a
 * fallback rather than trusted as the primary.
 */
async function copyToClipboard(tabId: number, text: string): Promise<boolean> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [text],
      func: async (value: string): Promise<boolean> => {
        try {
          await navigator.clipboard.writeText(value);
          return true;
        } catch {
          // Not focused, or the API is unavailable. A detached textarea plus execCommand
          // still works in that case, and is deliberately not the first choice.
          const field = document.createElement('textarea');
          field.value = value;
          field.setAttribute('aria-hidden', 'true');
          field.style.cssText = 'position:fixed;top:-1000px;opacity:0';
          document.body.append(field);
          field.select();
          const ok = document.execCommand('copy');
          field.remove();
          return ok;
        }
      },
    });
    return result?.result === true;
  } catch (error) {
    // A restricted page, or access we do not have. Nothing to recover; say so plainly.
    console.warn('[WhichEnv] could not copy to the clipboard', error);
    return false;
  }
}

/**
 * Resolves the URL the clicked item refers to, or null with a reason logged.
 *
 * Shared by both actions, so a copied URL can never disagree with where opening would go.
 */
async function urlForItem(
  linkUrl: string,
  wanted: ParsedItem,
): Promise<{ url: string; match: Match } | null> {
  const entry = lookup(await getIndex(), linkUrl);
  if (!entry) {
    // The menu is filtered by host pattern, which cannot express a port, so a link on
    // localhost:3001 can show a group that owns localhost:3000. Nothing to do but decline.
    console.info('[WhichEnv] that link is not in any environment group');
    return null;
  }

  const groups = await listGroups();
  const match = resolveMatch(groups, entry);
  if (!match) {
    console.info('[WhichEnv] that link resolved to a group that no longer exists');
    return null;
  }

  // Deliberately trusts the RESOLVED group over the one the clicked item names. They differ
  // only in the port-ambiguity case above, and the resolved one is the truth about where the
  // link actually points; the item is only trusted for which environment was chosen.
  //
  // The chosen environment being the one the link ALREADY points at is a normal case, not an
  // error: pages routinely link to their own production URL (a canonical link, a "view live
  // site" link), so the link under your cursor is often already on the environment you pick.
  // switchTargets omits the environment you are on, by design, so it has nothing to offer
  // here and the link is opened exactly as it is. The first release got this wrong and did
  // nothing at all, silently.
  const url =
    wanted.envKey === match.envKey
      ? linkUrl
      : switchTargets(match, linkUrl).find((candidate) => candidate.envKey === wanted.envKey)?.url;

  if (!url) {
    console.info(
      `[WhichEnv] "${match.group.title}" has no usable ${wanted.envKey} for that link`,
    );
    return null;
  }

  return { url, match };
}

/**
 * Opens the clicked link on the chosen environment.
 *
 * Always a new tab. You right-clicked a link on some other page, so replacing that page is
 * not what was asked for, and it is the one case where the global "replace the current tab"
 * default is clearly wrong.
 */
async function openOnEnvironment(
  linkUrl: string,
  wanted: ParsedItem,
  originTabId: number | undefined,
  windowId: number | undefined,
): Promise<void> {
  const resolved = await urlForItem(linkUrl, wanted);
  if (!resolved) return;

  const { url, match } = resolved;
  const settings = await getSettings();
  const result = await navigate({ url, mode: 'newTab', windowId });

  if (
    settings.createTabGroupOnNewTab &&
    result.createdTabId !== undefined &&
    result.createdWindowId !== undefined
  ) {
    // The page holding the link is pulled into the group too, so the pair you are about to
    // compare ends up side by side. An earlier version deliberately left it out, reasoning
    // that the page is usually Slack or a ticket, but a new tab quietly filed into a group
    // on its own is worse: you lose the thing you came from.
    //
    // Safe because `shouldAdoptOrigin` only ever takes a tab that is UNGROUPED and in the
    // same window, so an arrangement the user made themselves is never rearranged.
    await groupTab(
      result.createdTabId,
      result.createdWindowId,
      match.group,
      wanted.envKey,
      settings.paletteId,
      originTabId,
    );
  }
}

export function registerContextMenus(): void {
  if (!chrome.contextMenus) return;

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const wanted = parseItemId(String(info.menuItemId));
    const linkUrl = info.linkUrl;
    if (!wanted || !linkUrl) return;

    if (wanted.action === 'copy-link-for') {
      const tabId = tab?.id;
      if (tabId === undefined) return;
      void urlForItem(linkUrl, wanted).then((resolved) => {
        if (resolved) void copyToClipboard(tabId, resolved.url);
      });
      return;
    }

    void openOnEnvironment(linkUrl, wanted, tab?.id, tab?.windowId);
  });
}
