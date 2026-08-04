/**
 * The environment group editor.
 *
 * Holds a `GroupDraft` (raw strings, possibly invalid) and revalidates on every
 * keystroke. Nothing reaches storage until `validateDraft` reports no errors, so
 * a half-typed group can never be persisted.
 *
 * Three behaviours worth knowing about:
 *
 *  - Base URL fields normalize on blur and write the canonical value back into
 *    the input. You always see exactly what will be stored, including the port
 *    that was filled in for you.
 *  - Warnings render alongside errors but never block saving. A group with one
 *    environment, or a bare `http://localhost`, is legal but worth a nudge.
 *  - Field-level changes patch the DOM in place. Only adding or removing an
 *    environment rebuilds the editor. This matters: blur fires as focus moves to
 *    the next field, so rebuilding on blur tears out the element the browser is
 *    mid-way through focusing and loses whatever was typed into it.
 */

import { ENV_META, byPipelineOrder, type EnvKey } from '@core/palette';
import { envBg, envFg } from '@ui/palette-vars';
import { suggestLoopbackPort, whoClaimsPort } from '@core/ports';
import {
  TRISTATES,
  TRISTATE_LABELS,
  availableEnvKeys,
  isTristate,
  removedEnvironment,
  displayLabel,
  draftToGroup,
  emptyDraft,
  groupToDraft,
  issuesByPath,
  newEnvironmentDraft,
  suggestedAliases,
  validateDraft,
  type EnvGroup,
  type EnvironmentDraft,
  type ExistingGroupSummary,
  type GroupDraft,
  type ValidationIssue,
} from '@core/schema';
import { parseBaseUrl } from '@core/url';
import { el, field, setFieldIssues } from '@ui/dom';

export interface EditorCallbacks {
  onSave: (group: EnvGroup) => Promise<void>;
  onCancel: () => void;
  onDelete: (id: string) => Promise<void>;
  /**
   * Requests host access for the group's origins.
   *
   * Called synchronously from the Save click, BEFORE saving. Chrome drops the user
   * gesture across an await, and `permissions.request` needs one, so this cannot
   * wait until after the write.
   */
  onRequestAccess: (group: EnvGroup) => Promise<boolean>;
}

export interface EditorContext {
  /** Groups other than the one being edited, for collision checks. */
  peers: ExistingGroupSummary[];
  /**
   * Where the global page-marker defaults currently sit, so a tri-state left on
   * "default" can say which way that falls.
   */
  defaults: { frame: boolean; tabIcon: boolean };
  /** All groups, for loopback port suggestions and claim hints. */
  allGroups: EnvGroup[];
  /** The group being edited, or undefined when creating a new one. */
  existing?: EnvGroup;
  /**
   * A prefilled draft to start from, used by "create a group from this tab".
   * Ignored when `existing` is set.
   */
  initialDraft?: GroupDraft;
}

export function renderGroupEditor(
  mount: HTMLElement,
  context: EditorContext,
  callbacks: EditorCallbacks,
): void {
  const isNew = !context.existing;
  const draft: GroupDraft = context.existing
    ? groupToDraft(context.existing)
    : (context.initialDraft ??
      withSuggestedLocalPort(emptyDraft(crypto.randomUUID()), context.allGroups));

  let saving = false;

  // Rebuilt wholesale on structural changes (adding or removing an environment).
  // Field-level updates patch in place so focus and caret position survive.
  const root = el('div', { class: 'editor' });
  mount.replaceChildren(root);

  const rerender = (): void => {
    const active = document.activeElement;
    const activeId = active instanceof HTMLElement ? active.id : '';
    build();
    if (activeId) document.getElementById(activeId)?.focus();
  };

  function build(): void {
    const titleInput = el('input', {
      class: 'text-input',
      type: 'text',
      value: draft.title,
      placeholder: 'Acme Storefront',
      maxLength: 120,
      autocomplete: 'off',
    });
    titleInput.addEventListener('input', () => {
      draft.title = titleInput.value;
      revalidate();
    });

    const descriptionInput = el('textarea', {
      class: 'text-input',
      value: draft.description,
      placeholder: 'Optional. What this group covers, or anything a teammate should know.',
      rows: 2,
      maxLength: 400,
    });
    descriptionInput.addEventListener('input', () => {
      draft.description = descriptionInput.value;
      revalidate();
    });

    const hiddenToggle = el('input', {
      type: 'checkbox',
      checked: draft.hidden,
      dataset: { toggle: 'hidden' },
    });
    hiddenToggle.addEventListener('change', () => {
      draft.hidden = hiddenToggle.checked;
    });

    // Removed environments are kept in the draft but not shown. The index passed through is
    // the position in draft.environments, not the visible position, because validation issue
    // paths are built from it and have to keep pointing at the right row.
    const envList = el('div', { class: 'env-list' });
    draft.environments.forEach((env, index) => {
      if (env.enabled) envList.append(renderEnvironmentRow(env, index));
    });

    const summary = el('div', { class: 'editor-summary' });

    const saveButton = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      textContent: isNew ? 'Create group' : 'Save changes',
    });
    saveButton.addEventListener('click', () => save());

    // Hooked, like every other control in here. Selecting it by class alone picks one of the
    // eighteen buttons in this form, usually a disabled reorder arrow.
    const cancelButton = el('button', {
      class: 'btn',
      type: 'button',
      textContent: 'Cancel',
      dataset: { action: 'cancel' },
    });
    cancelButton.addEventListener('click', () => callbacks.onCancel());

    const actions = el('div', { class: 'editor-actions' }, [
      saveButton,
      cancelButton,
      !isNew && context.existing
        ? renderDeleteButton(context.existing, callbacks)
        : null,
    ]);

    root.replaceChildren(
      el('h3', { class: 'editor-title', textContent: isNew ? 'New group' : 'Edit group' }),
      field('Title', titleInput, { required: true, id: 'group-title' }),
      field('Description', descriptionInput, { id: 'group-description' }),
      el('div', { class: 'env-section' }, [
        el('div', { class: 'env-section-head' }, [
          el('h4', { textContent: 'Environments' }),
          el('p', {
            class: 'field-hint',
            textContent:
              'Base URL only: scheme, host, port and any shared path prefix. Paths and query strings carry over when you switch.',
          }),
          // Otherwise wildcards are folklore. The syntax cannot be guessed, and the one
          // case it exists for (preview deploys) is the case where someone is most likely
          // to give up and not make a group at all.
          el('p', {
            class: 'field-hint',
            textContent:
              'A host can start with *. to match any subdomain, as in *.preview.acme.dev, for preview deploys whose hostname is different every time. Those are recognized but cannot be switched into, since there is no way to know which host you meant.',
          }),
        ]),
        envList,
        el('div', { class: 'field-issues', id: 'env-list-issues' }),
        renderAddEnvironment(),
      ]),
      el('div', { class: 'env-section markers-section' }, [
        el('div', { class: 'env-section-head' }, [
          el('h4', { textContent: 'On this group’s pages' }),
          el('p', {
            class: 'field-hint',
            textContent:
              'The markers apply to every environment in the group, each in its own color, so they tell you which one you are on rather than only that you are somewhere that matters.',
          }),
        ]),
        el('label', { class: 'inline-check' }, [
          hiddenToggle,
          el('span', {}, [
            'Hide the indicator on this site',
            el('span', {
              class: 'sub-note',
              textContent: 'Switching still works from the toolbar and keyboard shortcuts.',
            }),
          ]),
        ]),
        el('div', { class: 'tristate-row' }, [
          tristate(
            'frame',
            'Frame the page',
            context.defaults.frame,
            'A border around the whole viewport. It never intercepts clicks.',
          ),
          tristate(
            'tabIcon',
            'Mark the tab icon',
            context.defaults.tabIcon,
            'A color bar along the bottom of the site’s own icon, so tabs of the same site are tellable apart.',
          ),
        ]),
      ]),
      summary,
      actions,
    );

    revalidate();
  }

  /**
   * One page marker as a three-way select over the global default.
   *
   * A select rather than a checkbox because a checkbox has no way to say "whatever the
   * default is", and that has to be the resting state: if creating a group pinned both
   * markers, changing the global default afterwards would reach nothing that already
   * exists, which is the opposite of what a default is for.
   */
  function tristate(
    key: 'frame' | 'tabIcon',
    label: string,
    fallback: boolean,
    hint: string,
  ): HTMLElement {
    const select = el('select', {
      class: 'text-input select-input',
      dataset: { tristate: key },
    });

    for (const value of TRISTATES) {
      select.append(
        el('option', {
          value,
          // Spells out where the default currently sits. "Use the default" alone asks
          // someone to choose without showing them what they are choosing.
          textContent:
            value === 'default'
              ? `${TRISTATE_LABELS.default} (${fallback ? 'on' : 'off'})`
              : TRISTATE_LABELS[value],
          selected: draft[key] === value,
        }),
      );
    }

    select.addEventListener('change', () => {
      if (isTristate(select.value)) draft[key] = select.value;
    });

    const id = `group-${key}`;
    select.id = id;

    return el('div', { class: 'field setting-field' }, [
      el('label', { class: 'field-label', htmlFor: id, textContent: label }),
      select,
      el('p', { class: 'field-hint', textContent: hint }),
    ]);
  }

  function renderEnvironmentRow(env: EnvironmentDraft, index: number): HTMLElement {
    const meta = ENV_META[env.key];
    const path = `environments.${index}`;

    // A stable host for the alias controls, so they can be refreshed without
    // rebuilding the row (and destroying focus).
    const aliasHost = el('div', { class: 'aliases-host', dataset: { aliasesFor: path } });
    const refreshAliases = (): void => {
      aliasHost.replaceChildren(renderAliases(env, index, refreshAliases));
    };
    refreshAliases();

    const chip = el('span', {
      class: 'env-chip',
      style: { background: envBg(env.key), color: envFg(env.key) },
      attrs: { 'aria-hidden': 'true' },
    }, [el('span', { class: 'env-glyph', textContent: meta.glyph })]);

    const labelInput = el('input', {
      class: 'text-input label-input',
      type: 'text',
      value: env.label,
      placeholder: meta.label,
      maxLength: 40,
      autocomplete: 'off',
      id: `${path}-label`,
    });
    labelInput.setAttribute('aria-label', `Label for ${meta.label}`);
    labelInput.addEventListener('input', () => {
      env.label = labelInput.value;
      revalidate();
    });

    const urlInput = el('input', {
      class: 'text-input url-input',
      type: 'text',
      value: env.baseUrl,
      placeholder: env.key === 'local' ? 'http://localhost:3000' : 'https://staging.acme.com',
      spellcheck: false,
      autocomplete: 'off',
      id: `${path}-baseUrl`,
    });
    urlInput.setAttribute('aria-label', `Base URL for ${displayLabel(env)}`);
    urlInput.addEventListener('input', () => {
      env.baseUrl = urlInput.value;
      // Alias offers are refreshed while typing, not only on blur. If they only
      // appeared on blur, the row would grow at the exact moment focus left the
      // field, which is usually the moment a click is landing somewhere below it.
      // The layout would shift out from under the pointer and the click would hit
      // the wrong control.
      refreshAliases();
      revalidate();
    });
    // Normalizing on blur is what makes the filled-in port visible rather than
    // something that silently happens at save time.
    //
    // Deliberately NOT a full rebuild. Blur fires as focus moves to the next
    // field, so rebuilding here would tear out the element the browser is in the
    // middle of focusing, losing focus and any input already typed into it.
    urlInput.addEventListener('blur', () => {
      const parsed = parseBaseUrl(env.baseUrl);
      if (parsed.ok && parsed.value.normalized !== env.baseUrl) {
        env.baseUrl = parsed.value.normalized;
        urlInput.value = parsed.value.normalized;
      }
      refreshAliases();
      revalidate();
    });

    const guard = el('input', {
      type: 'checkbox',
      checked: env.confirmOnEnter,
      dataset: { toggle: 'confirmOnEnter' },
    });
    guard.setAttribute('aria-label', `Confirm before switching into ${displayLabel(env)}`);
    guard.addEventListener('change', () => {
      env.confirmOnEnter = guard.checked;
    });

    const remove = el('button', {
      class: 'btn btn-icon',
      type: 'button',
      textContent: '×',
      title: `Remove ${displayLabel(env)} from this group. Its URL is kept, so adding it back restores it.`,
      // Distinguishable from the reorder buttons, which share .btn-icon and are disabled at
      // the ends of the list. Selecting on class alone picked a disabled one.
      dataset: { action: 'remove' },
    });
    remove.setAttribute('aria-label', `Remove ${displayLabel(env)}`);
    remove.addEventListener('click', () => {
      // Switched off, NOT spliced out. A removed environment behaves exactly like a disabled
      // one everywhere downstream (it is skipped by matching, by the switcher, by origin
      // claims and by validation) while keeping its URL, aliases and label, so adding it back
      // is one click rather than retyping. Taking an environment out of a group is usually
      // temporary.
      env.enabled = false;
      rerender();
    });

    // Buttons rather than drag and drop. Order drives the switcher list and the
    // numeric shortcuts, so it needs to be reachable from the keyboard, and two
    // buttons do that without a drag interaction to make accessible.
    const move = (delta: number): HTMLButtonElement => {
      const target = index + delta;
      const button = el('button', {
        class: 'btn btn-icon btn-icon-sm',
        type: 'button',
        textContent: delta < 0 ? '↑' : '↓',
        disabled: target < 0 || target >= draft.environments.length,
        title: delta < 0 ? 'Move up' : 'Move down',
      });
      button.setAttribute(
        'aria-label',
        `Move ${displayLabel(env)} ${delta < 0 ? 'up' : 'down'}`,
      );
      button.addEventListener('click', () => {
        const [moved] = draft.environments.splice(index, 1);
        if (moved) draft.environments.splice(target, 0, moved);
        rerender();
      });
      return button;
    };

    const reorder = el('div', { class: 'env-reorder' }, [move(-1), move(1)]);

    const row = el('div', {
      class: 'env-row',
      dataset: { env: env.key, index: String(index) },
    }, [
      el('div', { class: 'env-row-main' }, [
        chip,
        labelInput,
        urlInput,
        reorder,
        remove,
      ]),
      el('div', { class: 'env-row-meta' }, [
        el('label', { class: 'inline-check inline-check-sm' }, [
          guard,
          el('span', { textContent: 'Confirm before entering' }),
        ]),
        aliasHost,
      ]),
      el('div', { class: 'field-issues', dataset: { issuesFor: path } }),
    ]);

    return row;
  }

  function renderAliases(
    env: EnvironmentDraft,
    index: number,
    refresh: () => void,
  ): HTMLElement {
    const container = el('div', { class: 'aliases' });

    for (const [aliasIndex, alias] of env.aliases.entries()) {
      const input = el('input', {
        class: 'text-input alias-input',
        type: 'text',
        value: alias,
        spellcheck: false,
        autocomplete: 'off',
        id: `environments.${index}-alias-${aliasIndex}`,
      });
      input.setAttribute('aria-label', `Alias ${aliasIndex + 1} for ${displayLabel(env)}`);
      input.addEventListener('input', () => {
        env.aliases[aliasIndex] = input.value;
        revalidate();
      });

      const drop = el('button', {
        class: 'btn btn-icon btn-icon-sm',
        type: 'button',
        textContent: '×',
        title: 'Remove this alias',
      });
      drop.addEventListener('click', () => {
        env.aliases.splice(aliasIndex, 1);
        refresh();
        revalidate();
      });

      container.append(el('div', { class: 'alias-row' }, [input, drop]));
    }

    // Chrome treats localhost and 127.0.0.1 as different origins even though they
    // are the same server, so offer the counterparts rather than leaving the user
    // to discover the problem.
    const missing = suggestedAliases(env.baseUrl).filter(
      (candidate) => !env.aliases.some((existing) => sameUrl(existing, candidate)),
    );

    for (const candidate of missing) {
      const add = el('button', {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        textContent: `+ ${candidate.replace(/^https?:\/\//, '')}`,
        title: `Also match ${candidate}. Chrome treats it as a different origin, though it is the same server.`,
      });
      add.addEventListener('click', () => {
        env.aliases.push(candidate);
        refresh();
        revalidate();
      });
      container.append(add);
    }

    return container;
  }

  function renderAddEnvironment(): HTMLElement {
    const available = availableEnvKeys(draft);
    if (available.length === 0) {
      return el('p', {
        class: 'field-hint',
        textContent: 'All six environment slots are in use.',
      });
    }

    const buttons = available.map((key) => {
      const meta = ENV_META[key];
      const remembered = removedEnvironment(draft, key);
      const keptUrl = remembered?.baseUrl.trim();

      const button = el('button', {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        // Says so explicitly when there is something to come back. A removed environment
        // keeping its URL is invisible otherwise, and someone who does not know would retype
        // it rather than trust the button.
        title: keptUrl ? `Add ${meta.label} back as ${keptUrl}` : meta.meaning,
        dataset: { addEnv: key },
      }, [
        el('span', {
          class: 'dot',
          style: { background: envBg(key) },
          attrs: { 'aria-hidden': 'true' },
        }),
        `Add ${meta.label}`,
        keptUrl ? el('span', { class: 'add-kept', textContent: keptUrl }) : null,
      ]);

      button.addEventListener('click', () => {
        if (remembered) {
          // Back on with everything it had. No splice, no re-insert: it never left the list,
          // so its position and its data are already right.
          remembered.enabled = true;
        } else {
          // Inserted in pipeline order, not appended. A group now starts with production
          // alone, so appending would leave a group built by adding local and dev reading
          // production, local, dev. Order is meaningful here (it drives the switcher list and
          // the numeric shortcuts), so the default should be the order people think in. The
          // reorder buttons are still there for anyone who disagrees.
          const added = prefilled(key, draft, context.allGroups);
          const at = draft.environments.findIndex(
            (existing) => byPipelineOrder(existing.key, key) > 0,
          );
          draft.environments.splice(at === -1 ? draft.environments.length : at, 0, added);
        }

        rerender();
        // Adding an environment is always followed by typing its URL, unless it came back
        // with one already.
        const field = root.querySelector<HTMLInputElement>(
          `.env-row[data-env="${key}"] .url-input`,
        );
        if (field && !field.value.trim()) field.focus();
      });

      return button;
    });

    return el('div', { class: 'add-env' }, buttons);
  }

  function revalidate(): void {
    const result = validateDraft(draft, context.peers);
    const byPath = issuesByPath(result.issues);

    setFieldIssues(root.querySelector('#group-title')?.closest('.field') ?? null, byPath.get('title') ?? []);
    setFieldIssues(
      root.querySelector('#group-description')?.closest('.field') ?? null,
      byPath.get('description') ?? [],
    );

    const envIssues = root.querySelector('#env-list-issues');
    if (envIssues) {
      envIssues.replaceChildren(
        ...(byPath.get('environments') ?? []).map((issue) =>
          el('p', { class: `issue issue-${issue.severity}`, textContent: issue.message }),
        ),
      );
    }

    // Roll every issue under environments.N.* up to that row, so a bad alias is
    // visible without expanding anything.
    for (const [index, env] of draft.environments.entries()) {
      const prefix = `environments.${index}`;
      const rowIssues: ValidationIssue[] = [];
      for (const [path, issues] of byPath) {
        if (path === prefix || path.startsWith(`${prefix}.`)) rowIssues.push(...issues);
      }

      const container = root.querySelector(`[data-issues-for="${prefix}"]`);
      if (container) {
        container.replaceChildren(
          ...rowIssues.map((issue) =>
            el('p', { class: `issue issue-${issue.severity}`, textContent: issue.message }),
          ),
        );
      }

      const row = root.querySelector(`.env-row[data-index="${index}"]`);
      row?.classList.toggle('has-error', rowIssues.some((i) => i.severity === 'error'));

      // A loopback port that is free is worth confirming, not just warning about.
      appendPortHint(container, env);
    }

    const saveButton = root.querySelector<HTMLButtonElement>('.btn-primary');
    if (saveButton) saveButton.disabled = !result.canSave || saving;
  }

  function appendPortHint(container: Element | null, env: EnvironmentDraft): void {
    if (!container || !env.enabled) return;

    const parsed = parseBaseUrl(env.baseUrl);
    if (!parsed.ok || !isLoopback(parsed.value.host)) return;

    const claim = whoClaimsPort(context.allGroups, parsed.value.port, draft.id);
    if (claim) return; // Already reported as a collision error.

    container.append(
      el('p', {
        class: 'issue issue-ok',
        textContent: `Port ${parsed.value.port} is not used by any other group.`,
      }),
    );
  }

  function save(): void {
    if (saving) return;
    const result = validateDraft(draft, context.peers);
    if (!result.canSave) return;

    const group = draftToGroup(draft, Date.now(), context.existing);

    // Fired first, in the same task as the click, so the user gesture is intact.
    //
    // Deliberately NOT awaited. Chrome's permission prompt is modal and can sit
    // there indefinitely, or be dismissed outright. Waiting on it before writing
    // would mean ignoring the prompt silently discards the group you just filled in.
    // Access has no bearing on whether a group is worth storing: a group without it
    // is perfectly usable, it just cannot draw its indicator on those hosts, and the
    // list offers a Grant button for that.
    void callbacks.onRequestAccess(group).catch(() => false);

    void finishSave(group);
  }

  async function finishSave(group: EnvGroup): Promise<void> {
    saving = true;
    revalidate();
    try {
      await callbacks.onSave(group);
    } catch (error) {
      const summary = root.querySelector('.editor-summary');
      summary?.replaceChildren(
        el('p', {
          class: 'issue issue-error',
          textContent: error instanceof Error ? error.message : 'Could not save this group.',
        }),
      );
    } finally {
      saving = false;
      revalidate();
    }
  }

  build();
}

function renderDeleteButton(group: EnvGroup, callbacks: EditorCallbacks): HTMLElement {
  const wrapper = el('div', { class: 'delete-slot' });

  const start = el('button', { class: 'btn btn-danger-ghost', type: 'button', textContent: 'Delete group' });
  const confirm = el('button', { class: 'btn btn-danger', type: 'button', textContent: 'Delete permanently' });
  const back = el('button', { class: 'btn', type: 'button', textContent: 'Keep it' });

  // A two-step inline confirm rather than a modal: window.confirm() blocks the
  // page and is easy to fire accidentally, and this keeps the destructive action
  // one deliberate extra click away.
  start.addEventListener('click', () => {
    wrapper.replaceChildren(
      el('span', { class: 'delete-prompt', textContent: `Delete "${group.title}"?` }),
      confirm,
      back,
    );
    confirm.focus();
  });
  back.addEventListener('click', () => wrapper.replaceChildren(start));
  confirm.addEventListener('click', () => void callbacks.onDelete(group.id));

  wrapper.append(start);
  return wrapper;
}

/** Prefills a new local environment with a port no other group has claimed. */
function prefilled(key: EnvKey, draft: GroupDraft, allGroups: EnvGroup[]): EnvironmentDraft {
  const env = newEnvironmentDraft(key);
  if (key === 'local') {
    env.baseUrl = `http://localhost:${suggestLoopbackPort(allGroups)}`;
  }
  void draft;
  return env;
}

function withSuggestedLocalPort(draft: GroupDraft, allGroups: EnvGroup[]): GroupDraft {
  const local = draft.environments.find((env) => env.key === 'local');
  if (local && !local.baseUrl) {
    local.baseUrl = `http://localhost:${suggestLoopbackPort(allGroups)}`;
  }
  return draft;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function sameUrl(a: string, b: string): boolean {
  const pa = parseBaseUrl(a);
  const pb = parseBaseUrl(b);
  return pa.ok && pb.ok && pa.value.matchKey === pb.value.matchKey;
}
