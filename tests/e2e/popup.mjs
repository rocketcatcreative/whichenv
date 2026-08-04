/**
 * End to end coverage of the popup, including "create a group from this tab".
 *
 * The real popup cannot be opened programmatically, and opening its HTML in a normal
 * tab would make the popup itself the active tab. So `chrome.tabs.query` is stubbed to
 * report the tab we want to pretend is active. Everything downstream of that is real:
 * the guessing, the draft handoff through storage.session, and the options page
 * opening with the editor prefilled.
 *
 * This suite exists because the create-from-tab entry point shipped broken: the popup
 * could not read the URL of a site with no host permission, which is exactly the site
 * you want to set up. Nothing was testing the popup at all.
 *
 * Setup (one time):
 *   npm install --no-save playwright && npx playwright install chromium
 *
 * Run:
 *   npm run build && npm run test:e2e:popup
 */

import {
  checks,
  extensionId,
  launch,
  shotPath,
  watchErrors,
} from './harness.mjs';
import { join } from 'node:path';

const { check, report } = checks();

/** Makes chrome.tabs.query report a chosen tab as the active one. */
const fakeActiveTab = (url, title) => `
  const realQuery = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = (info) => {
    if (info && info.active) {
      return Promise.resolve([{ id: 4242, windowId: 1, url: ${JSON.stringify(url)}, title: ${JSON.stringify(title)} }]);
    }
    return realQuery(info);
  };
`;

const ctx = await launch({ width: 420, height: 700 });

const errors = [];

try {
  const id = await extensionId(ctx);
  const POPUP = `chrome-extension://${id}/src/popup/index.html`;
  const OPTIONS = `chrome-extension://${id}/src/options/index.html`;

  /** Opens the popup pretending a given tab is active. */
  async function openPopup(url, title) {
    const page = await ctx.newPage();
    watchErrors(page, errors, 'popup');
    await page.addInitScript(fakeActiveTab(url, title));
    await page.goto(POPUP);
    await page.waitForSelector('#app .card, #app h1');
    await page.waitForTimeout(300);
    return page;
  }

  // ---- an unmatched http site offers to set itself up
  let popup = await openPopup('https://shop.example.com/products/42', 'Product 42 | Shop Example');
  check(
    'reports that the tab is in no group',
    (await popup.locator('.card-label').first().textContent()) === 'No match',
  );
  const createButton = popup.locator('button.primary');
  check('offers to create a group from this tab', await createButton.isVisible());
  const blurb = (await popup.locator('.card').nth(1).textContent()) ?? '';
  check(
    'names the environment it thinks the tab is',
    blurb.includes('Production'),
    blurb.slice(0, 80),
  );
  check(
    'names the group it would create, taken from the page title',
    blurb.includes('Shop Example'),
    blurb.slice(0, 90),
  );
  await popup.screenshot({ path: shotPath('30-popup-create') });

  // ---- the handoff: clicking through opens the editor prefilled
  //
  // The extension opens the options page itself, and that page consumes the stashed
  // draft. Opening a second one here would find nothing, so wait for Chrome's.
  const optionsOpened = ctx.waitForEvent('page', {
    predicate: (candidate) => candidate.url().startsWith(OPTIONS),
    timeout: 10_000,
  });

  await createButton.click();
  // The popup closes itself once the draft is stashed, exactly as a real popup would,
  // so nothing may be awaited on that page from here on.

  const options = await optionsOpened;
  await options.waitForSelector('#groups-view');
  await options.waitForTimeout(600);

  check('the options page opens straight into the editor', await options.locator('.editor').isVisible());
  check(
    'the title is prefilled from the page title',
    (await options.inputValue('#group-title')) === 'Shop Example',
    await options.inputValue('#group-title'),
  );

  const rows = await options.locator('.env-row').evaluateAll((els) =>
    els.map((row) => ({
      env: row.getAttribute('data-env'),
      url: row.querySelector('.url-input')?.value ?? '',
    })),
  );
  const byEnv = Object.fromEntries(rows.map((row) => [row.env, row]));

  check(
    'the tab’s own environment is filled in exactly, and is the only active row',
    byEnv.prod?.url === 'https://shop.example.com' && rows.length === 1,
    JSON.stringify(rows),
  );

  /**
   * The guessed siblings, now offered as add-buttons carrying their guessed URL.
   *
   * They used to be prefilled rows left switched off, because a guessed hostname that does not
   * exist would otherwise be a switch target that goes nowhere. Removing the on/off checkbox
   * left nowhere to render a switched-off row, so the guess moved onto the button instead. The
   * property that mattered is unchanged: the guess is visible, and taking it is deliberate.
   */
  const offered = Object.fromEntries(
    await options.locator('.add-env .btn').evaluateAll((els) =>
      els.map((button) => [
        button.dataset.addEnv,
        button.querySelector('.add-kept')?.textContent ?? '',
      ]),
    ),
  );

  check(
    'siblings are guessed from the apex and offered with their URLs',
    offered.staging === 'https://staging.shop.example.com' &&
      offered.dev === 'https://dev.shop.example.com',
    JSON.stringify([offered.staging, offered.dev]),
  );
  check(
    'a local row is offered with a free port',
    /^http:\/\/localhost:\d+$/.test(offered.local ?? ''),
    offered.local,
  );
  check(
    'and a slot with nothing to guess is offered bare',
    offered.qa === '' && offered.preview === '',
    JSON.stringify([offered.preview, offered.qa]),
  );

  // Taking one is a single click, and it arrives with the guess already filled in.
  await options.click('.add-env [data-add-env="staging"]');
  await options.waitForSelector('.env-row[data-env="staging"]');
  check(
    'accepting a guess fills the row in for you',
    (await options.inputValue('.env-row[data-env="staging"] .url-input')) ===
      'https://staging.shop.example.com',
  );

  await options
    .locator('.env-section:not(.markers-section)')
    .screenshot({ path: shotPath('31-prefilled-editor') });

  // The stash is cleared on read, so reloading must not reopen a dismissed editor.
  await options.reload();
  await options.waitForSelector('#groups-view');
  await options.waitForTimeout(400);
  check(
    'reloading the options page does not reopen the prefilled editor',
    (await options.locator('.editor').count()) === 0,
  );
  await options.close();

  // ---- a staging URL is recognised as staging
  popup = await openPopup('https://staging.acme.example/', 'Acme');
  const stagingBlurb = (await popup.locator('.card').nth(1).textContent()) ?? '';
  check('recognises a staging subdomain', stagingBlurb.includes('Staging'), stagingBlurb.slice(0, 60));
  await popup.close();

  // Laravel Valet and friends serve `.test` hostnames, so that suffix is deliberately
  // read as local development rather than as a public site.
  popup = await openPopup('http://acme.test/', 'Acme');
  const valetBlurb = (await popup.locator('.card').nth(1).textContent()) ?? '';
  check('reads a .test host as local', valetBlurb.includes('Local'), valetBlurb.slice(0, 60));
  await popup.close();

  // ---- a non-http page is ignored, and says why
  popup = await openPopup('chrome://settings/', 'Settings');
  const ignored = (await popup.locator('#app').textContent()) ?? '';
  check(
    'a non-http page is ignored with an explanation',
    ignored.includes('not an http or https URL'),
    ignored.slice(0, 80),
  );
  check('and offers no create button there', (await popup.locator('button.primary').count()) === 0);
  await popup.close();

  // ---- an unreadable tab is reported as a permissions problem, not a page problem
  popup = await openPopup('', undefined);
  const unreadable = (await popup.locator('#app').textContent()) ?? '';
  check(
    'an unreadable tab blames the extension, not the page',
    unreadable.includes('Could not read this tab'),
    unreadable.slice(0, 80),
  );
  await popup.close();

  check('no console errors', errors.length === 0, errors.join(' | ') || 'clean');
} finally {
  await ctx.close();
}

process.exit(report() ? 0 : 1);
