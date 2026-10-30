/**
 * Toolbar popup.
 *
 * Reports what the active tab resolved to, and offers the same switch the pill
 * does. Useful in its own right, and it is the fallback when a group has the
 * indicator hidden or the page has no content script.
 *
 * Reading the active tab's URL relies on the `activeTab` permission, which Chrome
 * grants for the duration of a user invoking the action. Host permissions are not
 * enough here: "create a group from this tab" is for a site you have NOT set up, which
 * is precisely a site no host permission covers.
 *
 * Phase 6 adds the "create a group from this tab" entry point here, for when the
 * active tab matches nothing. It fills in the URL of the tab itself and a name, and
 * stops there. It used to guess the other environments' URLs too; see `pending.ts` for
 * why that came out.
 */

import './popup.css';
import { ENV_META } from '@core/palette';
import { getSettings } from '@core/settings';
import { getGroup, saveGroup } from '@core/storage';
import { withHidden } from '@core/indicator';
import type { EnvGroup } from '@core/schema';
import { send, type OpenMode, type ResolvedTab } from '@core/messages';
import { draftFromTab, stashDraft } from '@core/pending';
import { guardsInPlay } from '@core/open-all';
import { el } from '@ui/dom';
import { applyPaletteVars, envBg, envFg } from '@ui/palette-vars';

const app = document.querySelector<HTMLElement>('#app');

function card(label: string, body: (Node | string)[]): HTMLElement {
  return el('div', { class: 'card' }, [
    el('div', { class: 'card-label', textContent: label }),
    ...body,
  ]);
}

function pillFor(envKey: ResolvedTab['envKey'], label: string): HTMLElement {
  return el(
    'span',
    { class: 'pill', style: { background: envBg(envKey), color: envFg(envKey) } },
    [
      el('span', {
        class: 'g',
        textContent: ENV_META[envKey].glyph,
        attrs: { 'aria-hidden': 'true' },
      }),
      label,
    ],
  );
}

function settingsButton(): HTMLElement {
  const button = el('button', { textContent: 'Open settings', type: 'button' });
  button.addEventListener('click', () => {
    void send({ type: 'openOptions' });
    window.close();
  });
  return el('div', { class: 'actions' }, [button]);
}

/**
 * Shows or hides the indicator for the group the active tab is in.
 *
 * The same stored flag as "Hide the indicator on this site" in the group editor, so the two
 * always agree. It covers every environment in the group, and it persists until toggled
 * back. Here as well as in the editor because the moment you want the pill gone is the
 * moment you are looking at the page. Not a `.card`, so the cards below keep their positions.
 *
 * The group is re-read at click time rather than reusing the copy the popup opened with,
 * so an edit saved elsewhere in the meantime is not overwritten.
 */
function indicatorToggle(group: EnvGroup): HTMLElement {
  const shown = group.indicator?.hidden !== true;
  const input = el('input', { type: 'checkbox', checked: shown });
  const note = el('p', {
    class: 'toggle-note',
    textContent: `Hidden on every ${group.title} environment until you turn this back on. The toolbar badge still shows where you are.`,
  });
  note.hidden = shown;

  input.addEventListener('change', () => {
    const show = input.checked;
    note.hidden = show;
    void (async () => {
      const current = await getGroup(group.id);
      if (current) await saveGroup(withHidden(current, !show));
    })();
  });

  return el('div', { class: 'toggle', dataset: { setting: 'groupHidden' } }, [
    el('label', { class: 'toggle-row' }, [
      el('span', { textContent: 'Show indicator on this site' }),
      input,
    ]),
    note,
  ]);
}

/**
 * The "create a group from this tab" entry point.
 *
 * Deliberately modest about what it claims. The card says which URL is going in and
 * which slot it lands in, so nothing arrives in the editor that was not announced here.
 */
function createFromTabCard(url: string, pageTitle: string | undefined): HTMLElement {
  const draft = draftFromTab(url, pageTitle, crypto.randomUUID());

  if (!draft) {
    return card('Set up', [
      el('p', { class: 'empty', textContent: 'This URL cannot be used as a base URL.' }),
    ]);
  }

  const button = el('button', {
    class: 'primary',
    type: 'button',
    textContent: 'Create a group from this tab',
  });

  button.addEventListener('click', () => {
    void (async () => {
      await stashDraft(draft);
      await send({ type: 'openOptions' });
      window.close();
    })();
  });

  const baseUrl = draft.environments[0]?.baseUrl ?? '';

  return card('Set up', [
    el('p', { class: 'empty' }, [
      'Starts a group called ',
      el('strong', { textContent: draft.title }),
      ' with this tab as ',
      el('strong', { textContent: ENV_META.prod.label }),
      '. Add the other environments and their URLs in settings.',
    ]),
    el('div', { class: 'url setup-url', textContent: baseUrl }),
    el('div', { class: 'actions' }, [button]),
  ]);
}

/**
 * "Open all environments": one Chrome tab group holding every environment, local to prod.
 *
 * Armed first when any environment in the set carries the enter guard. One confirm for the
 * whole action rather than one per environment, because a button whose purpose is opening
 * several at once cannot sensibly ask about each of them. The label says which environments
 * caused it, so the second click is informed rather than reflexive.
 */
function openAllButton(resolved: ResolvedTab, url: string): HTMLElement {
  const guarded = resolved.siblings.filter((sibling) => sibling.confirmOnEnter);
  const button = el('button', {
    class: 'wide',
    type: 'button',
    textContent: 'Open all environments',
    title: 'Open every environment in this group in one tab group, local to production',
  });

  let armed = false;

  button.addEventListener('click', () => {
    if (guardsInPlay(resolved.siblings) && !armed) {
      armed = true;
      button.classList.add('armed');
      button.textContent = `Confirm: this opens ${guarded.map((env) => env.label).join(' and ')}`;
      return;
    }

    void send({ type: 'openAll', groupId: resolved.groupId, url });
    window.close();
  });

  return el('div', { class: 'actions' }, [button]);
}

async function main(): Promise<void> {
  if (!app) return;

  // Published before anything renders, because every colour below is written as a
  // reference to one of these variables rather than as a literal.
  const [[tab], settings] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    getSettings(),
  ]);
  applyPaletteVars(settings.paletteId);

  const url = tab?.url ?? '';

  const header = [
    el('h1', { textContent: 'WhichEnv' }),
    el('p', {
      class: 'sub',
      textContent: `v${chrome.runtime.getManifest().version}`,
    }),
  ];

  // Distinguished from the case below on purpose. "No URL at all" means something is
  // wrong with the extension's own permissions and says so, rather than blaming the
  // page for not being http.
  if (!url) {
    app.replaceChildren(
      ...header,
      card('Active tab', [
        el('p', {
          class: 'empty',
          textContent:
            'Could not read this tab. Reload the extension at chrome://extensions and try again.',
        }),
      ]),
      settingsButton(),
    );
    return;
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    app.replaceChildren(
      ...header,
      card('Active tab', [
        el('p', {
          class: 'empty',
          textContent:
            'This page is not an http or https URL, so the extension deliberately ignores it.',
        }),
      ]),
      settingsButton(),
    );
    return;
  }

  const response = await send({ type: 'resolve', url });
  const resolved = response?.type === 'resolved' ? response.tab : null;

  if (!resolved) {
    app.replaceChildren(
      ...header,
      card('No match', [
        el('p', {
          class: 'empty',
          textContent: 'This URL is not in any of your environment groups.',
        }),
        el('div', { class: 'url', textContent: new URL(url).host }),
      ]),
      createFromTabCard(url, tab?.title),
      settingsButton(),
    );
    return;
  }

  const group = await getGroup(resolved.groupId);

  const rows = resolved.siblings.map((sibling) => {
    const row = el('button', { class: 'switch-row', type: 'button' }, [
      el('span', {
        class: 'dot',
        style: { background: envBg(sibling.envKey) },
        attrs: { 'aria-hidden': 'true' },
      }),
      el('span', { class: 'switch-label', textContent: sibling.label }),
      el('span', { class: 'switch-host', textContent: sibling.display }),
      sibling.confirmOnEnter
        ? el('span', {
            class: 'switch-flag',
            textContent: '⚑',
            title: 'Confirms before entering',
            // `role` and `aria-label` together, because a bare glyph in a span is read out
            // as its Unicode name otherwise.
            attrs: { role: 'img', 'aria-label': 'Confirms before entering' },
          })
        : null,
    ]);

    row.addEventListener('click', (event) => {
      // Same rule as the pill: the modifier inverts the configured default rather
      // than always meaning "new tab".
      const inverted = event.metaKey || event.ctrlKey;
      const mode: OpenMode = event.shiftKey
        ? 'newWindow'
        : resolved.openInNewTabByDefault !== inverted
          ? 'newTab'
          : 'current';
      void send({
        type: 'switch',
        groupId: resolved.groupId,
        envKey: sibling.envKey,
        url,
        mode,
      });
      window.close();
    });

    return row;
  });

  app.replaceChildren(
    ...header,
    ...(group ? [indicatorToggle(group)] : []),
    card('You are on', [
      pillFor(resolved.envKey, resolved.label),
      el('p', { class: 'group-name', textContent: resolved.groupTitle }),
    ]),
    rows.length
      ? card('Switch to', [
          el('div', { class: 'switch-list' }, rows),
          el('p', {
            class: 'empty hint',
            textContent: 'Hold Cmd or Ctrl for a new tab, Shift for a new window.',
          }),
          openAllButton(resolved, url),
        ])
      : card('Switch to', [
          el('p', {
            class: 'empty',
            textContent: 'This group has no other environments set up yet.',
          }),
        ]),
    settingsButton(),
  );
}

void main();
