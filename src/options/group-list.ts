/**
 * The list of configured groups.
 *
 * Read only: every mutation goes through the editor. Also surfaces any
 * cross-group collision found in stored config, which validation prevents you
 * from creating but which can still arrive via an import or a sync merge from
 * another machine.
 */

import { ENV_META } from '@core/palette';
import { envBg, envFg } from '@ui/palette-vars';
import { shareButton } from './backup';
import { patternsFor, requestAccess } from '@core/permissions';
import { findCollisions, loopbackClaims } from '@core/ports';
import { displayLabel, type EnvGroup } from '@core/schema';
import { parseBaseUrl } from '@core/url';
import { el } from '@ui/dom';

export interface ListCallbacks {
  onEdit: (id: string) => void;
  onAdd: () => void;
  /** Called after a permission grant, so the list can re-render its state. */
  onChanged: () => void;
  /** Persists a new display order. */
  onReorder: (ids: string[]) => void;
  /** Shows a transient message under the list. */
  onNotice: (message: string) => void;
}

/** Group ids whose origins are not fully granted. */
export type MissingAccess = Set<string>;

export function renderGroupList(
  mount: HTMLElement,
  groups: EnvGroup[],
  missingAccess: MissingAccess,
  callbacks: ListCallbacks,
): void {
  const addButton = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    textContent: 'Add group',
  });
  addButton.addEventListener('click', () => callbacks.onAdd());

  if (groups.length === 0) {
    mount.replaceChildren(
      el('div', { class: 'empty-state' }, [
        el('p', {
          class: 'empty-title',
          textContent: 'No environment groups yet.',
        }),
        el('p', {
          class: 'field-hint',
          textContent:
            'A group is one site and its environments. Add the URLs you switch between and the indicator takes care of the rest.',
        }),
        addButton,
      ]),
    );
    return;
  }

  const registry = renderPortRegistry(groups);

  mount.replaceChildren(
    ...renderCollisionWarnings(groups),
    el('div', { class: 'group-cards' }, groups.map((group, index) =>
      renderCard(group, missingAccess.has(group.id), callbacks, {
        index,
        total: groups.length,
        ids: groups.map((candidate) => candidate.id),
      }),
    )),
    el('div', { class: 'list-actions' }, [addButton]),
    ...(registry ? [registry] : []),
  );
}

interface Position {
  index: number;
  total: number;
  ids: string[];
}

function renderCard(
  group: EnvGroup,
  missingAccess: boolean,
  callbacks: ListCallbacks,
  position: Position,
): HTMLElement {
  const enabled = group.environments.filter((env) => env.enabled);

  const chips = enabled.map((env) => {
    const parsed = parseBaseUrl(env.baseUrl);
    return el('span', {
      class: 'group-chip',
      // Colours come from CSS variables the options page republishes when the palette
      // changes, so a new set repaints these without re-rendering the list.
      style: { background: envBg(env.key), color: envFg(env.key) },
      title: [
        `${displayLabel(env)}: ${env.baseUrl}`,
        env.confirmOnEnter ? '(confirms before entering)' : '',
      ]
        .filter(Boolean)
        .join(' '),
    }, [
      el('span', {
        class: 'env-glyph',
        textContent: ENV_META[env.key].glyph,
        attrs: { 'aria-hidden': 'true' },
      }),
      displayLabel(env),
      el('span', {
        class: 'group-chip-host',
        textContent: parsed.ok ? parsed.value.display : env.baseUrl,
      }),
      env.confirmOnEnter ? el('span', { class: 'group-chip-lock', textContent: '⚑' }) : null,
    ]);
  });

  // The markers are per group now, so they belong on the card once rather than on every
  // chip. Only an explicit override is shown: a group following the global default is the
  // normal case and saying so on every card would be noise.
  const overrides = [
    group.indicator?.frame && group.indicator.frame !== 'default'
      ? `frame ${group.indicator.frame}`
      : '',
    group.indicator?.tabIcon && group.indicator.tabIcon !== 'default'
      ? `tab icon ${group.indicator.tabIcon}`
      : '',
  ].filter(Boolean);

  const edit = el('button', { class: 'btn btn-sm btn-edit', type: 'button', textContent: 'Edit' });
  edit.addEventListener('click', () => callbacks.onEdit(group.id));

  // Order decides which group the numeric shortcuts and the list read first, so it
  // is worth being able to change. Buttons rather than drag, for keyboard reach.
  const move = (delta: number): HTMLButtonElement => {
    const target = position.index + delta;
    const button = el('button', {
      class: 'btn btn-icon btn-icon-sm',
      type: 'button',
      textContent: delta < 0 ? '↑' : '↓',
      disabled: target < 0 || target >= position.total,
      title: delta < 0 ? 'Move up' : 'Move down',
    });
    button.setAttribute('aria-label', `Move "${group.title}" ${delta < 0 ? 'up' : 'down'}`);
    button.addEventListener('click', () => {
      const ids = [...position.ids];
      const [moved] = ids.splice(position.index, 1);
      if (moved) ids.splice(target, 0, moved);
      callbacks.onReorder(ids);
    });
    return button;
  };

  const placeholders = group.environments.length - enabled.length;

  return el('article', { class: 'group-card', dataset: { groupId: group.id } }, [
    el('div', { class: 'group-card-head' }, [
      el('div', {}, [
        el('h3', { class: 'group-card-title', textContent: group.title }),
        group.description
          ? el('p', { class: 'group-card-desc', textContent: group.description })
          : null,
      ]),
      el('div', { class: 'group-card-actions' }, [
        el('div', { class: 'env-reorder' }, [move(-1), move(1)]),
        shareButton(group, callbacks.onNotice),
        edit,
      ]),
    ]),
    el('div', { class: 'group-chips' }, chips),
    el('p', { class: 'group-card-foot' }, [
      enabled.length === 1
        ? 'Only one environment, so there is nothing to switch to yet.'
        : `${enabled.length} environments`,
      placeholders > 0 ? ` · ${placeholders} not filled in` : null,
      group.indicator?.hidden ? ' · indicator hidden on this site' : null,
      overrides.length > 0 ? ` · ${overrides.join(', ')}` : null,
    ]),
    missingAccess ? renderAccessPrompt(group, callbacks) : null,
  ]);
}

/**
 * The nudge to grant site access.
 *
 * Without it the switcher still works, it just cannot draw the indicator once you
 * arrive: showing anything on a page requires permission for that page. The prompt
 * lives on the card rather than blocking the editor, because a group is perfectly
 * valid without it.
 *
 * `chrome.permissions.request` must run inside a user gesture, which is why it is
 * the first thing this click handler does.
 */
function renderAccessPrompt(group: EnvGroup, callbacks: ListCallbacks): HTMLElement {
  const hosts = patternsFor(group)
    .map((pattern) => pattern.replace(/^[a-z]+:\/\//, '').replace(/\/\*$/, ''))
    .join(', ');

  const button = el('button', {
    class: 'btn btn-sm',
    type: 'button',
    textContent: 'Grant site access',
  });

  const note = el('p', { class: 'access-note' }, [
    'The indicator cannot appear on ',
    el('strong', { textContent: hosts }),
    ' until you allow it. Switching to them works either way.',
  ]);

  button.addEventListener('click', () => {
    void requestAccess(group).then(() => callbacks.onChanged());
  });

  return el('div', { class: 'access-prompt' }, [note, button]);
}

/**
 * Collisions in already-stored config.
 *
 * The editor blocks creating one, so seeing this means the config arrived some
 * other way. Worth shouting about: two groups claiming the same origin makes the
 * indicator ambiguous in a way that is very hard to diagnose from the outside.
 */
function renderCollisionWarnings(groups: EnvGroup[]): HTMLElement[] {
  const collisions = findCollisions(groups);
  if (collisions.length === 0) return [];

  return [
    el('div', { class: 'banner banner-error' }, [
      el('p', { class: 'banner-title', textContent: 'Two groups claim the same URL' }),
      el('ul', { class: 'banner-list' }, collisions.map((collision) =>
        el('li', {}, [
          el('code', { textContent: collision.display }),
          ` is claimed by ${collision.claimants.map((c) => `"${c.groupTitle}"`).join(' and ')}.`,
        ]),
      )),
      el('p', {
        class: 'field-hint',
        textContent:
          'Until this is resolved, the indicator cannot tell which group a matching tab belongs to. Edit one of them to use a different URL or port.',
      }),
    ]),
  ];
}

/**
 * Which local ports are spoken for, and by whom.
 *
 * Ports have to be unique across groups, because two projects on the same port
 * cannot be told apart by any amount of URL inspection. Showing the map makes that
 * constraint feel like help rather than an arbitrary rejection, and it answers
 * "what was that project running on again?" which is a question you will ask
 * anyway.
 */
function renderPortRegistry(groups: EnvGroup[]): HTMLElement | null {
  const claims = loopbackClaims(groups).filter((claim) => claim.primary);
  if (claims.length === 0) return null;

  return el('details', { class: 'port-registry' }, [
    el('summary', {}, [
      `Local ports in use (${claims.length})`,
    ]),
    el('table', { class: 'port-table' }, [
      el('tbody', {}, claims.map((claim) =>
        el('tr', {}, [
          el('td', { class: 'port-cell', textContent: String(claim.port) }),
          el('td', {}, [
            el('span', {
              class: 'dot',
              style: { background: envBg(claim.envKey) },
              attrs: { 'aria-hidden': 'true' },
            }),
            ENV_META[claim.envKey].label,
          ]),
          el('td', { class: 'port-group', textContent: claim.groupTitle }),
        ]),
      )),
    ]),
  ]);
}
