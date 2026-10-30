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
   * The add-buttons, which no longer carry a guessed URL.
   *
   * They used to: create-from-tab generated `staging.<apex>` and friends, and the button
   * showed the guess so taking it was one click. That came out, because those hostnames were
   * wrong far more often than right and a plausible wrong URL gets saved unread. The buttons
   * are now bare, and the URL is yours to paste.
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
    'every environment is offered bare, with no invented URL',
    ['local', 'dev', 'staging', 'preview', 'qa'].every((key) => offered[key] === ''),
    JSON.stringify(offered),
  );

  // Adding one gives an empty field to type into, not a guess to notice and correct.
  await options.click('.add-env [data-add-env="staging"]');
  await options.waitForSelector('.env-row[data-env="staging"]');
  check(
    'adding an environment gives an empty URL field',
    (await options.inputValue('.env-row[data-env="staging"] .url-input')) === '',
    await options.inputValue('.env-row[data-env="staging"] .url-input'),
  );

  // The one prefill that survived, and the only one that is a convention rather than a claim
  // about someone's infrastructure.
  await options.click('.add-env [data-add-env="local"]');
  await options.waitForSelector('.env-row[data-env="local"]');
  check(
    'a local row still arrives on a free loopback port',
    /^http:\/\/localhost:\d+$/.test(
      await options.inputValue('.env-row[data-env="local"] .url-input'),
    ),
    await options.inputValue('.env-row[data-env="local"] .url-input'),
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

  // ---- the hostname is no longer read for environment hints
  //
  // A staging subdomain used to be detected and the row labelled Staging. Detection went with
  // the URL guessing: the same label list that spotted `staging.` was also what generated
  // `staging.<apex>` for every other row. What is left is honest about it, saying which slot
  // the URL lands in before you click rather than quietly picking one.
  popup = await openPopup('https://staging.acme.example/', 'Acme');
  const stagingBlurb = (await popup.locator('.card').nth(1).textContent()) ?? '';
  check(
    'says which slot a staging URL lands in, rather than guessing the environment',
    stagingBlurb.includes('Production') && stagingBlurb.includes('https://staging.acme.example'),
    stagingBlurb.slice(0, 110),
  );
  await popup.close();

  // The label-stripping still happens, but only for NAMING: the group is called "Acme", not
  // "Staging". That is the half of the old guesser worth keeping.
  check(
    'still strips the environment label when naming the group',
    stagingBlurb.includes('Acme'),
    stagingBlurb.slice(0, 110),
  );

  popup = await openPopup('http://acme.test/', 'Acme');
  const valetBlurb = (await popup.locator('.card').nth(1).textContent()) ?? '';
  check(
    'fills in a .test host exactly as it is',
    valetBlurb.includes('http://acme.test'),
    valetBlurb.slice(0, 110),
  );
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
