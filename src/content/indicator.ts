/**
 * The on-page environment indicator.
 *
 * Renders and reports clicks. It holds no knowledge of groups, storage or URL
 * rules: it asks the service worker "what am I looking at?" and sends back "the
 * user picked this environment". That split keeps this bundle small and keeps the
 * interesting logic in core/ where it is unit testable without a browser.
 *
 * Three behaviours worth knowing about:
 *
 *  - It lives in a CLOSED shadow root, so a host page's CSS cannot reach it and a
 *    host page's scripts cannot see inside it.
 *  - Target URLs are never held here. The switch message carries the URL the tab is
 *    on at click time, and the worker derives the destination, so a single page app
 *    that has changed route still switches to the route you are looking at.
 *  - Position and collapse timing come from global settings and update live.
 */

import indicatorCss from './indicator.css?inline';
import { applyMark, type FaviconHandle } from './favicon';
import { ENV_META, styleFor, type EnvKey } from '@core/palette';
import { send, type OpenMode, type Push, type ResolvedTab } from '@core/messages';
import { onSettingsChanged } from '@core/settings';

const HOST_TAG = 'whichenv-indicator';

/**
 * Which way a selection opens.
 *
 * Shift always means a new window. Otherwise the setting decides, and Cmd, Ctrl or
 * the ⧉ button INVERT it. Inverting rather than forcing is what makes the setting
 * meaningful: someone who prefers new tabs by default still needs a gesture for
 * replacing the current one.
 */
function modeFor(
  event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  viaNewTabButton: boolean,
  openInNewTabByDefault: boolean,
): OpenMode {
  if (event.shiftKey) return 'newWindow';
  const inverted = event.metaKey || event.ctrlKey || viaNewTabButton;
  const wantsNewTab = openInNewTabByDefault !== inverted;
  return wantsNewTab ? 'newTab' : 'current';
}

let unmount: (() => void) | null = null;
/** Set while mounted, so the keyboard command can open the list. */
let openSwitcher: (() => void) | null = null;

function mount(tab: ResolvedTab): void {
  let corner = tab.corner;
  let autoCollapseMs = tab.autoCollapseMs;
  let paletteId = tab.paletteId;
  let indicatorSize = tab.indicatorSize;
  let frameWidth = tab.frameWidth;

  const host = document.createElement(HOST_TAG);
  host.dataset.corner = corner;
  host.dataset.size = indicatorSize;
  host.dataset.state = 'expanded';

  /**
   * Publishes the frame width, and the clearance the pill needs from the edge.
   *
   * Two properties from one number because they are not the same thing. The frame is a
   * border of `--es-frame-width`; `--es-edge` is how far in from the viewport edge the
   * pill has to start so the frame does not sit on top of it. `--es-edge` is zero when
   * there is no frame, which is what keeps the default layout pixel-identical to what it
   * was before any of this was configurable.
   */
  const applyEdge = (): void => {
    host.style.setProperty('--es-frame-width', `${frameWidth}px`);
    host.style.setProperty('--es-edge', tab.frame ? `${frameWidth}px` : '0px');
  };
  applyEdge();

  const shadow = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(indicatorCss);
  shadow.adoptedStyleSheets = [sheet];


  const root = document.createElement('div');
  root.className = 'root';

  // ----------------------------------------------------------------- the pill
  const pill = document.createElement('button');
  pill.className = 'pill';
  pill.type = 'button';
  pill.setAttribute('aria-haspopup', 'listbox');
  pill.setAttribute('aria-expanded', 'false');
  pill.title = `${tab.label} on ${tab.groupTitle}`;

  const glyph = document.createElement('span');
  glyph.className = 'glyph';
  glyph.textContent = ENV_META[tab.envKey].glyph;
  glyph.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.className = 'text';
  text.append(
    Object.assign(document.createElement('span'), { className: 'env', textContent: tab.label }),
    Object.assign(document.createElement('span'), {
      className: 'group',
      textContent: tab.groupTitle,
    }),
  );

  /**
   * The disclosure cue, shown only while collapsed.
   *
   * Collapsed, the pill is a plain colour chip, which reads as a status light rather than as
   * something you can open. Three dots say otherwise without asking for any more space than
   * the chip already occupies.
   *
   * A vertical ellipsis rather than a chevron, which was the first attempt. A chevron has to
   * point somewhere, and what it pointed at was only half true: hovering opens the pill
   * sideways, but clicking opens a list downwards. Dots claim a menu without claiming a
   * direction, and being symmetric they need no per-corner flip.
   *
   * Drawn rather than typed, for the same reason the tab marks are: at this size a font
   * fallback is the difference between an icon and a smudge. The viewBox is cropped tight
   * around the shape so it fills the box it is given instead of floating in whitespace.
   */
  const cue = document.createElement('span');
  cue.className = 'cue';
  cue.setAttribute('aria-hidden', 'true');
  cue.innerHTML =
    `<svg viewBox="0 0 2 9" fill="currentColor">` +
    `<circle cx="1" cy="1" r="1"/><circle cx="1" cy="4.5" r="1"/><circle cx="1" cy="8" r="1"/>` +
    `</svg>`;

  pill.append(glyph, text, cue);

  // ---------------------------------------------------- the environment list
  const list = document.createElement('div');
  list.className = 'list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', `Switch environment for ${tab.groupTitle}`);
  list.hidden = true;

  const head = document.createElement('div');
  head.className = 'list-head';
  head.append(
    Object.assign(document.createElement('span'), { textContent: 'Switch to' }),
    Object.assign(document.createElement('span'), { textContent: tab.groupTitle }),
  );
  list.append(head);

  const rows: HTMLButtonElement[] = [];
  /** Every element whose colour comes from the palette, for repainting on a change. */
  const dots: { envKey: EnvKey; el: HTMLElement }[] = [];

  // The one thing here that reaches OUT of the shadow root, because a favicon is a
  // <link> in the page's own head and there is nowhere else to put it. Declared before
  // paint(), which repaints it along with everything else.
  let favicon: FaviconHandle | null = tab.tabIcon ? applyMark(tab.envKey, paletteId) : null;
  if (favicon) host.dataset.tabIcon = 'on';

  for (const sibling of tab.siblings) {
    const row = document.createElement('button');
    row.className = 'row';
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.dataset.env = sibling.envKey;

    const dot = document.createElement('span');
    dot.className = 'row-dot';
    dot.textContent = ENV_META[sibling.envKey].glyph;
    dot.setAttribute('aria-hidden', 'true');
    dots.push({ envKey: sibling.envKey, el: dot });

    const rowText = document.createElement('span');
    rowText.className = 'row-text';
    rowText.append(
      Object.assign(document.createElement('span'), {
        className: 'row-env',
        textContent: sibling.label,
      }),
      Object.assign(document.createElement('span'), {
        className: 'row-host',
        textContent: sibling.display,
      }),
    );

    // Inline SVG rather than a glyph character. At 10px a font fallback is the difference
    // between an icon and a smudge, which is the same reason the tab marks are drawn paths.
    const icon = (paths: string, label: string, className: string): HTMLElement => {
      const button = document.createElement('span');
      button.className = className;
      button.title = label;
      button.setAttribute('aria-hidden', 'true');
      button.innerHTML =
        `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" ` +
        `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
      return button;
    };

    const newTab = icon(
      '<path d="M9 2.8h4.2V7"/><path d="M13.2 2.8 7.6 8.4"/>' +
        '<path d="M12.4 9.6v3a1.6 1.6 0 0 1-1.6 1.6H3.4a1.6 1.6 0 0 1-1.6-1.6V5.2a1.6 1.6 0 0 1 1.6-1.6h3"/>',
      'Open in a new tab (or hold Cmd/Ctrl)',
      'row-new',
    );

    const copy = icon(
      '<rect x="5.6" y="5.6" width="8.2" height="8.2" rx="1.6"/>' +
        '<path d="M11 3.4A1.6 1.6 0 0 0 9.4 1.8H3.8a1.6 1.6 0 0 0-1.6 1.6v5.6A1.6 1.6 0 0 0 3.8 10.6"/>',
      `Copy the ${sibling.label} link for this page`,
      'row-copy',
    );

    row.append(dot, rowText, copy, newTab);

    // An environment with the enter guard on takes a second, deliberate click.
    // This is the feature that pays for itself the first time it stops a
    // destructive test running against real data.
    let armed = false;
    const disarm = (): void => {
      if (!armed) return;
      armed = false;
      row.classList.remove('row-armed');
      rowText.querySelector('.row-env')!.textContent = sibling.label;
    };

    /** Briefly relabels the row, reusing the pattern the enter guard already uses. */
    const flash = (message: string): void => {
      const target = rowText.querySelector('.row-env');
      if (!target) return;
      target.textContent = message;
      window.setTimeout(() => {
        if (target.textContent === message) target.textContent = sibling.label;
      }, 1400);
    };

    row.addEventListener('click', (event) => {
      // Copying must be checked before anything else: it is the one action on this row that
      // does not navigate, so falling through to the switch would defeat the point.
      if (copy.contains(event.target as Node)) {
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          const response = await send({
            type: 'urlFor',
            groupId: tab.groupId,
            envKey: sibling.envKey,
            url: window.location.href,
          });
          if (!response || response.type !== 'url') {
            flash('Could not copy');
            return;
          }
          try {
            await navigator.clipboard.writeText(response.url);
            flash('Copied');
          } catch {
            flash('Could not copy');
          }
        })();
        return;
      }

      const mode = modeFor(event, newTab.contains(event.target as Node), tab.openInNewTabByDefault);

      if (sibling.confirmOnEnter && !armed) {
        for (const other of rows) other.dispatchEvent(new CustomEvent('es-disarm'));
        armed = true;
        row.classList.add('row-armed');
        rowText.querySelector('.row-env')!.textContent = `Confirm ${sibling.label}`;
        return;
      }

      closeList(false);
      void send({
        type: 'switch',
        groupId: tab.groupId,
        envKey: sibling.envKey,
        url: window.location.href,
        mode,
      });
    });

    row.addEventListener('es-disarm', disarm);
    row.addEventListener('blur', disarm);

    rows.push(row);
    list.append(row);
  }

  if (tab.siblings.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'note';
    empty.textContent = 'This group has no other environments set up yet.';
    list.append(empty);
  }

  /**
   * Paints every palette-derived colour.
   *
   * Called once before mounting and again on a palette change. Repainting in place
   * rather than remounting keeps the pill's collapse state, an open list and a focused
   * row exactly as they were, which matters because the options page is usually open in
   * another tab while someone tries the sets out.
   */
  const paint = (): void => {
    const current = styleFor(tab.envKey, paletteId);
    // Mirrored onto the host as an attribute purely so the end to end suite can assert
    // it: the shadow root is closed, so the host element is the only thing a test (or
    // the page) can see, and that is the point.
    host.dataset.palette = paletteId;
    host.style.setProperty('--es-bg', current.bg);
    host.style.setProperty('--es-fg', current.fg);
    for (const dot of dots) {
      const style = styleFor(dot.envKey, paletteId);
      dot.el.style.background = style.bg;
      dot.el.style.color = style.fg;
    }
    favicon?.update(paletteId);
  };

  paint();

  root.append(pill, list);

  if (tab.frame) {
    // Appended as a SIBLING of .root, not inside it: .root is a flex column, and a
    // fixed-position flex item is a needless thing to reason about. Its colour comes
    // from --es-bg on the host, so a palette change repaints it with no extra work.
    const frame = document.createElement('div');
    frame.className = 'frame';
    frame.setAttribute('aria-hidden', 'true');
    shadow.append(frame);
    // Mirrored onto the host so the end to end suite can see it through the closed
    // shadow root.
    host.dataset.frame = 'on';
  }

  shadow.append(root);
  document.documentElement.append(host);

  // ------------------------------------------------------------------- state
  let collapseTimer: number | undefined;
  let listOpen = false;
  let activeRow = -1;
  /** Cleared by unmount, so an in-flight async callback knows it is stale. */
  let live = true;

  const setState = (state: 'expanded' | 'collapsed'): void => {
    if (listOpen && state === 'collapsed') return;
    host.dataset.state = state;
  };

  const scheduleCollapse = (): void => {
    window.clearTimeout(collapseTimer);
    if (autoCollapseMs <= 0) return;
    collapseTimer = window.setTimeout(() => setState('collapsed'), autoCollapseMs);
  };

  const focusRow = (index: number): void => {
    if (rows.length === 0) return;
    activeRow = (index + rows.length) % rows.length;
    rows.forEach((row, i) => row.setAttribute('aria-selected', String(i === activeRow)));
    rows[activeRow]?.focus();
  };

  const openList = (): void => {
    listOpen = true;
    list.hidden = false;
    setState('expanded');
    window.clearTimeout(collapseTimer);
    pill.setAttribute('aria-expanded', 'true');
    focusRow(0);
  };

  function closeList(returnFocus = true): void {
    listOpen = false;
    list.hidden = true;
    activeRow = -1;
    for (const row of rows) {
      row.setAttribute('aria-selected', 'false');
      row.dispatchEvent(new CustomEvent('es-disarm'));
    }
    pill.setAttribute('aria-expanded', 'false');
    if (returnFocus) pill.focus();
    scheduleCollapse();
  }

  pill.addEventListener('click', () => (listOpen ? closeList() : openList()));
  pill.addEventListener('pointerenter', () => {
    window.clearTimeout(collapseTimer);
    setState('expanded');
  });
  pill.addEventListener('pointerleave', scheduleCollapse);
  pill.addEventListener('focus', () => {
    window.clearTimeout(collapseTimer);
    setState('expanded');
  });
  pill.addEventListener('blur', scheduleCollapse);

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && listOpen) {
      event.preventDefault();
      closeList();
      return;
    }
    if (!listOpen) {
      if (event.key === 'ArrowDown' && event.target === pill) {
        event.preventDefault();
        openList();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRow(activeRow + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(activeRow - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusRow(rows.length - 1);
    }
  });

  // Capture phase, so a click handler on the host page cannot stop this from
  // reaching us and leaving the list stuck open.
  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (listOpen && !event.composedPath().includes(host)) closeList(false);
  };
  document.addEventListener('pointerdown', onDocumentPointerDown, true);

  /**
   * Reconciles against the worker after a settings change.
   *
   * The frame and the tab icon are a per group tri-state over a global default, and this
   * context only ever receives the resolved answer. Whether flipping a global default
   * reaches THIS group is therefore not a question the content script can answer, so it
   * asks rather than guesses. Everything else applies in place above; only these two need
   * the pill rebuilt, and only when the answer actually changed. Rebuilding
   * unconditionally would throw away an open list and a focused row every time someone
   * nudged an unrelated setting, which is exactly when the options page is open in
   * another tab and someone is trying things out.
   */
  const reconcile = async (): Promise<void> => {
    const response = await send({ type: 'resolve', url: window.location.href });
    // This instance may have been torn down while the round trip was in flight, by a
    // second settings change or by a refresh push. Acting now would unmount whatever
    // replaced it and remount a stale snapshot in its place.
    if (!live) return;
    if (!response || response.type !== 'resolved') return;
    const next = response.tab;
    if (!next || next.hidden) {
      unmount?.();
      return;
    }
    if (next.frame !== tab.frame || next.tabIcon !== tab.tabIcon) {
      unmount?.();
      mount(next);
    }
  };

  const stopSettingsListener = onSettingsChanged((next) => {
    if (next.corner !== corner) {
      corner = next.corner;
      host.dataset.corner = corner;
      if (listOpen) closeList(false);
      setState('expanded');
    }
    if (next.paletteId !== paletteId) {
      paletteId = next.paletteId;
      paint();
    }
    if (next.indicatorSize !== indicatorSize) {
      indicatorSize = next.indicatorSize;
      host.dataset.size = indicatorSize;
    }
    if (next.frameWidth !== frameWidth) {
      frameWidth = next.frameWidth;
      applyEdge();
    }
    autoCollapseMs = next.autoCollapseMs;
    scheduleCollapse();
    void reconcile();
  });

  scheduleCollapse();

  openSwitcher = (): void => {
    if (!listOpen) openList();
  };

  unmount = (): void => {
    live = false;
    window.clearTimeout(collapseTimer);
    stopSettingsListener();
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    // Before removing the host, so a failure here cannot leave the page wearing our
    // favicon with nothing left to put it back.
    favicon?.restore();
    favicon = null;
    host.remove();
    unmount = null;
    openSwitcher = null;
  };
}

async function refresh(): Promise<void> {
  unmount?.();

  const response = await send({ type: 'resolve', url: window.location.href });
  if (!response || response.type !== 'resolved' || !response.tab) return;
  if (response.tab.hidden) return;

  mount(response.tab);
}

function init(): void {
  // Belt and braces: the manifest already restricts us to the top frame.
  if (window.top !== window) return;

  chrome.runtime.onMessage.addListener((push: Push) => {
    if (push.type === 'refresh') void refresh();
    if (push.type === 'hide') unmount?.();
    if (push.type === 'openSwitcher') {
      // The pill may be dismissed for this tab, or the page may have loaded before
      // the worker was awake. Re-resolve first, then open.
      if (openSwitcher) openSwitcher();
      else void refresh().then(() => openSwitcher?.());
    }
  });

  // A single page app can change route without reloading this script. The
  // environment cannot change under it (that would need a different origin, which
  // means a real navigation), but a route change can move the page out from under a
  // base path, so re-resolve on history navigation.
  window.addEventListener('popstate', () => void refresh());

  void refresh();
}

init();
