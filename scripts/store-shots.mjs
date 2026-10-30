/**
 * Generates the Chrome Web Store screenshots from the REAL extension.
 *
 * Not mockups. It loads the built `dist/`, configures a group through the actual options page,
 * and photographs the result, so a screenshot cannot show something the extension does not do.
 * That matters twice: the store rejects listings whose screenshots misrepresent the product, and
 * a stale mockup is exactly the kind of thing nobody notices until a reviewer does.
 *
 * Sizes come from the store's requirements: 1280x800, at most five.
 *
 * Two backdrops: `store/demo-storefront.html` for shot 1, `store/demo-page.html` for shots 2
 * and 3. Both are served from one origin, routed by path, because the extension matches on
 * origin and the group is configured with the demo server as production.
 *
 * The two page shots are captured at a 640x400 viewport with deviceScaleFactor 2, which yields
 * 1280x800 with everything at double size. The indicator is a small object by design, and at 1:1
 * in a 1280px-wide image it is a speck once the store scales the thumbnail down. The options page
 * shots are 1:1, because that panel needs the width to look like itself.
 *
 * Setup:
 *   npm install --no-save playwright
 *   export CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome   # if needed
 *
 * Run:
 *   npm run build && xvfb-run -a npm run store:shots
 */

import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const EXT = join(root, 'dist');
const OUT = join(root, 'store', 'screenshots');
mkdirSync(OUT, { recursive: true });

const PORT = Number(process.env.PORT ?? 8600);

/*
 * Two backdrops, one origin.
 *
 * The origin has to stay the same across all three page shots, because the group is configured
 * with `http://localhost:PORT` as production and that is what the extension matches on. So the
 * two pages are routed by path rather than served from two ports. No screenshot shows the
 * address bar, so the path itself is invisible in the output.
 */
const storefront = await readFile(join(root, 'store', 'demo-storefront.html'));
const admin = await readFile(join(root, 'store', 'demo-page.html'));
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url?.startsWith('/orders') ? admin : storefront);
});
await new Promise((r) => server.listen(PORT, r));

const { chromium } = await import('playwright');

/** A fresh profile per capture size, since deviceScaleFactor is fixed per context. */
async function context(width, height, scale) {
  return chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'es-shots-')), {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width, height },
    deviceScaleFactor: scale,
  });
}

async function extensionId(ctx) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const worker of ctx.serviceWorkers()) {
      const match = /^chrome-extension:\/\/([a-p]+)\//.exec(worker.url());
      if (match) return match[1];
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('extension did not register a service worker');
}

/** Grants host permissions without a prompt, which Playwright cannot click. */
const GRANT_STUB = `
  (() => {
    const request = chrome?.permissions?.request;
    if (!request) return;
    chrome.permissions.request = (spec) => chrome.permissions.contains(spec).then((has) =>
      has ? true : new Promise((resolve) => { chrome.permissions.getAll(); resolve(true); }));
  })();
`;

/**
 * Builds the demo group through the real editor.
 *
 * Through the UI rather than by writing storage directly, so the options page screenshots show a
 * group that the editor itself produced, warts and all.
 */
async function setUp(options, optionsUrl, prodUrl) {
  await options.goto(optionsUrl);
  await options.waitForSelector('#groups-view');

  const empty = options.locator('.empty-state .btn-primary');
  await ((await empty.count()) > 0 ? empty.click() : options.click('#groups-view .btn-primary'));
  await options.waitForSelector('#group-title');
  await options.fill('#group-title', 'Acme Storefront');
  await options.fill('#group-description', 'The main public storefront.');

  // The demo server is mapped to PRODUCTION, not local, and that is the point. Red on a page
  // that looks like a real live site is the screenshot that says what this extension is for.
  // The other three are ordinary remote hosts, so the switcher list reads naturally.
  for (const [envKey, url] of [
    ['local', 'http://localhost:3000'],
    ['dev', 'https://dev.acme.example'],
    ['staging', 'https://staging.acme.example'],
  ]) {
    await options.click(`.add-env [data-add-env="${envKey}"]`);
    await options.waitForSelector(`.env-row[data-env="${envKey}"]`);
    await options.fill(`.env-row[data-env="${envKey}"] .url-input`, url);
  }
  await options.fill('.env-row[data-env="prod"] .url-input', prodUrl);

  await options.locator('#group-title').focus();
  await options.waitForTimeout(300);
  await options.click('.editor .btn-primary');
  await options.waitForSelector('.group-card');
}

const shots = [];
const shoot = async (target, name, opts = {}) => {
  const path = join(OUT, `${name}.png`);
  await target.screenshot({ path, ...opts });
  shots.push(name);
  console.log(`  ${name}.png`);
};

// ------------------------------------------------- 1, 2 and 3: the page, at 2x
//
// Captured OUT OF ORDER, on purpose. Turning the frame on is a round trip through the options
// page, and shot 1 and shot 3 both want it on while shot 2 wants it off. So the two unframed
// shots are taken first, the frame goes on once, and the two framed shots follow.
{
  const ctx = await context(640, 400, 2);
  try {
    const id = await extensionId(ctx);
    const OPTIONS = `chrome-extension://${id}/src/options/index.html`;
    const options = await ctx.newPage();
    await options.addInitScript(GRANT_STUB);
    await setUp(options, OPTIONS, `http://localhost:${PORT}`);

    const tab = await ctx.newPage();
    await tab.goto(`http://localhost:${PORT}/orders`, { waitUntil: 'load' });
    await tab.waitForSelector('whichenv-indicator', { timeout: 8000 });
    await tab.bringToFront();

    // 2. The switcher open, which is the whole switching story in one image.
    await tab.hover('whichenv-indicator');
    await tab.waitForTimeout(400);
    await tab.click('whichenv-indicator');
    await tab.waitForTimeout(600);
    await shoot(tab, '02-switcher');

    // Frame on, at its widest, for the two shots below.
    //
    // Saving the group also pushes a refresh, which remounts the indicator and so closes the
    // list opened above. Shot 3 depends on that: nothing else here closes it, and the pill
    // deliberately will not auto-collapse while its list is open.
    await options.bringToFront();
    await options.click('.group-card .btn-edit');
    await options.waitForSelector('#group-title');
    await options.selectOption('[data-tristate="frame"]', 'on');
    await options.click('.editor .btn-primary');
    await options.waitForSelector('.group-card');
    await options.selectOption('#markers select', '8');

    // 3. Production, framed, and collapsed to the resting chip. Two claims at once: the marker
    //    for the environment you must not mistake, and how little room it takes when idle.
    await tab.bringToFront();
    await tab.waitForTimeout(1000);
    await tab.mouse.move(320, 300);
    await tab.waitForTimeout(4800); // let it collapse
    await shoot(tab, '03-frame-collapsed');

    // 1. The lead image, and the only one a stranger is guaranteed to see. A storefront rather
    //    than an admin table, because "this is the live site your customers are on" is a claim
    //    anyone understands, and "internal orders screen" is not.
    //
    //    Frame on, pill expanded, list CLOSED. Shot 2 is the switcher, so opening it here would
    //    spend the lead image on the second image's job and bury the one thing this frame has to
    //    land: you are on production, and you can see it without looking for it.
    //
    //    Held expanded by the hover alone. The pill collapses on a timer once the pointer leaves,
    //    so the mouse has to stay on it through the capture.
    await tab.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
    await tab.waitForSelector('whichenv-indicator', { timeout: 8000 });
    await tab.hover('whichenv-indicator');
    await tab.waitForTimeout(600);
    await shoot(tab, '01-indicator');
  } finally {
    await ctx.close();
  }
}

// --------------------------------------------- 4 and 5: the options page, at 1x
{
  const ctx = await context(1280, 800, 1);
  try {
    const id = await extensionId(ctx);
    const OPTIONS = `chrome-extension://${id}/src/options/index.html`;
    const options = await ctx.newPage();
    await options.addInitScript(GRANT_STUB);
    // A real remote production host here, not the demo server. This screenshot is read rather
    // than looked at, and "Production: http://localhost:8600" in a store listing reads as a
    // mistake even though it is exactly how the other context is legitimately configured.
    await setUp(options, OPTIONS, 'https://acme.example');

    // 4. The group editor. Shows the model, the per-group markers and the validation.
    await options.click('.group-card .btn-edit');
    await options.waitForSelector('#group-title');
    await options.evaluate(() => {
      // Framed from the group title down, so the panel is not cut off mid-label at the top.
      const top = document.querySelector('.editor-title')?.getBoundingClientRect().top ?? 0;
      window.scrollBy(0, top - 24);
    });
    await options.waitForTimeout(400);
    await shoot(options, '04-editor');

    // 5. The colour sets. The accessibility story, and the fixed-mapping argument that
    //    pre-empts the most likely one-star review.
    await options.click('.editor [data-action="cancel"]');
    await options.waitForSelector('.group-card');
    await options.evaluate(() => {
      // Frame the whole panel rather than the picker inside it, so the "colours are fixed, and
      // here is why" paragraph is part of the screenshot. That argument is the point of it.
      const panel = document.querySelector('#palettes').closest('.panel');
      window.scrollBy(0, panel.getBoundingClientRect().top - 20);
    });
    await options.waitForTimeout(400);
    await shoot(options, '05-colors');
  } finally {
    await ctx.close();
  }
}

server.close();
console.log(`\n${shots.length} screenshot(s) in store/screenshots/`);
