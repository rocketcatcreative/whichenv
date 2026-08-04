/**
 * The omnibox keyword.
 *
 * Type `env` then a space in the address bar and the other environments for the
 * current tab appear as suggestions. It composes with muscle memory people already
 * have for the address bar, and it costs about forty lines.
 *
 * Deliberately does NOT offer environments for sites other than the current tab. The
 * whole model is "the same page, elsewhere", and a suggestion list of every URL in
 * every group would be a bookmark manager, which this is not.
 */

import { lookup, resolveMatch, switchTargets, type SwitchTarget } from '@core/match';
import { listGroups } from '@core/storage';
import { getSettings } from '@core/settings';
import { getIndex } from './index-cache';
import { navigate } from './navigate';
import { groupTab } from './tab-groups';

interface Context {
  tabId: number;
  windowId: number;
  url: string;
  groupTitle: string;
  targets: SwitchTarget[];
  groupRef: Awaited<ReturnType<typeof resolveMatch>>;
}

async function contextForActiveTab(): Promise<Context | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !tab.url) return null;

  const entry = lookup(await getIndex(), tab.url);
  if (!entry) return null;

  const match = resolveMatch(await listGroups(), entry);
  if (!match) return null;

  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    groupTitle: match.group.title,
    targets: switchTargets(match, tab.url),
    groupRef: match,
  };
}

/** Case-insensitive substring match on the label or the host. */
function matches(target: SwitchTarget, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    target.label.toLowerCase().includes(needle) ||
    target.display.toLowerCase().includes(needle) ||
    target.envKey.includes(needle)
  );
}

/** Escapes the five characters Chrome's suggestion XML cares about. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function registerOmnibox(): void {
  if (!chrome.omnibox) return;

  chrome.omnibox.onInputStarted.addListener(() => {
    void (async () => {
      const context = await contextForActiveTab();
      chrome.omnibox.setDefaultSuggestion({
        description: context
          ? `Switch environment for ${escapeXml(context.groupTitle)}`
          : 'This tab is not in any environment group',
      });
    })();
  });

  chrome.omnibox.onInputChanged.addListener((text, suggest) => {
    void (async () => {
      const context = await contextForActiveTab();
      if (!context) return suggest([]);

      suggest(
        context.targets.filter((target) => matches(target, text.trim())).map((target) => ({
          // The content is what comes back on entry, so the env key is the payload.
          content: target.envKey,
          description:
            `<match>${escapeXml(target.label)}</match> ` +
            `<dim>${escapeXml(target.display)}</dim>` +
            (target.confirmOnEnter ? ' <dim>(guarded)</dim>' : ''),
        })),
      );
    })();
  });

  chrome.omnibox.onInputEntered.addListener((text) => {
    void (async () => {
      const context = await contextForActiveTab();
      if (!context) return;

      const query = text.trim().toLowerCase();
      const target =
        context.targets.find((candidate) => candidate.envKey === query) ??
        context.targets.find((candidate) => matches(candidate, query));
      if (!target) return;

      // Same reasoning as the numeric shortcuts: a guarded environment should not be
      // reachable by typing a word and pressing enter. Fall back to opening the
      // switcher so the confirmation is still in front of you.
      if (target.confirmOnEnter) {
        try {
          await chrome.tabs.sendMessage(context.tabId, { type: 'openSwitcher' });
        } catch {
          // No content script in that tab.
        }
        return;
      }

      const settings = await getSettings();
      const mode = settings.openInNewTabByDefault ? 'newTab' : 'current';
      const result = await navigate({
        url: target.url,
        mode,
        tabId: context.tabId,
        windowId: context.windowId,
      });

      if (
        settings.createTabGroupOnNewTab &&
        mode === 'newTab' &&
        result.createdTabId !== undefined &&
        result.createdWindowId !== undefined &&
        context.groupRef
      ) {
        await groupTab(
          result.createdTabId,
          result.createdWindowId,
          context.groupRef.group,
          target.envKey,
          settings.paletteId,
          context.tabId,
        );
      }
    })();
  });
}
