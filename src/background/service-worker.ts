/**
 * Background service worker.
 *
 * Owns everything the content script must not: resolving a URL against stored
 * groups, and performing navigation. The content script renders and reports
 * clicks; it holds no knowledge of groups, storage or URL rules.
 *
 * Service workers are killed aggressively, so nothing may be held in module scope
 * and assumed to survive. Durable state lives in chrome.storage; the match index is
 * cached in storage.session (see index-cache.ts).
 *
 */

import { lookup, resolveMatch, switchTargets } from '@core/match';
import type { EnvKey } from '@core/palette';
import type { Push, Request, ResolvedTab, Response } from '@core/messages';
import { listGroups, onGroupsChanged } from '@core/storage';
import { resolveIndicator } from '@core/indicator';
import { getSettings, onSettingsChanged } from '@core/settings';
import { pruneAccess } from '@core/permissions';
import { refreshAllBadges, refreshBadge, updateBadge } from './badge';
import { getIndex, rebuild } from './index-cache';
import { navigate } from './navigate';
import { syncRegistrations } from './scripts';
import { registerOmnibox } from './omnibox';
import { registerContextMenus, syncContextMenus } from './context-menu';
import { forgetWindow, groupTab } from './tab-groups';

const VERSION = chrome.runtime.getManifest().version;

registerOmnibox();
registerContextMenus();

/**
 * Tabs where the indicator has been dismissed until the next load.
 *
 * Deliberately in memory: "hide until reload" should not outlive the worker in a
 * confusing way, and re-showing it after a worker restart is a far better failure
 * than a pill that stays hidden with no way to bring it back.
 */
const hiddenTabs = new Set<number>();

/**
 * Lets content scripts read and write storage.session.
 *
 * They use it to remember which origins refuse a generated tab icon, so a CSP-restricted
 * site logs one "Refused to load the image" per session rather than one per page load.
 * The default access level excludes content scripts entirely.
 *
 * Widening this is deliberate but narrow in consequence: session storage holds the match
 * index and the CSP verdicts, both derived from the user's own configuration, and content
 * scripts run in an isolated world the page cannot reach into.
 */
void chrome.storage.session
  .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch(() => {
    // Older Chrome, or already set. The icon still works; it just re-probes per page.
  });

chrome.runtime.onInstalled.addListener((details) => {
  console.info(`[WhichEnv] ${details.reason} → v${VERSION}`);
  void rebuild();
  void syncRegistrations();
  // Context menus do not survive an update, so they are rebuilt on install and startup as
  // well as on every group change.
  void syncContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  void rebuild();
  void syncRegistrations();
  void syncContextMenus();
});

// A group edit changes what matches, so the index, every open tab, the badges and
// the set of origins worth holding all need to catch up.
onGroupsChanged((groups) => {
  void (async () => {
    await rebuild(groups);
    await broadcast({ type: 'refresh' });
    await refreshAllBadges();
    await syncContextMenus(groups);
    // Give up access to origins no group mentions any more.
    const dropped = await pruneAccess(groups);
    if (dropped.length) await syncRegistrations();
  })();
});

// Registration is derived from granted permissions, so it follows a grant or a
// revocation made anywhere, including Chrome's own extension settings page.
chrome.permissions.onAdded.addListener(() => void syncRegistrations());
chrome.permissions.onRemoved.addListener(() => void syncRegistrations());

// Corner, collapse timing and the palette all live in settings, and the content script
// listens to storage directly for those, so no push is needed for the pill.
//
// Badges are not reactive, though: they are painted from here, so a palette change has
// to repaint them or the toolbar keeps the old colours until the next navigation.
// Repainting on ANY settings change rather than diffing the palette specifically is
// deliberate. Diffing needs a remembered previous value, and the worker is usually
// started BY the change it would be trying to compare against, so there is nothing to
// compare with. Settings changes only happen when someone clicks something in the
// options page, so an unconditional repaint costs nothing worth saving.
onSettingsChanged(() => {
  void (async () => {
    // Also a cheap moment to confirm the index exists.
    await getIndex();
    await refreshAllBadges();
  })();
});

/** Sends a push to every tab that has a content script listening. */
async function broadcast(push: Push): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.tabs.sendMessage(tab.id, push);
      } catch {
        // No content script in that tab. Entirely normal, and not an error.
      }
    }),
  );
}

async function resolve(url: string, tabId: number | undefined): Promise<ResolvedTab | null> {
  const entry = lookup(await getIndex(), url);
  if (!entry) return null;

  const groups = await listGroups();
  const match = resolveMatch(groups, entry);
  if (!match) {
    // The index outlived the group it pointed at. Rebuild and give up for now;
    // the refresh push from the group change will bring tabs back into line.
    await rebuild(groups);
    return null;
  }

  const settings = await getSettings();
  const dismissed = tabId !== undefined && hiddenTabs.has(tabId);
  const indicator = resolveIndicator(match.group, settings);

  return {
    groupId: match.group.id,
    groupTitle: match.group.title,
    envKey: match.envKey,
    label: match.label,
    hidden: indicator.hidden || dismissed,
    frame: indicator.frame,
    tabIcon: indicator.tabIcon,
    siblings: switchTargets(match, url).map((target) => ({
      envKey: target.envKey,
      label: target.label,
      display: target.display,
      confirmOnEnter: target.confirmOnEnter,
    })),
    corner: settings.corner,
    indicatorSize: settings.indicatorSize,
    frameWidth: settings.frameWidth,
    autoCollapseMs: settings.autoCollapseMs,
    openInNewTabByDefault: settings.openInNewTabByDefault,
    paletteId: settings.paletteId,
  };
}

/**
 * Where a switch from `fromUrl` to `envKey` would land, or null if nowhere.
 *
 * Shared by the switch itself and by "copy this environment's link", so a copied URL can
 * never disagree with where clicking would actually take you.
 */
async function targetUrl(
  groupId: string,
  envKey: EnvKey,
  fromUrl: string,
): Promise<string | null> {
  const entry = lookup(await getIndex(), fromUrl);
  if (!entry || entry.groupId !== groupId) return null;

  const groups = await listGroups();
  const match = resolveMatch(groups, entry);
  if (!match) return null;

  // Asking for the environment you are already on is legitimate, and the answer is the URL
  // you are already on. switchTargets omits it, so it is handled here rather than read as a
  // failure. The link context menu learned this the hard way.
  if (match.envKey === envKey) return fromUrl;

  return switchTargets(match, fromUrl).find((target) => target.envKey === envKey)?.url ?? null;
}

/**
 * Recomputes the target URL at switch time rather than trusting the caller.
 *
 * The content script sends the URL it is currently on and which environment it
 * wants; the destination is derived here. That keeps the single source of truth for
 * URL rules in core/, and means a stale or tampered-with target cannot send a tab
 * somewhere the user's own config does not describe.
 */
async function performSwitch(
  request: Extract<Request, { type: 'switch' }>,
  tabId: number | undefined,
  windowId: number | undefined,
): Promise<Response> {
  const entry = lookup(await getIndex(), request.url);
  if (!entry || entry.groupId !== request.groupId) {
    return { type: 'error', message: 'This tab no longer matches that group.' };
  }

  const groups = await listGroups();
  const match = resolveMatch(groups, entry);
  if (!match) return { type: 'error', message: 'That group no longer exists.' };

  const target = switchTargets(match, request.url).find(
    (candidate) => candidate.envKey === request.envKey,
  );
  if (!target) {
    return { type: 'error', message: 'That environment is no longer available.' };
  }

  const settings = await getSettings();
  const result = await navigate({ url: target.url, mode: request.mode, tabId, windowId });

  // Only new tabs get grouped, and only when the setting allows it. Failure here is
  // swallowed inside groupTab: the switch has already happened and a missing tab
  // group is not worth surfacing as an error.
  if (
    settings.createTabGroupOnNewTab &&
    request.mode === 'newTab' &&
    result.createdTabId !== undefined &&
    result.createdWindowId !== undefined
  ) {
    await groupTab(
      result.createdTabId,
      result.createdWindowId,
      match.group,
      request.envKey,
      settings.paletteId,
      tabId,
    );
  }

  return { type: 'switched', ok: true, url: target.url };
}

chrome.runtime.onMessage.addListener((message: Request, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;

  void (async () => {
    try {
      switch (message.type) {
        case 'resolve':
          sendResponse({ type: 'resolved', tab: await resolve(message.url, tabId) } as Response);
          return;

        case 'urlFor': {
          const url = await targetUrl(message.groupId, message.envKey, message.url);
          sendResponse(
            url === null
              ? ({ type: 'error', message: 'That environment is no longer available.' } as Response)
              : ({ type: 'url', url } as Response),
          );
          return;
        }

        case 'switch':
          sendResponse(await performSwitch(message, tabId, windowId));
          return;

        case 'hideForTab':
          if (tabId !== undefined) hiddenTabs.add(tabId);
          sendResponse({ type: 'ok' } as Response);
          return;

        case 'openOptions':
          await chrome.runtime.openOptionsPage();
          sendResponse({ type: 'ok' } as Response);
          return;
      }
    } catch (error) {
      sendResponse({
        type: 'error',
        message: error instanceof Error ? error.message : 'Something went wrong.',
      } as Response);
    }
  })();

  // Keeps the message channel open for the async work above.
  return true;
});

// A reload clears the per-tab dismissal, which is what "until reload" means.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') hiddenTabs.delete(tabId);
  // `changeInfo.url` only arrives for tabs we hold host access to, which is exactly
  // the set that could match anything.
  if (changeInfo.url !== undefined || changeInfo.status === 'complete') {
    void updateBadge(tabId, changeInfo.url ?? tab.url);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => void refreshBadge(tabId));

chrome.tabs.onRemoved.addListener((tabId) => hiddenTabs.delete(tabId));

chrome.windows.onRemoved.addListener((windowId) => void forgetWindow(windowId));

chrome.commands?.onCommand.addListener((command) => {
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return;
    const tabId = tab.id;

    const push = async (message: Push): Promise<boolean> => {
      try {
        await chrome.tabs.sendMessage(tabId, message);
        return true;
      } catch {
        return false; // No content script in that tab.
      }
    };

    if (command === 'hide-indicator') {
      hiddenTabs.add(tabId);
      await push({ type: 'hide' });
      return;
    }

    if (command === 'open-switcher') {
      // Nothing to fall back to if the page has no content script: the popup
      // cannot be opened programmatically on every Chrome version, and silently
      // doing nothing is better than a surprise navigation.
      await push({ type: 'openSwitcher' });
      return;
    }

    // switch-1 .. switch-4 jump straight to the nth environment in the group, in
    // the group's own order. Declared without suggested keys because Chrome allows
    // at most four, and those are spent on the two above; the settings page links
    // to Chrome's shortcut editor for binding them.
    const numeric = /^switch-([1-4])$/.exec(command);
    if (!numeric?.[1]) return;

    if (!tab.url) return;
    const entry = lookup(await getIndex(), tab.url);
    if (!entry) return;

    const groups = await listGroups();
    const match = resolveMatch(groups, entry);
    if (!match) return;

    const ordered = match.group.environments.filter((env) => env.enabled);
    const wanted = ordered[Number(numeric[1]) - 1];
    if (!wanted || wanted.key === match.envKey) return;

    const target = switchTargets(match, tab.url).find(
      (candidate) => candidate.envKey === wanted.key,
    );
    if (!target) return;

    // The keyboard path deliberately honours the enter guard by refusing rather
    // than confirming: a guarded environment should not be one keystroke away.
    if (target.confirmOnEnter) {
      await push({ type: 'openSwitcher' });
      return;
    }

    const settings = await getSettings();
    const mode = settings.openInNewTabByDefault ? 'newTab' : 'current';
    const result = await navigate({ url: target.url, mode, tabId, windowId: tab.windowId });

    if (
      settings.createTabGroupOnNewTab &&
      mode === 'newTab' &&
      result.createdTabId !== undefined &&
      result.createdWindowId !== undefined
    ) {
      await groupTab(
        result.createdTabId,
        result.createdWindowId,
        match.group,
        wanted.key,
        settings.paletteId,
        tabId,
      );
    }
  })();
});

export {};
