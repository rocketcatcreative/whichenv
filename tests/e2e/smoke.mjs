/**
 * End to end smoke test for the indicator itself: that it mounts, collapses,
 * expands, opens its list, sits in the configured corner, and that a deliberately
 * hostile host page cannot reach into it.
 *
 * Sets up a real group first, because the indicator resolves from stored config.
 * `localhost:PORT` and `127.0.0.1:PORT` are the same server on two different
 * origins, which is what lets one local server stand in for two environments.
 *
 * The indicator lives in a CLOSED shadow root, which Playwright selectors cannot
 * pierce. That is exactly the point of it, so this asserts on the host element and
 * uses screenshots for the visual result.
 *
 * Setup (one time):
 *   npm install --no-save playwright && npx playwright install chromium
 *
 * Run:
 *   npm run build && npm run test:e2e
 *
 * Screenshots land in tests/e2e/screenshots/ and are worth eyeballing after any
 * change to indicator.css, since CSS isolation failures are visual by nature.
 */

import {
  HOST_TAG,
  checks,
  createGroup,
  extensionId,
  launch,
  fixturePath,
  shotPath,
} from './harness.mjs';
import { near, pixelAt } from './pixels.mjs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const PORT = Number(process.env.PORT ?? 8123);

const fixture = await readFile(fixturePath('host-page.html'));
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fixture);
});
await new Promise((r) => server.listen(PORT, r));

const { check, report } = checks();

const ctx = await launch({ width: 1000, height: 620 });

const errors = [];
const logs = [];

try {
  const id = await extensionId(ctx);
  const OPTIONS = `chrome-extension://${id}/src/options/index.html`;
  // ---- set up a group the indicator can resolve against
  //
  // localhost and 127.0.0.1 are the same server on two different origins, which is what lets
  // one local server stand in for two environments.
  const options = await ctx.newPage();
  const groupId = await createGroup(options, OPTIONS, 'Smoke Test Site', {
    local: `http://localhost:${PORT}`,
    dev: `http://127.0.0.1:${PORT}`,
    prod: 'https://smoke.invalid',
  });
  check('created a group to resolve against', groupId !== null, groupId ?? 'none');

  const page = await ctx.newPage();
  page.on('console', (message) => {
    const text = message.text();
    logs.push(`${message.type()}: ${text}`);
    if (message.type() === 'error' && !/Failed to load resource|favicon/i.test(text)) {
      errors.push(text);
    }
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

  const state = () => page.getAttribute(HOST_TAG, 'data-state');
  const mounted = (target = page) =>
    target.evaluate((tag) => document.querySelectorAll(tag).length, HOST_TAG);
  const shot = (name) => page.screenshot({ path: shotPath(`${name}.png`) });

  await page.goto(`http://localhost:${PORT}/host-page.html`, { waitUntil: 'load' });
  await page.waitForSelector(HOST_TAG, { timeout: 5000 });
  check('mounts on a matching origin', (await mounted()) === 1);
  check('starts expanded', (await state()) === 'expanded');
  check(
    'defaults to the top right corner',
    (await page.getAttribute(HOST_TAG, 'data-corner')) === 'tr',
  );
  await shot('01-expanded');

  await page.waitForTimeout(4300);
  check('auto-collapses after the timeout', (await state()) === 'collapsed');
  await shot('02-collapsed');

  // ---- the disclosure cue on the collapsed chip
  //
  // Read from pixels, because a closed shadow root leaves nothing else: no selector reaches
  // the dots and getComputedStyle cannot see them. Sampling down the middle of the chip,
  // some pixels must be the pure environment colour (so we know we are on the chip at all)
  // and some must be lighter than it (the chevron, drawn in --es-fg at low opacity).
  const chipColumn = async () => {
    // The host element's own rect, not hardcoded coordinates. Only its SHADOW ROOT is closed;
    // the host is an ordinary element and can be measured. Hardcoding the offsets means the
    // samples silently walk off the chip the next time the corner inset or the pill height
    // changes, which is exactly what happened here.
    const box = await page.evaluate((tag) => {
      const rect = document.querySelector(tag).getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
    }, HOST_TAG);

    const samples = [];
    for (let y = box.top + 4; y <= box.bottom - 4; y += 2) {
      samples.push(await pixelAt(page, box.x, y));
    }
    return samples;
  };

  const collapsedSamples = await chipColumn();
  const brightness = (hex) =>
    [1, 3, 5].reduce((sum, at) => sum + Number.parseInt(hex.slice(at, at + 2), 16), 0);
  const fill = collapsedSamples.filter((colour) => near(colour, '#15803D'));
  const lifted = collapsedSamples.filter((colour) => brightness(colour) > brightness('#15803D') + 30);

  check(
    'the collapsed chip is still the environment colour',
    fill.length > 0,
    `${fill.length} of ${collapsedSamples.length} samples`,
  );
  check(
    'and carries a lighter disclosure cue on top of it',
    lifted.length > 0,
    `${lifted.length} lifted samples, e.g. ${lifted[0] ?? 'none'}`,
  );
  // Subtle is the whole brief: a hint, not a second glyph competing with the colour.
  check(
    'which stays subtle rather than reading as a solid mark',
    lifted.every((colour) => !near(colour, '#FFFFFF', 40)),
    lifted.join(' '),
  );

  // Expanded, the cue gives way to the label. It must not sit behind the text.
  await page.hover(HOST_TAG);
  await page.waitForTimeout(400);
  check(
    'the cue is gone once the pill is expanded',
    (await chipColumn()).every((colour) => brightness(colour) <= brightness('#15803D') + 30),
  );
  await page.mouse.move(400, 400);
  await page.waitForTimeout(4400);

  await page.hover(HOST_TAG);
  await page.waitForTimeout(350);
  check('expands on hover', (await state()) === 'expanded');
  await shot('03-hover');

  await page.click(HOST_TAG);
  await page.waitForTimeout(350);
  check('stays expanded while the list is open', (await state()) === 'expanded');
  check(
    'the shadow root is closed, so the page cannot reach inside',
    await page.evaluate((tag) => document.querySelector(tag)?.shadowRoot === null, HOST_TAG),
  );
  await shot('04-list-open');

  await page.mouse.click(500, 400);
  await page.waitForTimeout(250);
  check('clicking away closes the list', (await state()) === 'expanded');

  // ---- an origin in no group stays silent
  const stranger = await ctx.newPage();
  await stranger.goto(`http://127.0.0.1:${PORT}/host-page.html`, { waitUntil: 'load' });
  await stranger.waitForTimeout(700);
  check('mounts on the other configured origin too', (await mounted(stranger)) === 1);
  await stranger.close();

  // ---- the corner setting is global, and takes effect without a reload
  await options.bringToFront();
  check(
    'options page renders a picker for all four corners',
    (await options.locator('#corners .corner').count()) === 4,
  );
  check(
    'picker reflects the stored corner',
    (await options
      .locator('#corners .corner[aria-checked="true"]')
      .getAttribute('data-corner')) === 'tr',
  );
  await options.screenshot({ path: shotPath('06-options-corner-picker') });

  for (const corner of ['tl', 'bl', 'br', 'tr']) {
    await options.click(`#corners .corner[data-corner="${corner}"]`);
    // No reload of the content page: the change should propagate via
    // chrome.storage.onChanged into the already-open tab.
    await page
      .waitForFunction(
        ([tag, want]) => document.querySelector(tag)?.getAttribute('data-corner') === want,
        [HOST_TAG, corner],
        { timeout: 3000 },
      )
      .catch(() => {});
    const applied = (await page.getAttribute(HOST_TAG, 'data-corner')) === corner;
    check(`moves live to ${corner} without a reload`, applied);
    if (applied) {
      await page.bringToFront();
      await page.hover(HOST_TAG);
      await page.waitForTimeout(320);
      await shot(`07-corner-${corner}`);
      await options.bringToFront();
    }
  }

  // ---- the colour set is global too, and repaints without a reload
  check(
    'options page renders a picker for every colour set',
    (await options.locator('#palettes .palette').count()) === 4,
  );
  check(
    'picker reflects the stored colour set',
    (await options
      .locator('#palettes .palette[aria-checked="true"]')
      .getAttribute('data-palette')) === 'default',
  );

  for (const palette of ['vivid', 'muted', 'deuteranopia', 'default']) {
    await options.click(`#palettes .palette[data-palette="${palette}"]`);
    // No reload: the pill repaints in place from chrome.storage.onChanged, keeping its
    // collapse state and any open list.
    await page
      .waitForFunction(
        ([tag, want]) => document.querySelector(tag)?.getAttribute('data-palette') === want,
        [HOST_TAG, palette],
        { timeout: 3000 },
      )
      .catch(() => {});
    const applied = (await page.getAttribute(HOST_TAG, 'data-palette')) === palette;
    check(`repaints live to the ${palette} set without a reload`, applied);

    // The swatch panel is the preview, so it has to follow the selection too.
    check(
      `swatch panel redraws for the ${palette} set`,
      (await options.locator('#swatches .swatch').count()) === 6,
    );
    check(
      `and shows no hex or contrast figures for ${palette}`,
      !/#[0-9A-F]{6}|contrast|tab group/i.test(
        (await options.locator('#swatches').textContent()) ?? '',
      ),
    );

    if (applied) {
      await page.bringToFront();
      await page.hover(HOST_TAG);
      await page.waitForTimeout(320);
      await shot(`08-palette-${palette}`);
      await options.bringToFront();
    }
  }

  await options.click('#palettes .palette[data-palette="vivid"]');
  await options.waitForTimeout(250);
  await options.screenshot({ path: shotPath('09-options-palette-picker') });

  const freshPalette = await ctx.newPage();
  await freshPalette.goto(`http://localhost:${PORT}/host-page.html`, { waitUntil: 'load' });
  await freshPalette.waitForSelector(HOST_TAG, { timeout: 5000 });
  check(
    'a newly opened tab picks up the stored colour set',
    (await freshPalette.getAttribute(HOST_TAG, 'data-palette')) === 'vivid',
  );
  await freshPalette.close();

  // Restored so a later run starts from the documented default.
  await options.click('#palettes .palette[data-palette="default"]');
  await options.waitForTimeout(250);

  // Setting is global, so a newly opened tab must agree with the stored value.
  await options.click('#corners .corner[data-corner="bl"]');
  await options.waitForTimeout(250);
  const fresh = await ctx.newPage();
  await fresh.goto(`http://localhost:${PORT}/host-page.html`, { waitUntil: 'load' });
  await fresh.waitForSelector(HOST_TAG, { timeout: 5000 });
  check(
    'a newly opened tab picks up the stored corner',
    (await fresh.getAttribute(HOST_TAG, 'data-corner')) === 'bl',
  );
  await fresh.close();

  // Leave the default in place so screenshots from a later run start clean.
  await options.click('#corners .corner[data-corner="tr"]');
  await options.waitForTimeout(200);

  // ---- copying a sibling environment's URL from the switcher
  //
  // Target URLs are deliberately kept out of the content script, so the row asks the worker
  // for one and writes it locally. The content script is the right place for the write: it has
  // a focused document and the worker has none.
  await page.bringToFront();
  const DEEP = `/deep/page.html?ref=email#reviews`;
  await page.goto(`http://localhost:${PORT}${DEEP}`, { waitUntil: 'load' });
  await page.waitForSelector(HOST_TAG, { timeout: 5000 });
  await page.click(HOST_TAG);
  await page.waitForTimeout(350);
  await shot('11-switcher-with-copy');

  // First, the half with the logic in it: ask the real worker what a switch WOULD target.
  // Anything copied has to agree with where clicking would actually go.
  const asked = await options.evaluate(
    ([id, url]) => chrome.runtime.sendMessage({ type: 'urlFor', groupId: id, envKey: 'dev', url }),
    [groupId, `http://localhost:${PORT}${DEEP}`],
  );
  check(
    'the worker reports the URL a switch would target, without switching',
    asked?.type === 'url' && asked.url === `http://127.0.0.1:${PORT}${DEEP}`,
    asked?.url ?? JSON.stringify(asked),
  );
  check(
    'and refuses an environment that is not in the group',
    (
      await options.evaluate(
        ([id, url]) =>
          chrome.runtime.sendMessage({ type: 'urlFor', groupId: id, envKey: 'qa', url }),
        [groupId, `http://localhost:${PORT}${DEEP}`],
      )
    )?.type === 'error',
  );

  // Then the button itself. The list is in a closed shadow root so no selector reaches it;
  // click by coordinate instead. Offsets are from the host box, whose right edge is the
  // viewport edge: the copy control sits just left of the new-tab control on the first row.
  // The clipboard assertion is what makes this safe, since drifting geometry fails loudly
  // rather than passing quietly.
  await page.bringToFront();
  const box = await page.locator(HOST_TAG).boundingBox();
  await page.evaluate(() => navigator.clipboard.writeText('nothing-copied-yet'));
  await page.mouse.click(box.x + box.width - 58, box.y + 90);
  await page.waitForTimeout(500);

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  check(
    'the copy control puts the sibling URL on the clipboard',
    clipboard === `http://127.0.0.1:${PORT}${DEEP}`,
    clipboard,
  );
  check('and does not navigate away', page.url().includes(`localhost:${PORT}`), page.url());
  await shot('12-switcher-after-copy');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // ---- the per-group viewport frame
  check('no frame until a group asks for one', (await page.getAttribute(HOST_TAG, 'data-frame')) === null);

  // Layout must be untouched by the frame, so measure before turning it on.
  const metrics = () =>
    page.evaluate(() => {
      const main = document.querySelector('main');
      const box = main.getBoundingClientRect();
      return {
        docWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        mainLeft: Math.round(box.left),
        mainTop: Math.round(box.top),
        mainWidth: Math.round(box.width),
      };
    });
  const before = await metrics();

  await options.click('.group-card .btn-edit');
  await options.waitForSelector('#group-title');
  await options.selectOption('[data-tristate="frame"]', 'on');
  await options.click('.btn-primary');
  await options.waitForSelector('.group-card');

  // Saving pushes a refresh, so the already-open tab grows the frame with no reload.
  await page
    .waitForFunction(
      (tag) => document.querySelector(tag)?.getAttribute('data-frame') === 'on',
      HOST_TAG,
      { timeout: 4000 },
    )
    .catch(() => {});
  const framed = (await page.getAttribute(HOST_TAG, 'data-frame')) === 'on';
  check('turning the frame on applies it without a reload', framed);

  await page.bringToFront();
  await page.waitForTimeout(200);
  await shot('10-frame-on');

  // The colour is the real assertion, and the shadow root is closed, so read the
  // rendered pixel. 2px in from the corner lands inside a 5px border.
  const corner = await pixelAt(page, 2, 2);
  check(
    'the frame is painted in the local environment colour',
    near(corner, '#15803D'),
    `${corner} vs #15803D`,
  );

  // Sampling the same spot under a different set proves the frame follows the palette,
  // which it gets for free from --es-bg only as long as nobody hardcodes a colour.
  await options.bringToFront();
  await options.click('#palettes .palette[data-palette="vivid"]');
  await page.bringToFront();
  await page.waitForTimeout(400);
  const vivid = await pixelAt(page, 2, 2);
  check('the frame follows a palette change', near(vivid, '#16A34A'), `${vivid} vs #16A34A`);
  await options.bringToFront();
  await options.click('#palettes .palette[data-palette="default"]');
  await page.bringToFront();
  await page.waitForTimeout(300);

  const after = await metrics();
  check('the frame does not move or resize page content', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after));

  // pointer-events: none is load bearing. The frame covers the whole viewport, so
  // without it every page under a framed environment would be unclickable.
  const hitTest = await page.evaluate(
    ([tag]) => {
      const top = document.elementFromPoint(2, 2);
      return { tag: top?.tagName?.toLowerCase() ?? null, isHost: top?.tagName?.toLowerCase() === tag };
    },
    [HOST_TAG],
  );
  check('the frame does not intercept pointer events', hitTest.isHost === false, `topmost at 2,2 is ${hitTest.tag}`);

  let clicked = false;
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page.evaluate(() => {
    window.__clicked = false;
    document.querySelector('main button').addEventListener('click', () => {
      window.__clicked = true;
    });
  });
  await page.click('main button');
  clicked = await page.evaluate(() => window.__clicked === true);
  check('page content stays clickable under a frame', clicked);

  // ---- the per-group tab icon
  //
  // Unlike the frame, this reaches into the page's own head, so the assertions are
  // about what it takes over AND what it gives back.
  const iconHrefs = () =>
    page.$$eval('link[rel~="icon"]', (links) =>
      links.map((link) => ({
        href: link.getAttribute('href') ?? '',
        ours: 'whichenv' in link.dataset,
      })),
    );
  // Enough of each href to tell the three icons in play apart: the page's original, the
  // one the page swapped in, and ours.
  const fills = (icons) =>
    JSON.stringify(
      icons.map((icon) => /%23([0-9a-f]{6})/i.exec(icon.href)?.[1] ?? icon.href.slice(0, 22)),
    );

  const original = await iconHrefs();
  check(
    'the page starts with its own icon and no mark',
    original.length === 1 && !original[0].ours,
    JSON.stringify(original.map((i) => i.href.slice(0, 40))),
  );

  await options.bringToFront();
  await options.click('.group-card .btn-edit');
  await options.waitForSelector('#group-title');
  await options.selectOption('[data-tristate="tabIcon"]', 'on');
  await options.click('.btn-primary');
  await options.waitForSelector('.group-card');

  await page
    .waitForFunction(
      (tag) => document.querySelector(tag)?.getAttribute('data-tab-icon') === 'on',
      HOST_TAG,
      { timeout: 4000 },
    )
    .catch(() => {});
  check('turning the tab icon on applies it without a reload', (await page.getAttribute(HOST_TAG, 'data-tab-icon')) === 'on');

  const marked = await iconHrefs();
  check(
    'the mark is the only icon link left in the document',
    marked.length === 1 && marked[0].ours === true,
    JSON.stringify(marked.map((i) => i.ours)),
  );
  // This fixture ships no CSP, so the icon upgrades from the packaged mark to a composite
  // of the page's own favicon plus an environment bar. The CSP-restricted case, where the
  // packaged mark has to stand, is tests/e2e/csp.mjs.
  await page
    .waitForFunction(
      () =>
        document
          .querySelector('link[data-whichenv]')
          ?.getAttribute('href')
          ?.startsWith('data:image/png'),
      undefined,
      { timeout: 5000 },
    )
    .catch(() => {});
  const composited = await iconHrefs();
  check(
    'the icon upgrades to a composite of the site\u2019s own favicon',
    composited[0]?.href.startsWith('data:image/png') === true,
    composited[0]?.href.slice(0, 30) ?? 'none',
  );
  // The colour cannot be read out of a base64 PNG by inspection, so decode the icon and
  // sample it. The centre is the shape, the corner inside the plate is the fill.
  const iconPixels = await page.evaluate(async (href) => {
    const bitmap = await createImageBitmap(await (await fetch(href)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const at = (x, y) => {
      const [r, g, b] = context.getImageData(x, y, 1, 1).data;
      return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
    };
    return {
      size: bitmap.width,
      // The fixture's icon is magenta with a white circle; the bar is the bottom band.
      top: at(4, 4),
      bar: at(bitmap.width / 2, bitmap.height - 2),
    };
  }, composited[0].href);
  check(
    'the composite keeps the site\u2019s artwork above the bar',
    near(iconPixels.top, '#FF00FF'),
    `${iconPixels.top} vs #FF00FF at ${iconPixels.size}px`,
  );
  check(
    'and carries the local environment colour in the bar',
    near(iconPixels.bar, '#15803D'),
    `${iconPixels.bar} vs #15803D`,
  );

  // This is the check the whole MutationObserver exists for.
  const stolen = await page.evaluate(() => window.__stealFavicon());
  check('the page can be made to steal the favicon back', stolen.includes('00ffff'));
  await page
    .waitForFunction(
      () => {
        const links = [...document.querySelectorAll('link[rel~="icon"]')];
        return links.length === 1 && 'whichenv' in links[0].dataset;
      },
      undefined,
      { timeout: 3000 },
    )
    .catch(() => {});
  const reclaimed = await iconHrefs();
  check(
    'the mark is re-asserted after the page overwrites it',
    reclaimed.length === 1 && reclaimed[0].ours === true,
    JSON.stringify(reclaimed.map((i) => ({ ours: i.ours, href: i.href.slice(0, 30) }))),
  );

  await options.bringToFront();
  await options.click('#palettes .palette[data-palette="vivid"]');
  await page.waitForTimeout(900);
  const repainted = await iconHrefs();
  const vividBar = await page.evaluate(async (href) => {
    const bitmap = await createImageBitmap(await (await fetch(href)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const [r, g, b] = context.getImageData(bitmap.width / 2, bitmap.height - 2, 1, 1).data;
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
  }, repainted[0].href);
  check('the bar follows a palette change', near(vividBar, '#16A34A'), `${vividBar} vs #16A34A`);
  await options.bringToFront();
  await options.click('#palettes .palette[data-palette="default"]');
  await page.waitForTimeout(250);

  // Giving it back is the whole reason this is safe to offer.
  await options.bringToFront();
  await options.click('.group-card .btn-edit');
  await options.waitForSelector('#group-title');
  await options.selectOption('[data-tristate="tabIcon"]', 'off');
  await options.click('.btn-primary');
  await options.waitForSelector('.group-card');
  await page
    .waitForFunction((tag) => document.querySelector(tag)?.getAttribute('data-tab-icon') === null, HOST_TAG, {
      timeout: 4000,
    })
    .catch(() => {});
  const restored = await iconHrefs();
  check(
    'switching it off leaves nothing of ours behind',
    restored.every((icon) => icon.ours === false) && restored.length > 0,
    JSON.stringify(restored.map((i) => i.ours)),
  );
  check(
    'the icon the page had is back',
    restored.some((icon) => icon.href.includes('ff00ff')),
    fills(restored),
  );
  // The page overwrote its own icon mid-test. That replacement supersedes what we
  // found, so it has to end up last, where Chrome will actually use it.
  check(
    'the page\u2019s own later replacement wins over the one we displaced',
    restored.at(-1)?.href.includes('00ffff') === true,
    fills(restored),
  );

  // ---- the frame must never sit on top of the pill, at any width
  //
  // This was already subtly wrong when the width was hard-coded to 5px: the frame is
  // `inset: 0` and the pill sits flush to the same edge. Now that the width is a setting
  // it is not subtle any more, so the clearance is measured at every width on offer
  // rather than eyeballed once. The pill's own box comes from getBoundingClientRect on
  // the host, which is readable through a closed shadow root.
  await options.bringToFront();
  await options.click('.group-card .btn-edit');
  await options.waitForSelector('#group-title');
  await options.selectOption('[data-tristate="frame"]', 'on');
  await options.click('.btn-primary');
  await options.waitForSelector('.group-card');

  const gaps = () =>
    page.evaluate((tag) => {
      const host = document.querySelector(tag);
      const box = host.getBoundingClientRect();
      return {
        right: Math.round((document.documentElement.clientWidth - box.right) * 10) / 10,
        top: Math.round(box.top * 10) / 10,
      };
    }, HOST_TAG);

  for (const width of [3, 5, 8, 12, 16]) {
    await options.bringToFront();
    await options.selectOption('#markers select', String(width));
    await page.bringToFront();
    await page.hover(HOST_TAG);
    await page
      .waitForFunction(
        ([tag, want]) =>
          getComputedStyle(document.querySelector(tag)).getPropertyValue('--es-edge').trim() ===
          `${want}px`,
        [HOST_TAG, width],
        { timeout: 3000 },
      )
      .catch(() => {});

    const gap = await gaps();
    check(
      `at a ${width}px frame the pill clears it on the right`,
      gap.right >= width,
      `gap ${gap.right} vs frame ${width}`,
    );
    check(
      `and clears it on the top`,
      gap.top >= width,
      `gap ${gap.top} vs frame ${width}`,
    );
    // The frame's own colour still has to be there, or the clearance is trivially met by
    // there being no frame at all.
    const edge = await pixelAt(page, 1, Math.round(page.viewportSize().height / 2));
    check(
      `and the ${width}px frame is actually drawn`,
      near(edge, '#15803D'),
      `${edge} vs #15803D`,
    );
    if (width === 16) await shot('13-frame-16px');
  }

  await options.bringToFront();
  await options.selectOption('#markers select', '5');

  // ---- the indicator size is global and applies without a reload
  const pillBox = async () => {
    await page.bringToFront();
    await page.hover(HOST_TAG);
    await page.waitForTimeout(300);
    return page.evaluate((tag) => {
      const box = document.querySelector(tag).getBoundingClientRect();
      return { w: Math.round(box.width * 100) / 100, h: Math.round(box.height * 100) / 100 };
    }, HOST_TAG);
  };

  const normalBox = await pillBox();
  await options.bringToFront();
  await options.selectOption('#indicator-size select', 'large');
  await page
    .waitForFunction((tag) => document.querySelector(tag)?.dataset.size === 'large', HOST_TAG, {
      timeout: 3000,
    })
    .catch(() => {});
  const largeBox = await pillBox();

  check(
    'the large indicator is bigger in both dimensions, live',
    largeBox.w > normalBox.w && largeBox.h > normalBox.h,
    `${normalBox.w}x${normalBox.h} -> ${largeBox.w}x${largeBox.h}`,
  );
  await shot('14-indicator-large');

  await options.bringToFront();
  await options.selectOption('#indicator-size select', 'normal');
  await page
    .waitForFunction((tag) => document.querySelector(tag)?.dataset.size === 'normal', HOST_TAG, {
      timeout: 3000,
    })
    .catch(() => {});
  check(
    'and going back to normal restores the original size exactly',
    JSON.stringify(await pillBox()) === JSON.stringify(normalBox),
    `${JSON.stringify(normalBox)} vs ${JSON.stringify(await pillBox())}`,
  );

  // ---- a global default reaches a group that has not overridden it
  await options.bringToFront();
  await options.click('.group-card .btn-edit');
  await options.waitForSelector('#group-title');
  await options.selectOption('[data-tristate="frame"]', 'default');
  await options.click('.btn-primary');
  await options.waitForSelector('.group-card');
  await page
    .waitForFunction((tag) => document.querySelector(tag)?.getAttribute('data-frame') === null, HOST_TAG, {
      timeout: 4000,
    })
    .catch(() => {});
  check(
    'back on the default, the frame follows the global setting (off)',
    (await page.getAttribute(HOST_TAG, 'data-frame')) === null,
  );

  await options.bringToFront();
  await options.check('[data-setting="frameByDefault"] input');
  await page
    .waitForFunction((tag) => document.querySelector(tag)?.getAttribute('data-frame') === 'on', HOST_TAG, {
      timeout: 4000,
    })
    .catch(() => {});
  check(
    'switching the global default on reaches a group that never opted in',
    (await page.getAttribute(HOST_TAG, 'data-frame')) === 'on',
  );

  await options.bringToFront();
  await options.uncheck('[data-setting="frameByDefault"] input');
  await page.waitForTimeout(600);

  // Off again, so a later run starts from the documented default.
  await options.bringToFront();
  await options.click('.group-card .btn-edit');
  await options.waitForSelector('#group-title');
  await options.selectOption('[data-tristate="frame"]', 'off');
  await options.click('.btn-primary');
  await options.waitForSelector('.group-card');
  await page
    .waitForFunction((tag) => document.querySelector(tag)?.getAttribute('data-frame') === null, HOST_TAG, {
      timeout: 4000,
    })
    .catch(() => {});
  check('turning the frame off removes it', (await page.getAttribute(HOST_TAG, 'data-frame')) === null);

  check('no console errors from the extension', errors.length === 0, errors.join(' | ') || 'clean');
} finally {
  await ctx.close();
  server.close();
}

process.exit(report() ? 0 : 1);
