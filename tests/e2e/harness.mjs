/**
 * Shared plumbing for the end to end suites.
 *
 * Four suites were each carrying their own copy of the launch options, the extension
 * id lookup, the permission stub and the pass/fail reporter. This is that, once.
 *
 * Playwright is deliberately NOT a saved dependency: a normal checkout should not have
 * to download a browser to run the unit tests. That means it can be absent, and the
 * default failure is an unreadable module resolution stack, so it is caught here and
 * explained instead.
 */

import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const EXT = resolve(here, '../..', 'dist');
export const SHOTS = resolve(here, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

/** The tag the indicator mounts as. */
export const HOST_TAG = 'whichenv-indicator';

/**
 * Chrome's permission prompt is a native modal Playwright cannot dismiss, so it is
 * stubbed to record the request and decline.
 *
 * Declining is also the more interesting path to assert: it must still save the group
 * and must surface the grant prompt on the card. The granting path is covered by the
 * unit suite.
 */
export const PERMISSION_STUB = `
  window.__esPermissionRequests = [];
  chrome.permissions.request = (query) => {
    window.__esPermissionRequests.push(query.origins ?? []);
    return Promise.resolve(false);
  };
`;

let chromium;

async function loadPlaywright() {
  if (chromium) return chromium;
  try {
    ({ chromium } = await import('playwright'));
    return chromium;
  } catch {
    console.error(
      [
        'FAIL  Playwright is not installed.',
        '',
        '  It is kept out of devDependencies so a normal checkout does not have to',
        '  download a browser. Install it just for these tests:',
        '',
        '    npm install --no-save playwright && npx playwright install chromium',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}

/** Launches Chromium with the built extension loaded. */
export async function launch({ width = 1100, height = 800 } = {}) {
  const browser = await loadPlaywright();
  return browser.launchPersistentContext(mkdtempSync(join(tmpdir(), 'es-e2e-')), {
    // Honour an explicit path when given, which keeps this working in sandboxes where
    // the bundled Chromium revision differs from what Playwright expects.
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width, height },
    // Needed to READ the clipboard back in a test. Writing needs no grant; without read
    // access there is no way to assert that a copy button copied the right thing.
    permissions: ['clipboard-read', 'clipboard-write'],
  });
}

/**
 * Finds the loaded extension's id.
 *
 * The service worker registers shortly after launch, so this polls rather than reading
 * once. Returning null here almost always means the worker threw on startup.
 */
export async function extensionId(context, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const worker of context.serviceWorkers()) {
      const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(worker.url());
      if (match) return match[1];
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    'Could not resolve the extension id. The service worker probably failed to start; ' +
      'load dist/ unpacked in Chrome to see the error.',
  );
}

/** Collects pass/fail results and reports them. */
export function checks() {
  const results = [];
  return {
    check(name, pass, detail = '') {
      results.push({ name, pass, detail });
      console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    },
    report() {
      const failed = results.filter((r) => !r.pass);
      console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
      console.log(`Screenshots: ${SHOTS}`);
      return failed.length === 0;
    },
  };
}

/** Records console errors from a page, ignoring the host page's own resource noise. */
export function watchErrors(page, sink, label = 'page') {
  page.on('pageerror', (error) => sink.push(`${label} pageerror: ${error.message}`));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && !/Failed to load resource|favicon/i.test(text)) {
      sink.push(text);
    }
  });
}

/**
 * Creates a group through the real editor UI.
 *
 * Every suite used to fill `#environments.N-baseUrl` by index, which assumed a new group
 * arrives with four rows in a known order. It arrives with production alone now, so the rows
 * are added here in the same way a person adds them, and the caller says which environments it
 * wants rather than which row numbers.
 *
 * Returns the group's id, which several suites need in order to talk to the worker directly.
 */
export async function createGroup(page, optionsUrl, title, urls) {
  await page.goto(optionsUrl);
  await page.waitForSelector('#groups-view');

  // The empty state has a create button; once a group exists it is the list's add button.
  const empty = page.locator('.empty-state .btn-primary');
  await ((await empty.count()) > 0 ? empty.click() : page.click('#groups-view .btn-primary'));

  await page.waitForSelector('#group-title');
  await page.fill('#group-title', title);

  const wanted = Object.keys(urls);

  // A new group arrives with production alone. Remove it first if this group does not want
  // one, rather than adding the others and cleaning up afterwards: rows are addressed by
  // environment, and deleting from a list while iterating it is how the first attempt at this
  // broke.
  if (!wanted.includes('prod')) {
    await page.click('.env-row[data-env="prod"] [data-action="remove"]');
    await page.waitForSelector('.env-row[data-env="prod"]', { state: 'detached' });
  }

  for (const [envKey, baseUrl] of Object.entries(urls)) {
    if (envKey !== 'prod') {
      await page.click(`.add-env [data-add-env="${envKey}"]`);
      await page.waitForSelector(`.env-row[data-env="${envKey}"]`);
    }
    await page.locator(`.env-row[data-env="${envKey}"] .url-input`).fill(baseUrl);
  }

  // Base URLs normalise on blur, and validation runs from there.
  await page.locator('#group-title').focus();
  await page.waitForTimeout(250);
  await page.click('.editor .btn-primary');
  await page.waitForSelector('.group-card');

  return page.evaluate(async (name) => {
    const stored = await chrome.storage.sync.get(null);
    const key = Object.keys(stored).find(
      (entry) => entry.startsWith('grp:') && stored[entry].title === name,
    );
    return key ? stored[key].id : null;
  }, title);
}

/**
 * Sets one of a group's page markers and saves.
 *
 * The frame and the tab icon are per group tri-states now, not per environment checkboxes,
 * so every suite that used to tick a box in one row goes through here instead. Centralised
 * because the shape of this control has now changed twice, and the last time it did, five
 * suites had to be edited by hand.
 */
export async function setGroupMarker(page, optionsUrl, groupId, key, value) {
  if (page.url() !== optionsUrl) await page.goto(optionsUrl);
  await page.waitForSelector('#groups-view');

  const card = groupId
    ? `.group-card[data-group-id="${groupId}"]`
    : '.group-card';
  await page.click(`${card} .btn-edit`);

  await page.waitForSelector(`[data-tristate="${key}"]`);
  await page.selectOption(`[data-tristate="${key}"]`, value);
  await page.click('.editor .btn-primary');
  await page.waitForSelector('.group-card');
}

export const shotPath = (name) => join(SHOTS, `${name.replace(/\.png$/, '')}.png`);
export const fixturePath = (name) => resolve(here, 'fixtures', name);
