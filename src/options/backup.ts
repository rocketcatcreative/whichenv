/**
 * Export, import and share.
 *
 * Backing up or moving a setup between machines, and handing one group to a teammate.
 * The rules live in core/config.ts; this is the UI around them.
 *
 * Import always shows what it is about to do and waits for a second click. An import
 * that silently overwrote a group would be a mistake with no undo, and the plan is
 * cheap to compute and easy to read.
 */

import {
  describePlan,
  exportFilename,
  parseConfig,
  planImport,
  serializeConfig,
  type ImportMode,
  type ImportPlan,
} from '@core/config';
import type { EnvGroup } from '@core/schema';
import { getSettings } from '@core/settings';
import { deleteGroups, listGroups, saveGroups } from '@core/storage';
import { el } from '@ui/dom';

export interface BackupCallbacks {
  /** Called after an import changes anything, so the list can re-render. */
  onChanged: () => void;
}

export function renderBackup(mount: HTMLElement, callbacks: BackupCallbacks): void {
  const status = el('div', { class: 'field-issues backup-status' });

  const say = (message: string, kind: 'ok' | 'error' | 'warning' = 'ok'): void => {
    status.replaceChildren(el('p', { class: `issue issue-${kind}`, textContent: message }));
  };

  // ------------------------------------------------------------------ export
  const download = el('button', {
    class: 'btn btn-sm',
    type: 'button',
    textContent: 'Download backup',
  });
  download.addEventListener('click', () => {
    void (async () => {
      const text = serializeConfig(await listGroups(), await getSettings(), Date.now());
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const anchor = el('a', { href: url, download: exportFilename(new Date()) });
      anchor.click();
      // Revoked on a timeout rather than immediately: Chrome needs the URL to still
      // resolve when it starts the download.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      say('Backup downloaded.');
    })();
  });

  const copyAll = el('button', {
    class: 'btn btn-sm',
    type: 'button',
    textContent: 'Copy to clipboard',
  });
  copyAll.addEventListener('click', () => {
    void (async () => {
      const text = serializeConfig(await listGroups(), await getSettings(), Date.now());
      try {
        await navigator.clipboard.writeText(text);
        say('Whole config copied to the clipboard.');
      } catch {
        say('Could not reach the clipboard. Use Download backup instead.', 'error');
      }
    })();
  });

  // ------------------------------------------------------------------ import
  const textarea = el('textarea', {
    class: 'text-input import-input',
    rows: 4,
    placeholder:
      'Paste a whole config, a list of groups, or a single group shared by a teammate.',
    spellcheck: false,
  });

  const file = el('input', { type: 'file', accept: '.json,application/json' });
  file.addEventListener('change', () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    void chosen.text().then((text) => {
      textarea.value = text;
      preview();
      file.value = '';
    });
  });

  const modeSelect = el('select', { class: 'text-input select-input' });
  modeSelect.append(
    el('option', { value: 'merge', textContent: 'Merge with what I have' }),
    el('option', { value: 'replace', textContent: 'Replace everything' }),
  );
  modeSelect.addEventListener('change', () => preview());
  textarea.addEventListener('input', () => preview());

  const planBox = el('div', { class: 'import-plan' });
  const confirm = el('button', {
    class: 'btn btn-primary btn-sm',
    type: 'button',
    textContent: 'Import',
    disabled: true,
  });

  let pending: { plan: ImportPlan; mode: ImportMode } | null = null;

  function preview(): void {
    pending = null;
    confirm.disabled = true;
    planBox.replaceChildren();
    status.replaceChildren();

    if (!textarea.value.trim()) return;

    const parsed = parseConfig(textarea.value);
    if (!parsed.ok) {
      say(parsed.error, 'error');
      return;
    }

    const mode = modeSelect.value as ImportMode;

    void (async () => {
      const existing = await listGroups();
      const plan = planImport(parsed.value.groups, existing, mode);
      pending = { plan, mode };

      const lines: HTMLElement[] = [];
      for (const group of plan.add) {
        lines.push(el('li', { class: 'plan-add', textContent: `Add "${group.title}"` }));
      }
      for (const entry of plan.update) {
        lines.push(
          el('li', {
            class: 'plan-update',
            textContent: `Overwrite "${entry.existingTitle}" with "${entry.incoming.title}"`,
          }),
        );
      }
      for (const group of plan.remove) {
        lines.push(el('li', { class: 'plan-remove', textContent: `Delete "${group.title}"` }));
      }
      for (const entry of plan.skip) {
        lines.push(
          el('li', {
            class: 'plan-skip',
            textContent: `Skip "${entry.group.title}", ${entry.reason}`,
          }),
        );
      }

      planBox.replaceChildren(
        el('p', { class: 'plan-summary', textContent: describePlan(plan) }),
        el('ul', { class: 'plan-list' }, lines),
      );

      if (parsed.value.dropped > 0) {
        say(`${parsed.value.dropped} entry in that config could not be read and was ignored.`, 'warning');
      }

      confirm.disabled =
        plan.add.length + plan.update.length + plan.remove.length === 0;
    })();
  }

  confirm.addEventListener('click', () => {
    if (!pending) return;
    const { plan } = pending;
    confirm.disabled = true;

    void (async () => {
      try {
        // Deletions first, so a replace that reuses a URL under a different group id does
        // not trip over the outgoing group.
        //
        // Batched deliberately: an import of any size is at most three storage operations,
        // never one or two per group. chrome.storage.sync enforces a writes-per-minute
        // quota, and a per-group loop that hits it stops halfway, leaving some groups
        // stored and some not. You agreed to the plan above; a partial version of it is
        // not an outcome anyone asked for.
        await deleteGroups(plan.remove.map((group) => group.id));
        await saveGroups([...plan.update.map((entry) => entry.incoming), ...plan.add]);

        textarea.value = '';
        planBox.replaceChildren();
        say(`Imported. ${describePlan(plan)}.`);
        callbacks.onChanged();
      } catch (error) {
        say(explainImportFailure(error), 'error');
      }
    })();
  });

  mount.replaceChildren(
    el('div', { class: 'backup-row' }, [download, copyAll]),
    el('div', { class: 'field' }, [
      el('label', { class: 'field-label', textContent: 'Import' }),
      textarea,
      el('div', { class: 'backup-row' }, [modeSelect, file]),
    ]),
    planBox,
    el('div', { class: 'backup-row' }, [confirm]),
    status,
  );
}

/**
 * Turns a storage failure into something actionable.
 *
 * Chrome's own wording for a spent write quota is "This request exceeds the
 * MAX_WRITE_OPERATIONS_PER_MINUTE quota", which names an internal constant and says nothing
 * about what to do. The quota is per minute and refills on its own, so the useful
 * information is: nothing was written, and waiting a minute fixes it.
 */
function explainImportFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');

  if (/MAX_WRITE_OPERATIONS|quota/i.test(message) && /MINUTE|HOUR/i.test(message)) {
    return (
      'Chrome is rate limiting writes to synced storage, so nothing was imported. ' +
      'It clears on its own: wait a minute and click Import again. The plan above is unchanged.'
    );
  }

  if (message) return message;
  return 'Something went wrong during the import, and nothing was written.';
}

/** The per-group share button, for the group list. */
export function shareButton(group: EnvGroup, onDone: (message: string) => void): HTMLElement {
  const button = el('button', {
    class: 'btn btn-sm btn-share',
    type: 'button',
    textContent: 'Copy',
    title: 'Copy this group as JSON, to paste to a teammate',
  });

  button.addEventListener('click', () => {
    void (async () => {
      try {
        const { serializeGroup } = await import('@core/config');
        await navigator.clipboard.writeText(serializeGroup(group));
        onDone(`"${group.title}" copied. Paste it into the Import box on another machine.`);
      } catch {
        onDone('Could not reach the clipboard.');
      }
    })();
  });

  return button;
}
