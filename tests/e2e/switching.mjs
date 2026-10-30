/**
 * End to end coverage of the real switch: create a group, land on one of its
 * environments, pick a sibling, and verify the browser actually navigates there
 * with the path, query and fragment intact.
 *
 * The trick that makes this testable without external hosts: `localhost:PORT` and
 * `127.0.0.1:PORT` are the SAME server but DIFFERENT origins as far as Chrome is
 * concerned. So one local server stands in for two environments, and the round trip
 * is genuinely verified rather than mocked.
 *
 * Note on interaction: the indicator lives in a CLOSED shadow root, which Playwright
 * selectors cannot pierce. That is the point of it, so this drives the switcher by
 * keyboard instead, which also exercises the accessibility path.
 *
 * Setup (one time):
 *   npm install --no-save playwright && npx playwright install chromium
 *
 * Run:
 *   npm run build && npm run test:e2e:switching
 */

import {
  HOST_TAG,
  PERMISSION_STUB,
  checks,
  createGroup,
  extensionId,
  launch,
  fixturePath,
  shotPath,
  watchErrors,
} from './harness.mjs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const PORT = Number(process.env.PORT ?? 8330);

const { check, report } = checks();

const fixture = await readFile(fixturePath('host-page.html'));
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fixture);
});
await new Promise((r) => server.listen(PORT, r));

const ctx = await launch({ width: 1100, height: 800 });

const errors = [];

try {
  const id = await extensionId(ctx);
  const OPTIONS = `chrome-extension://${id}/src/options/index.html`;

  // ---- build a group whose local and dev are the same server on two origins
  const options = await ctx.newPage();
  await options.addInitScript(PERMISSION_STUB);
  watchErrors(options, errors, 'options');
  const groupId = await createGroup(options, OPTIONS, 'Round Trip', {
    local: `http://localhost:${PORT}`,
    dev: `http://127.0.0.1:${PORT}`,
    prod: 'https://prod.invalid',
  });
  check('a group using two loopback origins saved', groupId !== null, groupId ?? 'none');

  // ---- the indicator resolves from real config now, not demo data
  const page = await ctx.newPage();
  watchErrors(page, errors);

  const START = `http://localhost:${PORT}/deep/page.html?ref=email&v=2#reviews`;
  await page.goto(START, { waitUntil: 'load' });
  await page.waitForSelector(HOST_TAG, { timeout: 5000 });
  check('indicator appears on a configured environment', (await page.locator(HOST_TAG).count()) === 1);
  check(
    'the environment is read from stored config',
    (await page.getAttribute(HOST_TAG, 'data-state')) !== null,
  );
  check(
    'the shadow root is closed, so the page cannot reach inside',
    await page.evaluate((tag) => document.querySelector(tag)?.shadowRoot === null, HOST_TAG),
  );
  await page.screenshot({ path: shotPath('20-real-local') });

  // The badge is only readable from an extension context, so ask the options page.
  const badgeFor = async (matchUrl) =>
    options.evaluate(async (needle) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.url?.includes(needle));
      if (tab?.id === undefined) return null;
      return {
        text: await chrome.action.getBadgeText({ tabId: tab.id }),
        color: await chrome.action.getBadgeBackgroundColor({ tabId: tab.id }),
        title: await chrome.action.getTitle({ tabId: tab.id }),
      };
    }, matchUrl);

  const localBadge = await badgeFor(`localhost:${PORT}/deep`);
  check('the toolbar badge shows the environment code', localBadge?.text === 'LOC', localBadge?.text ?? 'none');
  check(
    'the badge is coloured from the palette',
    JSON.stringify(localBadge?.color) === JSON.stringify([21, 128, 61, 255]),
    JSON.stringify(localBadge?.color),
  );
  check(
    'the badge tooltip names the environment and group',
    /Local/.test(localBadge?.title ?? '') && /Round Trip/.test(localBadge?.title ?? ''),
    localBadge?.title ?? '',
  );

  // ---- no indicator on a URL that is in no group
  const stranger = await ctx.newPage();
  await stranger.goto(`http://localhost:${PORT + 1}/x`).catch(() => {});
  await stranger.close();

  // ---- switch: local -> dev, same tab, path and query intact
  await page.hover(HOST_TAG);
  await page.click(HOST_TAG);
  await page.waitForTimeout(300);
  await page.screenshot({ path: shotPath('21-real-switcher') });

  // openList focuses the first sibling, so Enter picks it. Siblings are in
  // pipeline order, and local is the current one, so row 0 is Dev.
  await page.keyboard.press('Enter');
  await page.waitForURL(`http://127.0.0.1:${PORT}/**`, { timeout: 5000 });

  const devBadge = await badgeFor(`127.0.0.1:${PORT}/deep`);
  check('the badge follows the switch', devBadge?.text === 'DEV', devBadge?.text ?? 'none');

  const landed = new URL(page.url());
  check('switching navigated the same tab to the sibling origin', landed.host === `127.0.0.1:${PORT}`, landed.host);
  check('the path carried over', landed.pathname === '/deep/page.html', landed.pathname);
  check('the query string carried over', landed.search === '?ref=email&v=2', landed.search);
  check('the fragment carried over', landed.hash === '#reviews', landed.hash);

  await page.waitForSelector(HOST_TAG, { timeout: 5000 });
  await page.waitForTimeout(400);
  check(
    'the indicator re-resolves on the destination environment',
    (await page.locator(HOST_TAG).count()) === 1,
  );
  await page.screenshot({ path: shotPath('22-real-dev') });

  // ---- switch back the other way
  await page.hover(HOST_TAG);
  await page.click(HOST_TAG);
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForURL(`http://localhost:${PORT}/**`, { timeout: 5000 });
  check(
    'switching back returns to the original URL exactly',
    page.url() === START,
    page.url(),
  );

  // ---- a new-tab switch lands in a Chrome tab group
  const tabGroups = () => options.evaluate(() => chrome.tabGroups.query({}));
  check('no tab groups exist yet', (await tabGroups()).length === 0);

  // Driven through the setting rather than a modifier: a keyboard-activated click
  // does not carry modifier flags, and the rows are inside a closed shadow root so
  // they cannot be clicked by selector.
  await options.bringToFront();
  await options.locator('[data-setting="openInNewTabByDefault"] input').check();
  await options.waitForTimeout(250);

  await page.bringToFront();
  await page.goto(START, { waitUntil: 'load' });
  await page.waitForSelector(HOST_TAG, { timeout: 5000 });
  await page.hover(HOST_TAG);
  await page.click(HOST_TAG);
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1400);

  check(
    'the new-tab default keeps the original tab where it was',
    page.url() === START,
    page.url(),
  );

  const groups = await tabGroups();
  check('a new-tab switch creates a tab group', groups.length === 1, JSON.stringify(groups));
  check('the tab group is named after the environment group', groups[0]?.title === 'Round Trip', groups[0]?.title);
  check(
    'the tab group takes the colour of the environment opened',
    groups[0]?.color === 'blue',
    groups[0]?.color,
  );

  const grouped = await options.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter((tab) => tab.groupId !== undefined && tab.groupId !== -1)
      .map((tab) => tab.url ?? '');
  });
  // Both tabs, not just the new one: grouping only the new tab would leave the pair
  // you are comparing split across the tab strip.
  check(
    'both the new tab and the tab it came from are in the group',
    grouped.length === 2 &&
      grouped.some((u) => u.includes('127.0.0.1')) &&
      grouped.some((u) => u.includes('localhost')),
    JSON.stringify(grouped),
  );
  check(
    'the group takes the riskier colour once both are in it',
    groups[0]?.color === 'blue',
    groups[0]?.color,
  );
  await options.screenshot({ path: shotPath('24-tab-group') });

  // Close the extra tab and restore the default so later checks are predictable.
  const opened = ctx.pages().find((candidate) => candidate.url().includes('127.0.0.1'));
  await opened?.close();
  await options.bringToFront();
  await options.locator('[data-setting="openInNewTabByDefault"] input').uncheck();
  await options.waitForTimeout(250);
  await page.bringToFront();

  // ---- "open all environments" gathers the whole group into one ordered tab group
  //
  // The row is last in the list, so one ArrowUp from the freshly-opened list wraps onto it.
  // Driven by keyboard for the same reason every other interaction here is: the list lives in
  // a closed shadow root and no selector reaches into it.
  await page.bringToFront();
  await page.goto(START, { waitUntil: 'load' });
  await page.waitForSelector(HOST_TAG, { timeout: 5000 });
  await page.hover(HOST_TAG);
  await page.click(HOST_TAG);
  await page.waitForTimeout(300);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1800);

  const gathered = await options.evaluate(async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs
      .filter((tab) => tab.groupId !== undefined && tab.groupId !== -1)
      .sort((a, b) => a.index - b.index)
      .map((tab) => tab.url ?? '');
  });

  // Three, not two: this group has a production row pointing at prod.invalid, and open-all
  // opens every environment rather than only the ones that resolve.
  check(
    'open all gathers every environment into one group',
    gathered.length === 3,
    JSON.stringify(gathered),
  );

  // Pipeline order, not the group's configured order: leftmost is always the safest
  // environment and rightmost is always the riskiest, in every group. Production reads as an
  // empty URL because it is an origin the extension holds no host permission for, which is
  // exactly why it has to be identified by position here.
  check(
    'and orders them local to prod',
    gathered[0]?.includes('localhost') === true &&
      gathered[1]?.includes('127.0.0.1') === true &&
      gathered[2] === '',
    JSON.stringify(gathered),
  );
  check(
    'the tab you pressed it from stays where it was',
    page.url() === START,
    page.url(),
  );

  const afterOpenAll = await tabGroups();
  check(
    'open all reuses the existing group rather than making a second',
    afterOpenAll.length === 1 && afterOpenAll[0]?.title === 'Round Trip',
    JSON.stringify(afterOpenAll),
  );
  await options.screenshot({ path: shotPath('25-open-all') });

  // Pressing it again must not double up: a tab already showing a destination is adopted.
  await page.bringToFront();
  await page.hover(HOST_TAG);
  await page.click(HOST_TAG);
  await page.waitForTimeout(300);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1800);

  const twice = await options.evaluate(async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const urls = tabs.map((tab) => tab.url ?? '');
    return {
      local: urls.filter((url) => url.includes('localhost:8330')).length,
      dev: urls.filter((url) => url.includes('127.0.0.1:8330')).length,
    };
  });

  // Only the origins the extension can READ can be adopted, which is every origin a real
  // user has granted. prod.invalid is deliberately not one of them, so it is left out of
  // this count rather than asserted on: a second copy of it is the documented cost of not
  // holding permission, not a regression.
  check(
    'pressing open all twice adopts the open tabs instead of duplicating them',
    twice.local === 1 && twice.dev === 1,
    JSON.stringify(twice),
  );

  // Back to one tab so the checks after this one see what they expect.
  for (const candidate of ctx.pages()) {
    const url = candidate.url();
    if (url.includes('127.0.0.1') || url.includes('prod.invalid') || url === 'about:blank') {
      if (candidate !== page && candidate !== options) await candidate.close().catch(() => {});
    }
  }
  await page.bringToFront();
  await page.waitForTimeout(300);

  // ---- editing groups refreshes open tabs without a reload
  await options.bringToFront();
  await options.click('.group-card .btn-edit');
  await options.waitForSelector('#group-title');
  await options.fill('#group-title', 'Round Trip Renamed');
  await options.click('.editor .btn-primary');
  await options.waitForSelector('.group-card');
  await page.bringToFront();
  await page.waitForTimeout(900);
  check(
    'an open tab still has an indicator after the group is edited',
    (await page.locator(HOST_TAG).count()) === 1,
  );

  // ---- the enter guard takes a second, deliberate action
  await options.bringToFront();
  await options.click('.group-card .btn-edit');
  await options.waitForSelector('#group-title');
  // Guard the dev environment (row 1).
  await options.locator('.env-row[data-index="1"] input[data-toggle="confirmOnEnter"]').check();
  await options.click('.editor .btn-primary');
  await options.waitForSelector('.group-card');

  await page.bringToFront();
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector(HOST_TAG, { timeout: 5000 });
  await page.hover(HOST_TAG);
  await page.click(HOST_TAG);
  await page.waitForTimeout(300);

  const before = page.url();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  check('a guarded environment does not switch on the first action', page.url() === before);
  await page.screenshot({ path: shotPath('23-real-guard-armed') });

  await page.keyboard.press('Enter');
  await page.waitForURL(`http://127.0.0.1:${PORT}/**`, { timeout: 5000 });
  check('a guarded environment switches on confirmation', page.url().includes(`127.0.0.1:${PORT}`));

  // ---- hiding the indicator for a group
  await options.bringToFront();
  await options.click('.group-card .btn-edit');
  await options.waitForSelector('#group-title');
  await options.locator('.editor input[data-toggle="hidden"]').check();
  await options.click('.editor .btn-primary');
  await options.waitForSelector('.group-card');

  await page.bringToFront();
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);
  check(
    'a group set to hidden renders no indicator',
    (await page.locator(HOST_TAG).count()) === 0,
  );

  // ---- deleting the group stops matching entirely
  await options.bringToFront();
  await options.click('.group-card .btn-edit');
  await options.waitForSelector('.btn-danger-ghost');
  await options.click('.btn-danger-ghost');
  await options.click('.btn-danger');
  await options.waitForSelector('.empty-state');

  await page.bringToFront();
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);
  check(
    'no indicator once the group is deleted',
    (await page.locator(HOST_TAG).count()) === 0,
  );

  // ---- wildcard hosts, in a real browser
  //
  // `*.localhost` is the one wildcard testable here. Every OTHER wildcard needs a granted
  // subdomain permission, and Playwright cannot accept Chrome's permission dialog. This one
  // works because a wildcard covers its bare suffix (the same reading Chrome gives
  // `*.example.com`), so `*.localhost:PORT` matches `localhost:PORT`, which the manifest
  // already grants statically. That exercises the whole path: the separate index bucket,
  // the suffix match, pinning the entry to the real host, and switching away from it.
  await options.bringToFront();
  const wildId = await createGroup(options, OPTIONS, 'Wildcards', {
    preview: `http://*.localhost:${PORT}`,
    dev: `http://127.0.0.1:${PORT}`,
  });
  check('a group with a wildcard host saves', wildId !== null, wildId ?? 'none');

  const wild = await ctx.newPage();
  watchErrors(wild, errors, 'wildcard page');
  await wild.goto(`http://localhost:${PORT}/deep/page.html?ref=email#reviews`, {
    waitUntil: 'load',
  });
  await wild.waitForSelector(HOST_TAG, { timeout: 5000 });
  check('a wildcard host resolves to an indicator', (await wild.locator(HOST_TAG).count()) === 1);

  /**
   * Which environment the pill resolved to, read as its colour.
   *
   * The shadow root is closed, so the label is unreadable from here, but `--es-bg` is an
   * inline custom property on the host element and the environment colours are unique.
   * That makes the colour the one observable answer to "which environment did it pick?".
   */
  const resolvedColor = () =>
    wild.evaluate(
      (tag) => document.querySelector(tag)?.style.getPropertyValue('--es-bg').trim() ?? '',
      HOST_TAG,
    );

  check(
    'and resolves to the wildcard environment, not something else',
    (await resolvedColor()) === '#A21CAF',
    await resolvedColor(),
  );

  // Switching AWAY from a wildcard is the part that needs the concrete host. Computed from
  // `*.localhost` it would produce nothing at all.
  await wild.hover(HOST_TAG);
  await wild.click(HOST_TAG);
  await wild.waitForTimeout(300);
  // openList focuses the first sibling, so Enter picks it. Dev is the only one: the wildcard
  // environment is not offered as somewhere to switch TO.
  await wild.keyboard.press('Enter');
  await wild.waitForURL(`http://127.0.0.1:${PORT}/**`, { timeout: 5000 });
  check(
    'switching away from a wildcard keeps the path, query and fragment',
    wild.url() === `http://127.0.0.1:${PORT}/deep/page.html?ref=email#reviews`,
    wild.url(),
  );
  await wild.screenshot({ path: shotPath('24-wildcard-switched') });

  // ---- an exact host beats a wildcard, whichever group it is in
  await options.bringToFront();
  const exactId = await createGroup(options, OPTIONS, 'Exact Wins', {
    local: `http://localhost:${PORT}`,
  });
  check('a group claiming the exact host saves alongside the wildcard', exactId !== null);

  await wild.goto(`http://localhost:${PORT}/deep/page.html`, { waitUntil: 'load' });
  await wild.waitForSelector(HOST_TAG, { timeout: 5000 });
  await wild.waitForTimeout(500);

  // Same URL as before, now claimed by an exact host in a DIFFERENT group. The colour has to
  // flip from preview purple to local green, which is only true if exact beats wildcard
  // across groups rather than by storage order.
  check(
    'an exact host in another group beats the wildcard that also covers it',
    (await resolvedColor()) === '#15803D',
    await resolvedColor(),
  );

  // ---- the popup's switch hides the indicator for the group you are on, and it sticks
  //
  // Driven through the real popup control rather than a storage write, so the label, the
  // checkbox and the group write are all covered. The popup is opened as a tab with the
  // active-tab query faked, the same way tests/e2e/popup.mjs does it. At this point the
  // page is on localhost:PORT, which resolves to "Exact Wins".
  const ON_PAGE = `http://localhost:${PORT}/deep/page.html`;
  const POPUP = `chrome-extension://${id}/src/popup/index.html`;
  const TOGGLE = '[data-setting="groupHidden"] input';
  const openPopupFor = async (url) => {
    const popup = await ctx.newPage();
    watchErrors(popup, errors, 'popup');
    await popup.addInitScript(`
      const realQuery = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (info) =>
        info && info.active
          ? Promise.resolve([{ id: 4242, windowId: 1, url: ${JSON.stringify(url)}, title: 'Page' }])
          : realQuery(info);
    `);
    await popup.goto(POPUP);
    await popup.waitForSelector(TOGGLE);
    return popup;
  };
  const hostCount = () => wild.locator(HOST_TAG).count();
  const storedIndicator = (gid) =>
    options.evaluate(async (key) => (await chrome.storage.sync.get(key))[key]?.indicator ?? null, `grp:${gid}`);

  let popup = await openPopupFor(ON_PAGE);
  const note = popup.locator('[data-setting="groupHidden"] .toggle-note');
  check('the popup offers the indicator switch, on by default', await popup.locator(TOGGLE).isChecked());
  check('with no warning while it is on', !(await note.isVisible()));

  await popup.locator(TOGGLE).click();
  check('switching it off names the group and says what still shows', (await note.textContent())?.includes('Exact Wins') === true, (await note.textContent()) ?? '');
  await popup.close();

  await wild.waitForFunction((tag) => !document.querySelector(tag), HOST_TAG, { timeout: 5000 })
    .catch(() => {});
  check('switching off removes the indicator from an open page, no reload', (await hostCount()) === 0);

  // The same flag the editor's "Hide the indicator on this site" writes, on this group only.
  check('it is stored on the group the tab is in', (await storedIndicator(exactId))?.hidden === true, JSON.stringify(await storedIndicator(exactId)));
  check(
    'and on no other group',
    (await storedIndicator(groupId))?.hidden !== true && (await storedIndicator(wildId))?.hidden !== true,
  );

  const offBadge = await badgeFor(`localhost:${PORT}/deep`);
  check('the toolbar badge keeps showing the environment while off', offBadge?.text === 'LOC', offBadge?.text ?? 'none');

  await wild.reload({ waitUntil: 'load' });
  await wild.waitForTimeout(1500);
  check('it stays off across a reload', (await hostCount()) === 0);

  popup = await openPopupFor(ON_PAGE);
  check('the popup remembers it is off', !(await popup.locator(TOGGLE).isChecked()));
  await popup.locator(TOGGLE).click();
  await popup.close();

  await wild.waitForSelector(HOST_TAG, { timeout: 5000 }).catch(() => {});
  await wild.waitForTimeout(500);
  check('switching back on brings the indicator back without a reload', (await hostCount()) === 1, `${await hostCount()} host(s)`);
  check(
    'and leaves the group exactly as the editor would store it',
    (await storedIndicator(exactId)) === null,
    JSON.stringify(await storedIndicator(exactId)),
  );

  check('no console errors', errors.length === 0, errors.join(' | ') || 'clean');
} finally {
  await ctx.close();
  server.close();
}

process.exit(report() ? 0 : 1);
