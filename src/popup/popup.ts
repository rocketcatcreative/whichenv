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
 * active tab matches nothing.
 */

import './popup.css';
import { ENV_META } from '@core/palette';
import { guessGroupFromUrl } from '@core/guess';
import { getSettings } from '@core/settings';
import { send, type OpenMode, type ResolvedTab } from '@core/messages';
import { draftFromGuess, stashDraft } from '@core/pending';
import { suggestLoopbackPort } from '@core/ports';
import { listGroups } from '@core/storage';
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
 * The "create a group from this tab" entry point.
 *
 * Filling in four URLs and a title by hand is enough friction to stop people
 * bothering, and an extension nobody sets up does nothing. This prefills all of it
 * from the current tab and opens the editor to confirm.
 */
async function createFromTabCard(url: string, pageTitle: string | undefined): Promise<HTMLElement> {
  const groups = await listGroups();
  const guess = guessGroupFromUrl(url, pageTitle, {
    localPort: suggestLoopbackPort(groups),
  });

  if (!guess) {
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
      await stashDraft(draftFromGuess(guess, crypto.randomUUID()));
      await send({ type: 'openOptions' });
      window.close();
    })();
  });

  const guessedFor = guess.environments.find((env) => env.fromTab);

  return card('Set up', [
    el('p', { class: 'empty' }, [
      'It looks like ',
      el('strong', { textContent: guessedFor ? ENV_META[guessedFor.key].label : 'production' }),
      ` for "${guess.title}". The other environments will be guessed for you to check.`,
    ]),
    el('div', { class: 'actions' }, [button]),
  ]);
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
      await createFromTabCard(url, tab?.title),
      settingsButton(),
    );
    return;
  }

  const rows = resolved.siblings.map((sibling) => {
    const row = el('button', { class: 'switch-row', type: 'button' }, [
      el('span', {
        class: 'dot',
        style: { background: envBg(sibling.envKey) },
        attrs: { 'aria-hidden': 'true' },
      }),
      el('span', { class: 'switch-label', textContent: sibling.label }),
      el('span', { class: 'switch-host', textContent: sibling.display }),
      sibling.confirmOnEnter ? el('span', { class: 'switch-flag', textContent: '⚑' }) : null,
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
