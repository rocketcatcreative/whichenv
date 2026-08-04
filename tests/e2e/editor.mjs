/**
 * End to end coverage of the group editor.
 *
 * Runs against the real options page in a real Chromium with the extension
 * loaded, so chrome.storage.sync, the validation wiring and the DOM rendering are
 * all exercised together. The unit suite covers the rules; this covers the wiring.
 *
 * Setup (one time):
 *   npm install --no-save playwright && npx playwright install chromium
 *
 * Run:
 *   npm run build && npm run test:e2e:editor
 */

import {
  PERMISSION_STUB,
  checks,
  extensionId,
  launch,
  shotPath,
  watchErrors,
} from './harness.mjs';
import { join } from 'node:path';

const { check, report } = checks();

const ctx = await launch({ width: 1100, height: 900 });

const errors = [];

try {
  const id = await extensionId(ctx);

  const page = await ctx.newPage();
  await page.addInitScript(PERMISSION_STUB);
  watchErrors(page, errors);

  const OPTIONS = `chrome-extension://${id}/src/options/index.html`;
  /** The URL field for one environment, by name rather than by position. */
  const url = (envKey) => `.env-row[data-env="${envKey}"] .url-input`;
  /** Adds an environment the way a person does, then waits for its row. */
  const addEnv = async (envKey) => {
    await page.click(`.add-env [data-add-env="${envKey}"]`);
    await page.waitForSelector(`.env-row[data-env="${envKey}"]`);
  };

  await page.goto(OPTIONS);
  await page.waitForSelector('#groups-view');

  // ---- empty state
  check('shows an empty state with no groups', await page.locator('.empty-state').isVisible());
  await page.screenshot({ path: shotPath('10-groups-empty'), fullPage: true });

  // ---- open the editor
  await page.click('.empty-state .btn-primary');
  await page.waitForSelector('#group-title');
  check('opens the editor', await page.locator('.editor').isVisible());

  // The main visible change of this pass, worth a look rather than only an assertion.
  await page.locator('.env-section:not(.markers-section)').screenshot({
    path: shotPath('10b-editor-new-group'),
  });
  await page.locator('.markers-section').screenshot({ path: shotPath('10c-editor-markers') });

  check('starts with production alone', (await page.locator('.env-row').count()) === 1);
  check(
    'and that one row is production',
    (await page.locator('.env-row').first().getAttribute('data-env')) === 'prod',
  );
  check(
    'offers every other environment as something to add',
    (await page.locator('.add-env .btn').count()) === 5,
  );

  await addEnv('local');
  await addEnv('dev');
  await addEnv('staging');

  // Added in pipeline order rather than appended, so a group built this way reads local to
  // production. Appending would have left it reading production, local, dev, staging.
  check(
    'added environments land in pipeline order, not after production',
    (await page.locator('.env-row').evaluateAll((rows) => rows.map((row) => row.dataset.env)))
      .join(',') === 'local,dev,staging,prod',
  );

  // Local gets a port suggestion so the uniqueness rule never turns into an
  // error you have to go and fix by hand.
  const localPrefill = await page.inputValue(url('local'));
  check('prefills local with a suggested port', /^http:\/\/localhost:\d+$/.test(localPrefill), localPrefill);
  check(
    'and focuses the field it just added, since a URL always follows',
    await page.locator(url('staging')).evaluate((node) => node === document.activeElement),
  );

  // ---- save is blocked until the title exists
  check('save is disabled with no title', await page.locator('.editor .btn-primary').isDisabled());

  await page.fill('#group-title', 'Acme Storefront');
  await page.fill('#group-description', 'The main public storefront.');
  await page.fill(url('dev'), 'https://dev.acme.example');
  await page.fill(url('staging'), 'https://staging.acme.example');
  await page.fill(url('prod'), 'acme.example');

  // ---- normalization is visible, not silent
  await page.locator(url('prod')).blur();
  await page.waitForTimeout(150);
  check(
    'normalizes a scheme-less URL in place so you see what is stored',
    (await page.inputValue(url('prod'))) === 'https://acme.example',
  );

  check('save is enabled once the group is valid', await page.locator('.editor .btn-primary').isEnabled());
  check(
    'confirms a free local port',
    (await page.locator('.issue-ok').count()) >= 1,
  );
  await page.screenshot({ path: shotPath('11-editor-filled'), fullPage: true });

  // ---- the URL field takes the slack in the row
  //
  // Geometry rather than CSS text, because the bug this guards against was invisible in the
  // rule itself: the column widths were right, they were just applied to the wrong children
  // after a child was removed. The URL ended up in the 116px column meant for the label,
  // truncating every real hostname, while the reorder buttons silently absorbed the 1fr.
  const rowGeometry = await page.evaluate(() => {
    const row = document.querySelector('.env-row[data-env="staging"] .env-row-main');
    const width = (selector) =>
      Math.round(row.querySelector(selector).getBoundingClientRect().width);
    return {
      row: Math.round(row.getBoundingClientRect().width),
      label: width('.label-input'),
      url: width('.url-input'),
      urlRight: Math.round(row.querySelector('.url-input').getBoundingClientRect().right),
      removeLeft: Math.round(
        row.querySelector('[data-action="remove"]').getBoundingClientRect().left,
      ),
    };
  });

  check(
    'the URL field takes most of the row, rather than a fixed narrow column',
    rowGeometry.url / rowGeometry.row > 0.5,
    `${rowGeometry.url}px of ${rowGeometry.row}px`,
  );
  check(
    'and is wider than the label field beside it',
    rowGeometry.url > rowGeometry.label * 2,
    `url ${rowGeometry.url} vs label ${rowGeometry.label}`,
  );
  // If a later column takes the 1fr instead, this gap opens up to a hundred pixels or more.
  check(
    'with no dead space between it and the remove button',
    rowGeometry.removeLeft - rowGeometry.urlRight < 60,
    `${rowGeometry.removeLeft - rowGeometry.urlRight}px of slack`,
  );

  // Narrow: the URL drops to its own line and spans the full width.
  await page.setViewportSize({ width: 640, height: 900 });
  await page.waitForTimeout(250);
  const narrow = await page.evaluate(() => {
    const row = document.querySelector('.env-row[data-env="staging"] .env-row-main');
    const rowBox = row.getBoundingClientRect();
    const urlBox = row.querySelector('.url-input').getBoundingClientRect();
    const labelBox = row.querySelector('.label-input').getBoundingClientRect();
    return {
      spans: Math.round(urlBox.width) >= Math.round(rowBox.width) - 2,
      belowLabel: urlBox.top > labelBox.bottom - 2,
    };
  });
  check('narrow, the URL spans the full row width', narrow.spans);
  check('and sits on its own line below the label', narrow.belowLabel);
  await page.screenshot({ path: shotPath('11b-editor-narrow'), fullPage: true });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(250);

  // ---- an in-group duplicate blocks saving
  await page.fill(url('staging'), 'https://acme.example');
  await page.waitForTimeout(150);
  check(
    'blocks two environments in one group sharing a URL',
    (await page.locator('.issue-error').count()) >= 1 &&
      (await page.locator('.editor .btn-primary').isDisabled()),
  );
  await page.fill(url('staging'), 'https://staging.acme.example');
  await page.waitForTimeout(150);

  // ---- bare localhost warns but does not block
  await page.fill(url('local'), 'http://localhost');
  await page.waitForTimeout(150);
  const warned = await page.locator('.issue-warning').first().textContent();
  check(
    'warns about a loopback URL with no port, without blocking',
    /port 80/.test(warned ?? '') && (await page.locator('.editor .btn-primary').isEnabled()),
    (warned ?? '').slice(0, 60),
  );
  await page.screenshot({ path: shotPath('12-editor-port-warning'), fullPage: true });

  await page.fill(url('local'), 'http://localhost:3000');
  await page.locator(url('local')).blur();
  await page.waitForTimeout(200);

  // ---- loopback alias offer
  const aliasOffer = page.locator('.aliases .btn-ghost').first();
  check('offers the 127.0.0.1 counterpart as an alias', await aliasOffer.isVisible());
  await aliasOffer.click();
  await page.waitForTimeout(200);
  check(
    'adds the alias when offered',
    (await page.locator('.alias-input').count()) === 1,
  );

  // ---- save
  await page.click('.editor .btn-primary');
  await page.waitForSelector('.group-card');
  check('returns to the list after saving', (await page.locator('.group-card').count()) === 1);
  check(
    'card shows the group title',
    (await page.locator('.group-card-title').textContent()) === 'Acme Storefront',
  );
  check(
    'card shows a chip per enabled environment',
    (await page.locator('.group-chip').count()) === 4,
  );
  check('lists the claimed local port', await page.locator('.port-registry').isVisible());

  // Remote origins need host access before the indicator can render on them, and
  // the prompt lives on the card rather than blocking the editor.
  check(
    'prompts to grant access for the remote origins',
    await page.locator('.access-prompt').isVisible(),
  );
  const promptText = (await page.locator('.access-note').textContent()) ?? '';
  check(
    'the prompt names the hosts it needs and only the remote ones',
    promptText.includes('acme.example') && !promptText.includes('localhost'),
    promptText.slice(0, 90),
  );

  // Saving asks for access, and declining must not lose the group.
  const asked = await page.evaluate(() => window.__esPermissionRequests ?? []);
  check(
    'saving requests exactly the remote origins',
    JSON.stringify(asked) ===
      JSON.stringify([[
        'https://acme.example/*',
        'https://dev.acme.example/*',
        'https://staging.acme.example/*',
      ]]),
    JSON.stringify(asked),
  );
  check(
    'declining the permission prompt still saves the group',
    (await page.locator('.group-card').count()) === 1,
  );

  // The shortcuts panel exists so the unbound numeric jumps are discoverable.
  check(
    'lists every keyboard command',
    (await page.locator('#shortcuts .shortcut-table tr').count()) === 6,
  );
  check(
    'shows the two bound shortcuts and marks the rest unset',
    (await page.locator('#shortcuts kbd').count()) === 2 &&
      (await page.locator('#shortcuts .shortcut-none').count()) === 4,
  );
  await page.screenshot({ path: shotPath('15-access-and-shortcuts'), fullPage: true });
  await page.screenshot({ path: shotPath('13-groups-list'), fullPage: true });

  // ---- persists across a reload
  await page.reload();
  await page.waitForSelector('.group-card');
  check('persists across a reload', (await page.locator('.group-card').count()) === 1);

  // ---- reopening keeps unfilled rows and stored values
  await page.click('.group-card .btn-edit');
  await page.waitForSelector('#group-title');
  check(
    'reopening shows the stored title and description',
    (await page.inputValue('#group-title')) === 'Acme Storefront' &&
      (await page.inputValue('#group-description')) === 'The main public storefront.',
  );
  check(
    'reopening keeps all four environment rows',
    (await page.locator('.env-row').count()) === 4,
  );
  check(
    'reopening keeps the alias',
    (await page.inputValue('.alias-input')) === 'http://127.0.0.1:3000',
  );
  check(
    'editing a group does not report it colliding with itself',
    (await page.locator('.issue-error').count()) === 0,
  );

  // ---- a second group cannot claim the same port
  await page.click('.editor-actions .btn:not(.btn-primary)');
  await page.waitForSelector('.group-card');
  await page.click('.list-actions .btn-primary');
  await page.waitForSelector('#group-title');

  // A second group also starts with production alone, so local has to be added here too.
  await addEnv('local');
  const secondPrefill = await page.inputValue(url('local'));
  check(
    'suggests a different port for the second group',
    secondPrefill !== 'http://localhost:3000',
    secondPrefill,
  );

  await page.fill('#group-title', 'Acme Dashboard');
  await page.fill(url('local'), 'http://localhost:3000');
  await page.waitForTimeout(200);
  const collision = await page.locator('.issue-error').first().textContent();
  check(
    'blocks a second group from claiming the same local port',
    /Acme Storefront/.test(collision ?? '') && (await page.locator('.editor .btn-primary').isDisabled()),
    (collision ?? '').slice(0, 70),
  );
  await page.screenshot({ path: shotPath('14-editor-collision'), fullPage: true });

  // ---- a different port is fine
  await page.fill(url('local'), 'http://localhost:3100');
  await page.fill(url('prod'), 'https://dash.acme.example');
  await page.waitForTimeout(200);

  // An environment added but not filled in is on with no URL, which is an error by design.
  await addEnv('dev');
  await addEnv('staging');
  await page.waitForTimeout(200);
  check(
    'requires a URL for an environment left switched on',
    (await page.locator('.editor .btn-primary').isDisabled()) &&
      /needs a base URL/.test((await page.locator('.issue-error').first().textContent()) ?? ''),
  );

  // Removing them is the other way to resolve it, and must not disturb the fields already
  // filled in.
  await page.click('.env-row[data-env="dev"] [data-action="remove"]');
  await page.click('.env-row[data-env="staging"] [data-action="remove"]');
  await page.waitForTimeout(200);
  check(
    'removing an environment clears its missing-URL error',
    await page.locator('.editor .btn-primary').isEnabled(),
  );
  check(
    'and the row is gone rather than shown switched off',
    (await page.locator('.env-row[data-env="dev"]').count()) === 0,
  );
  check(
    'no environment row offers an on/off checkbox any more',
    (await page.locator('.env-row [data-toggle="enabled"]').count()) === 0,
  );
  check(
    'toggling a row does not disturb other fields',
    (await page.inputValue(url('local'))) === 'http://localhost:3100' &&
      (await page.inputValue(url('prod'))) === 'https://dash.acme.example',
  );
  check(
    'allows the same host on a different port',
    (await page.locator('.issue-error').count()) === 0,
  );

  await page.click('.editor .btn-primary');
  await page.waitForSelector('.group-card');
  check('now lists two groups', (await page.locator('.group-card').count()) === 2);
  check(
    'card reports environments that are not filled in',
    /not filled in/.test((await page.locator('.group-card:last-child .group-card-foot').textContent()) ?? ''),
  );

  // ---- removing keeps the data, and adding brings it back
  // Already on the list here, so straight into the first group's editor.
  await page.click('.group-card:first-child .btn-edit');
  await page.waitForSelector('#group-title');

  const stagingUrl = await page.inputValue(url('staging'));
  check('the first group still has staging', stagingUrl.length > 0, stagingUrl);

  await page.click('.env-row[data-env="staging"] [data-action="remove"]');
  await page.waitForTimeout(150);
  check(
    'removing it hides the row',
    (await page.locator('.env-row[data-env="staging"]').count()) === 0,
  );
  check(
    'and the add button says what it will bring back',
    ((await page.locator('.add-env [data-add-env="staging"]').textContent()) ?? '').includes(
      stagingUrl,
    ),
  );

  await page.click('.editor .btn-primary');
  await page.waitForSelector('.group-card');
  await page.reload();
  await page.waitForSelector('.group-card');
  await page.click('.group-card:first-child .btn-edit');
  await page.waitForSelector('#group-title');
  check(
    'it is still removed after a save and a reload',
    (await page.locator('.env-row[data-env="staging"]').count()) === 0,
  );

  await addEnv('staging');
  check(
    'adding it back restores the URL rather than an empty field',
    (await page.inputValue(url('staging'))) === stagingUrl,
    await page.inputValue(url('staging')),
  );
  await page.click('.editor .btn-primary');
  await page.waitForSelector('.group-card');

  // ---- the page markers are per group tri-states, and survive a round trip through storage
  await page.click('.group-card:first-child .btn-edit');
  await page.waitForSelector('#group-title');
  check(
    'the markers are set once per group, not per environment row',
    (await page.locator('[data-tristate]').count()) === 2 &&
      (await page.locator('.env-row [data-tristate]').count()) === 0,
  );
  check(
    'both markers start out following the global default',
    (await page.locator('[data-tristate="frame"]').inputValue()) === 'default' &&
      (await page.locator('[data-tristate="tabIcon"]').inputValue()) === 'default',
  );
  check(
    'and the default option says which way the default currently falls',
    (await page.locator('[data-tristate="frame"] option[value="default"]').textContent()).includes(
      '(off)',
    ),
  );

  await page.selectOption('[data-tristate="frame"]', 'on');
  await page.selectOption('[data-tristate="tabIcon"]', 'off');
  await page.click('.editor .btn-primary');
  await page.waitForSelector('.group-card');

  check(
    'an override is called out on the card, since it differs from every other group',
    (await page.textContent('.group-card:first-child .group-card-foot')).includes('frame on'),
  );

  await page.reload();
  await page.waitForSelector('.group-card');
  await page.click('.group-card:first-child .btn-edit');
  await page.waitForSelector('#group-title');
  check(
    'both overrides persisted, each on its own',
    (await page.locator('[data-tristate="frame"]').inputValue()) === 'on' &&
      (await page.locator('[data-tristate="tabIcon"]').inputValue()) === 'off',
  );

  // Back to following the default, which must store nothing rather than store 'default'.
  await page.selectOption('[data-tristate="frame"]', 'default');
  await page.selectOption('[data-tristate="tabIcon"]', 'default');
  await page.click('.editor .btn-primary');
  await page.waitForSelector('.group-card');
  check(
    'clearing both overrides leaves no indicator object in storage',
    await page.evaluate(async () => {
      const stored = await chrome.storage.sync.get(null);
      const groups = Object.entries(stored)
        .filter(([key]) => key.startsWith('grp:'))
        .map(([, value]) => value);
      return groups.every((group) => group.indicator === undefined);
    }),
  );

  // ---- delete needs two clicks
  await page.click('.group-card:last-child .btn-edit');
  await page.waitForSelector('.btn-danger-ghost');
  await page.click('.btn-danger-ghost');
  await page.waitForSelector('.btn-danger');
  check('asks for confirmation before deleting', await page.locator('.delete-prompt').isVisible());

  await page.click('.delete-slot .btn:not(.btn-danger)');
  await page.waitForTimeout(150);
  check(
    'backing out of the delete keeps the group',
    await page.locator('.btn-danger-ghost').isVisible(),
  );

  await page.click('.btn-danger-ghost');
  await page.click('.btn-danger');
  await page.waitForSelector('.group-card');
  check('deletes on confirmation', (await page.locator('.group-card').count()) === 1);

  await page.reload();
  await page.waitForSelector('.group-card');
  check('the deletion persists', (await page.locator('.group-card').count()) === 1);

  // ---- export, share and import
  await page.reload();
  await page.waitForSelector('.group-card');

  // Copy one group, then import it back under a new id to prove the round trip.
  const shared = await page.evaluate(async () => {
    const stored = await chrome.storage.sync.get(null);
    const group = Object.entries(stored).find(([key]) => key.startsWith('grp:'))?.[1];
    return JSON.stringify(group, null, 2);
  });
  check('a single group serializes to JSON', shared.includes('"environments"'));

  // Importing the same group unchanged is an overwrite, not a duplicate.
  await page.fill('.import-input', shared);
  await page.waitForTimeout(400);
  check(
    'importing an identical group is planned as an overwrite',
    (await page.locator('.plan-update').count()) === 1 &&
      (await page.locator('.plan-add').count()) === 0,
    (await page.locator('.plan-summary').textContent()) ?? '',
  );

  // A copy under a new id collides on URLs, and must be refused rather than creating
  // an ambiguous config.
  const clone = shared.replace(/"id": "[^"]+"/, '"id": "cloned-id"');
  await page.fill('.import-input', clone);
  await page.waitForTimeout(400);
  check(
    'a duplicate under a new id is skipped, not added',
    (await page.locator('.plan-skip').count()) === 1 &&
      (await page.locator('.plan-add').count()) === 0,
    (await page.locator('.plan-skip').textContent()) ?? '',
  );
  check('import is blocked when everything is skipped', await page.locator('#backup .btn-primary').isDisabled());

  // A genuinely new group imports cleanly.
  const fresh = shared
    .replace(/"id": "[^"]+"/, '"id": "imported-id"')
    .replace(/"title": "[^"]+"/, '"title": "Imported Site"')
    .replace(/acme\.example/g, 'imported.example')
    .replace(/localhost:3000/g, 'localhost:3900')
    // The alias counts as a claimed URL too, so it has to move as well.
    .replace(/127\.0\.0\.1:3000/g, '127.0.0.1:3900');
  await page.fill('.import-input', fresh);
  await page.waitForTimeout(400);
  check(
    'a genuinely new group is planned as an add',
    (await page.locator('.plan-add').count()) === 1,
    (await page.locator('.plan-summary').textContent()) ?? '',
  );

  await page.click('#backup .btn-primary');
  await page.waitForTimeout(600);
  check('importing adds the group', (await page.locator('.group-card').count()) === 2);
  await page.reload();
  await page.waitForSelector('.group-card');
  check('the import persists', (await page.locator('.group-card').count()) === 2);
  check(
    'the imported group keeps its title',
    (await page.locator('.group-card-title').last().textContent()) === 'Imported Site',
  );
  await page.screenshot({ path: shotPath('16-import'), fullPage: true });

  // ---- reordering
  const titlesBefore = await page.locator('.group-card-title').allTextContents();
  await page.click('.group-card:last-child .env-reorder .btn-icon-sm:first-child');
  await page.waitForTimeout(400);
  const titlesAfter = await page.locator('.group-card-title').allTextContents();
  check(
    'moving a group up reorders the list',
    JSON.stringify(titlesAfter) === JSON.stringify([...titlesBefore].reverse()),
    JSON.stringify(titlesAfter),
  );
  await page.reload();
  await page.waitForSelector('.group-card');
  check(
    'the new order persists',
    JSON.stringify(await page.locator('.group-card-title').allTextContents()) ===
      JSON.stringify(titlesAfter),
  );

  // ---- reordering environments inside a group
  await page.click('.group-card:first-child .btn-edit');
  await page.waitForSelector('#group-title');
  const envsBefore = await page.locator('.env-row').evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-env')),
  );
  await page.click('.env-row[data-index="1"] .env-reorder .btn-icon-sm:first-child');
  await page.waitForTimeout(250);
  const envsAfter = await page.locator('.env-row').evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-env')),
  );
  check(
    'moving an environment up swaps it with the one above',
    envsAfter[0] === envsBefore[1] && envsAfter[1] === envsBefore[0],
    JSON.stringify(envsAfter),
  );

  check('no console errors', errors.length === 0, errors.join(' | ') || 'clean');
} finally {
  await ctx.close();
}

process.exit(report() ? 0 : 1);
