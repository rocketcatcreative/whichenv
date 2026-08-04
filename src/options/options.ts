/**
 * Settings page.
 *
 * Composes three sections: the global indicator corner picker, the environment
 * group list and editor, and a read-only view of the locked palette so the color
 * decisions are verifiable in the browser.
 *
 * The view state is deliberately trivial (list or edit) and lives here rather than
 * in the editor, so the editor stays a pure render-a-draft function.
 *
 */

import './options.css';
import {
  ENV_KEYS,
  PALETTE_IDS,
  PALETTE_SETS,
  styleFor,
  type EnvKey,
  type PaletteId,
} from '@core/palette';
import {
  CORNERS,
  CORNER_LABELS,
  FRAME_WIDTHS,
  INDICATOR_SIZES,
  INDICATOR_SIZE_LABELS,
  getSettings,
  isIndicatorSize,
  normalizeFrameWidth,
  onSettingsChanged,
  updateSettings,
  type Corner,
  type Settings,
} from '@core/settings';
import { summarize, type EnvGroup } from '@core/schema';
import { hasAccess, requestAccess } from '@core/permissions';
import { takeDraft } from '@core/pending';
import type { GroupDraft } from '@core/schema';
import {
  deleteGroup,
  listGroups,
  onGroupsChanged,
  reorderGroups,
  saveGroup,
} from '@core/storage';
import { el } from '@ui/dom';
import { applyPaletteVars } from '@ui/palette-vars';
import { renderBackup } from './backup';
import { renderGroupEditor } from './group-editor';
import { renderGroupList } from './group-list';

const version = document.querySelector<HTMLElement>('#version');
if (version) {
  version.textContent = `Version ${chrome.runtime.getManifest().version}`;
}

// ------------------------------------------------------------ corner picker

const cornersRoot = document.querySelector<HTMLElement>('#corners');

async function initCornerPicker(): Promise<void> {
  if (!cornersRoot) return;

  // Keep the preview pill's color sourced from the palette rather than
  // hardcoded in CSS, so there is one place colors are defined. Staging stands in for
  // "an environment" here, and follows the chosen set like everything else.
  const setPreviewColor = (palette: PaletteId): void => {
    cornersRoot.style.setProperty('--preview-color', styleFor('staging', palette).bg);
  };

  const buttons = new Map<Corner, HTMLButtonElement>();

  const select = (active: Corner): void => {
    for (const [corner, button] of buttons) {
      const isActive = corner === active;
      button.setAttribute('aria-checked', String(isActive));
      // Only the selected radio stays in the tab order, per the radiogroup
      // pattern. Arrow keys move between the rest.
      button.tabIndex = isActive ? 0 : -1;
    }
  };

  for (const corner of CORNERS) {
    const button = document.createElement('button');
    button.className = 'corner';
    button.type = 'button';
    button.dataset.corner = corner;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    button.setAttribute('aria-label', CORNER_LABELS[corner]);

    const preview = document.createElement('span');
    preview.className = 'corner-preview';

    const label = document.createElement('span');
    label.className = 'corner-label';
    label.textContent = CORNER_LABELS[corner];

    button.append(preview, label);
    button.addEventListener('click', () => {
      // Paint the selection immediately, then persist. The storage listener
      // below reconciles if the write is rejected or changed elsewhere.
      select(corner);
      void updateSettings({ corner });
    });

    buttons.set(corner, button);
    cornersRoot.append(button);
  }

  cornersRoot.addEventListener('keydown', (event) => {
    const keys: Record<string, number> = {
      ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1,
    };
    const step = keys[event.key];
    if (step === undefined) return;
    event.preventDefault();

    const current = CORNERS.findIndex(
      (corner) => buttons.get(corner)?.getAttribute('aria-checked') === 'true',
    );
    const next = CORNERS[(current + step + CORNERS.length) % CORNERS.length];
    if (!next) return;
    select(next);
    buttons.get(next)?.focus();
    void updateSettings({ corner: next });
  });

  const settings = await getSettings();
  select(settings.corner);
  setPreviewColor(settings.paletteId);

  onSettingsChanged((next) => {
    select(next.corner);
    setPreviewColor(next.paletteId);
  });
}

void initCornerPicker();

// ------------------------------------------------------------ indicator size

const sizeRoot = document.querySelector<HTMLElement>('#indicator-size');

async function initIndicatorSize(): Promise<void> {
  if (!sizeRoot) return;

  const render = (settings: Settings): void => {
    const select = el('select', { class: 'text-input select-input' });
    for (const size of INDICATOR_SIZES) {
      select.append(
        el('option', {
          value: size,
          textContent: INDICATOR_SIZE_LABELS[size],
          selected: size === settings.indicatorSize,
        }),
      );
    }
    select.addEventListener('change', () => {
      if (isIndicatorSize(select.value)) void updateSettings({ indicatorSize: select.value });
    });

    sizeRoot.replaceChildren(
      el('div', { class: 'field setting-field' }, [
        el('label', { class: 'field-label', textContent: 'Indicator size' }),
        select,
        el('p', {
          class: 'field-hint',
          textContent:
            'Large uses bigger text and more padding. Global, for the same reason the position is: the point of the indicator is that it is always the same thing in the same place.',
        }),
      ]),
    );
  };

  render(await getSettings());
  onSettingsChanged(render);
}

void initIndicatorSize();

// ------------------------------------------------------------- page markers

const markersRoot = document.querySelector<HTMLElement>('#markers');

async function initMarkers(): Promise<void> {
  if (!markersRoot) return;

  const render = (settings: Settings): void => {
    const width = el('select', { class: 'text-input select-input' });
    for (const value of FRAME_WIDTHS) {
      width.append(
        el('option', {
          value: String(value),
          textContent: `${value}px`,
          selected: value === settings.frameWidth,
        }),
      );
    }
    width.addEventListener('change', () => {
      void updateSettings({ frameWidth: normalizeFrameWidth(Number(width.value)) });
    });

    markersRoot.replaceChildren(
      markerToggle(
        'frameByDefault',
        'Frame the page',
        'Draws a border around the whole viewport in the current environment’s color. It never intercepts clicks.',
        settings.frameByDefault,
      ),
      el('div', { class: 'field setting-field' }, [
        el('label', { class: 'field-label', textContent: 'Frame thickness' }),
        width,
        el('p', {
          class: 'field-hint',
          textContent:
            'Applies wherever a frame is drawn. The indicator moves in from the edge to match, so the frame never sits on top of it.',
        }),
      ]),
      markerToggle(
        'tabIconByDefault',
        'Mark the tab icon',
        'Adds a color bar along the bottom of the site’s own icon, so tabs of the same site are tellable apart in the strip. The site’s icon comes back when this is switched off.',
        settings.tabIconByDefault,
      ),
    );
  };

  render(await getSettings());
  onSettingsChanged(render);
}

/** A labelled checkbox bound to one of the marker defaults. */
function markerToggle(
  key: 'frameByDefault' | 'tabIconByDefault',
  label: string,
  note: string,
  current: boolean,
): HTMLElement {
  const input = el('input', { type: 'checkbox', checked: current });
  input.addEventListener('change', () => {
    void updateSettings({ [key]: input.checked });
  });

  return el('label', { class: 'inline-check', dataset: { setting: key } }, [
    input,
    el('span', {}, [label, el('span', { class: 'sub-note', textContent: note })]),
  ]);
}

void initMarkers();

// ------------------------------------------------------------- group editor

const groupsView = document.querySelector<HTMLElement>('#groups-view');

type View =
  | { mode: 'list' }
  | { mode: 'edit'; id?: string; initialDraft?: GroupDraft };

let view: View = { mode: 'list' };
let notice = '';

async function renderGroups(): Promise<void> {
  if (!groupsView) return;

  const groups = await listGroups();

  if (view.mode === 'list') {
    renderGroupList(groupsView, groups, await missingAccessIds(groups), {
      onAdd: () => {
        view = { mode: 'edit' };
        void renderGroups();
      },
      onEdit: (id: string) => {
        view = { mode: 'edit', id };
        void renderGroups();
      },
      onChanged: () => void renderGroups(),
      onReorder: (ids) => void reorderGroups(ids).then(() => renderGroups()),
      onNotice: (message) => {
        notice = message;
        void renderGroups();
      },
    });

    if (notice) {
      groupsView.append(
        el('p', { class: 'issue issue-ok list-notice', textContent: notice }),
      );
      notice = '';
    }
    return;
  }

  // Captured before any await or closure so narrowing survives.
  const editingId = view.id;
  const initialDraft = view.mode === 'edit' ? view.initialDraft : undefined;
  const existing = editingId ? groups.find((group) => group.id === editingId) : undefined;

  // An id that no longer resolves means the group was deleted elsewhere, most
  // likely on another machine via sync. Fall back to the list rather than opening
  // an editor for something that is gone.
  if (editingId && !existing) {
    view = { mode: 'list' };
    void renderGroups();
    return;
  }

  // Passed in rather than read inside the editor, so a tri-state left on "default" can
  // say WHICH way the default currently falls. "Use the default" on its own is a control
  // whose effect you cannot see from where you are being asked to set it.
  const settings = await getSettings();

  renderGroupEditor(
    groupsView,
    {
      allGroups: groups,
      peers: groups.filter((group) => group.id !== editingId).map(summarize),
      defaults: { frame: settings.frameByDefault, tabIcon: settings.tabIconByDefault },
      ...(existing ? { existing } : {}),
      ...(initialDraft ? { initialDraft } : {}),
    },
    {
      onSave: async (group) => {
        await saveGroup(group);
        view = { mode: 'list' };
        await renderGroups();
      },
      // Runs synchronously from the Save click, before any await, because Chrome
      // drops the user gesture across one and permissions.request needs it.
      onRequestAccess: requestAccess,
      onCancel: () => {
        view = { mode: 'list' };
        void renderGroups();
      },
      onDelete: async (id) => {
        await deleteGroup(id);
        view = { mode: 'list' };
        await renderGroups();
      },
    },
  );
}

/** Which groups cannot draw their indicator yet, for the grant prompt. */
async function missingAccessIds(groups: EnvGroup[]): Promise<Set<string>> {
  const entries = await Promise.all(
    groups.map(async (group) => [group.id, await hasAccess(group)] as const),
  );
  return new Set(entries.filter(([, granted]) => !granted).map(([id]) => id));
}

/**
 * Opens the editor prefilled when the popup handed over a draft.
 *
 * `takeDraft` clears the stash as it reads, so reloading this page does not reopen an
 * editor that was already dismissed.
 */
async function start(): Promise<void> {
  const pending = await takeDraft();
  if (pending) view = { mode: 'edit', initialDraft: pending };
  await renderGroups();
}

void start();

// ---------------------------------------------------------- backup and share

const backupRoot = document.querySelector<HTMLElement>('#backup');
if (backupRoot) {
  renderBackup(backupRoot, { onChanged: () => void renderGroups() });
}

// Keep the list in step with edits made in another window or synced from another
// machine, but never yank the editor out from under someone mid-type.
onGroupsChanged(() => {
  if (view.mode === 'list') void renderGroups();
});

// A grant or revocation made in Chrome's own extension settings should show up here.
chrome.permissions.onAdded.addListener(() => {
  if (view.mode === 'list') void renderGroups();
});
chrome.permissions.onRemoved.addListener(() => {
  if (view.mode === 'list') void renderGroups();
});

// ------------------------------------------------------------- switching

const switchingRoot = document.querySelector<HTMLElement>('#switching');

/** A labelled checkbox bound to one boolean setting. */
function settingToggle(
  key: 'openInNewTabByDefault' | 'createTabGroupOnNewTab',
  label: string,
  note: string,
  current: boolean,
): HTMLElement {
  const input = el('input', { type: 'checkbox', checked: current });
  input.addEventListener('change', () => {
    void updateSettings({ [key]: input.checked });
  });

  return el('label', { class: 'inline-check', dataset: { setting: key } }, [
    input,
    el('span', {}, [label, el('span', { class: 'sub-note', textContent: note })]),
  ]);
}

async function initSwitching(): Promise<void> {
  if (!switchingRoot) return;

  const render = (settings: Awaited<ReturnType<typeof getSettings>>): void => {
    const collapse = el('select', { class: 'text-input select-input' });
    for (const [value, text] of [
      ['2000', 'After 2 seconds'],
      ['4000', 'After 4 seconds'],
      ['8000', 'After 8 seconds'],
      ['0', 'Never, keep it expanded'],
    ] as const) {
      collapse.append(
        el('option', {
          value,
          textContent: text,
          selected: Number(value) === settings.autoCollapseMs,
        }),
      );
    }
    collapse.addEventListener('change', () => {
      void updateSettings({ autoCollapseMs: Number(collapse.value) });
    });

    switchingRoot.replaceChildren(
      settingToggle(
        'openInNewTabByDefault',
        'Open switches in a new tab',
        'Off means a switch replaces the tab you are on. Cmd or Ctrl inverts whichever you pick.',
        settings.openInNewTabByDefault,
      ),
      settingToggle(
        'createTabGroupOnNewTab',
        'Gather new tabs into a Chrome tab group',
        'One group per site, named after it, colored by the riskiest environment open in it.',
        settings.createTabGroupOnNewTab,
      ),
      el('div', { class: 'field setting-field' }, [
        el('label', { class: 'field-label', textContent: 'Collapse the indicator' }),
        collapse,
        el('p', {
          class: 'field-hint',
          textContent:
            'The expanded pill shrinks to a colored chip at the edge of the screen. Hover brings it back.',
        }),
      ]),
    );
  };

  render(await getSettings());
  // Reflect changes made in another window, or on another machine via sync.
  onSettingsChanged(render);
}

void initSwitching();

// ----------------------------------------------------------- shortcuts

const shortcutsRoot = document.querySelector<HTMLElement>('#shortcuts');

async function renderShortcuts(): Promise<void> {
  if (!shortcutsRoot) return;

  const commands = await chrome.commands.getAll();
  const rows = commands
    // The reserved `_execute_action` entry is Chrome's own, not ours to explain.
    .filter((command) => command.name && !command.name.startsWith('_'))
    .map((command) => {
      const bound = Boolean(command.shortcut);
      return el('tr', { class: bound ? '' : 'shortcut-unbound' }, [
        el('td', { class: 'shortcut-keys' }, [
          bound
            ? el('kbd', { textContent: command.shortcut ?? '' })
            : el('span', { class: 'shortcut-none', textContent: 'Not set' }),
        ]),
        el('td', { textContent: command.description ?? command.name ?? '' }),
      ]);
    });

  const openShortcuts = el('button', {
    class: 'btn btn-sm',
    type: 'button',
    textContent: 'Edit shortcuts in Chrome',
  });
  // chrome://extensions/shortcuts cannot be linked to directly from a page, so it
  // has to be opened as a tab from extension code.
  openShortcuts.addEventListener('click', () => {
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  shortcutsRoot.replaceChildren(
    el('table', { class: 'shortcut-table' }, [el('tbody', {}, rows)]),
    el('div', { class: 'list-actions' }, [openShortcuts]),
  );
}

void renderShortcuts();

// --------------------------------------------------------------- palette

const palettesRoot = document.querySelector<HTMLElement>('#palettes');
const swatches = document.querySelector<HTMLElement>('#swatches');

/**
 * One row of the colour list: the environment as it will look, and what it means.
 *
 * Deliberately shows no hex, no contrast ratio and no tab-group colour name. Those were here
 * and they were noise: nobody choosing a palette needs to read `#15803D`, and a contrast
 * figure invites you to check something the unit suite already refuses to let regress. The
 * numbers still exist where they are useful, in `docs/palette-preview.html`.
 */
function swatch(key: EnvKey, palette: PaletteId): HTMLElement {
  const style = styleFor(key, palette);

  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.style.background = style.bg;
  chip.style.color = style.fg;

  const glyph = document.createElement('span');
  glyph.className = 'g';
  glyph.textContent = style.glyph;
  glyph.setAttribute('aria-hidden', 'true');
  chip.append(glyph, document.createTextNode(style.label));

  // No "(spare slot)" suffix: ENV_META already opens with "Spare slot." for those two, and
  // the row is one line now, so the repetition was plain to see.
  const meaning = document.createElement('div');
  meaning.className = 'meta';
  meaning.textContent = style.meaning;

  const row = document.createElement('div');
  row.className = 'swatch';
  row.append(chip, meaning);
  return row;
}

async function initPalettePicker(): Promise<void> {
  if (!palettesRoot && !swatches) return;

  const buttons = new Map<PaletteId, HTMLButtonElement>();

  const paint = (active: PaletteId): void => {
    // Publishes the set as CSS variables, which is what repaints the group cards and
    // the editor without re-rendering them.
    applyPaletteVars(active);
    for (const [id, button] of buttons) {
      const isActive = id === active;
      button.setAttribute('aria-checked', String(isActive));
      // Radiogroup pattern: only the checked option stays in the tab order.
      button.tabIndex = isActive ? 0 : -1;
    }
    if (swatches) swatches.replaceChildren(...ENV_KEYS.map((key) => swatch(key, active)));
  };

  for (const id of PALETTE_IDS) {
    const set = PALETTE_SETS[id];

    const button = document.createElement('button');
    button.className = 'palette';
    button.type = 'button';
    button.dataset.palette = id;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');

    // A strip of the actual colours, in pipeline order, so the choice is made by
    // looking rather than by reading a name.
    const strip = document.createElement('span');
    strip.className = 'palette-strip';
    strip.setAttribute('aria-hidden', 'true');
    for (const key of ENV_KEYS) {
      const cell = document.createElement('span');
      cell.style.background = set.colors[key].bg;
      strip.append(cell);
    }

    button.append(
      strip,
      Object.assign(document.createElement('span'), {
        className: 'palette-label',
        textContent: set.label,
      }),
      Object.assign(document.createElement('span'), {
        className: 'palette-note',
        textContent: set.description,
      }),
    );

    button.addEventListener('click', () => {
      // Paint first, persist second. The storage listener below reconciles if the
      // write is rejected or the value changes on another machine.
      paint(id);
      void updateSettings({ paletteId: id });
    });

    buttons.set(id, button);
    palettesRoot?.append(button);
  }

  palettesRoot?.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();

    const current = PALETTE_IDS.findIndex(
      (id) => buttons.get(id)?.getAttribute('aria-checked') === 'true',
    );
    const next = PALETTE_IDS[(current + step + PALETTE_IDS.length) % PALETTE_IDS.length];
    if (!next) return;
    paint(next);
    buttons.get(next)?.focus();
    void updateSettings({ paletteId: next });
  });

  paint((await getSettings()).paletteId);
  onSettingsChanged((settings) => paint(settings.paletteId));
}

void initPalettePicker();
