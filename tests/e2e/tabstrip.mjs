/**
 * Photographs the real Chrome tab strip.
 *
 * Everything else in this suite asserts on the DOM, and for the tab icon that is not
 * enough: the DOM saying `<link rel="icon" href="...">` proves we asked, not that Chrome
 * decoded the image and drew it. The tab strip is browser UI, which Playwright cannot
 * screenshot, so this drives a REAL windowed browser and photographs the X display.
 *
 * That gap is not hypothetical. The tab icon shipped once with only DOM-level coverage
 * and the first question back was "I do not see the icon in the tab", which no test here
 * could have answered either way.
 *
 * Two flows, because they fail differently:
 *
 *   A. the flag is already on when the page loads
 *   B. the flag is switched on while the tab is ALREADY open, which is what a person
 *      actually does, and where Chrome has already committed a favicon for that tab
 *   C. a site with no `<link rel="icon">` at all, only `/favicon.ico`, which is what most
 *      real sites look like and a different resolution path inside Chrome
 *   D. the link context menu, which is native browser UI and therefore invisible to every
 *      other test here. The unit suite pins what a click DOES; only a photograph shows
 *      that the right items appear on the right link and nothing appears on a stranger.
 *
 * Needs a real display and ImageMagick's `import`, so it is NOT part of `test:e2e:all`.
 * Run it deliberately and LOOK at the four images it prints paths to:
 *
 *   npm run build && npm run test:tabstrip
 *
 * On a headless machine, wrap it: xvfb-run -a npm run test:tabstrip
 */

import { HOST_TAG, createGroup, extensionId, fixturePath, EXT, SHOTS } from './harness.mjs';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const PORT = 8203;
const fixture = await readFile(fixturePath('host-page.html'));
const server = createServer((request, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });

  // A page of links, for the context menu flow. Served over http rather than set with
  // setContent, because an extension gets no context menu on about:blank.
  if (request.url?.startsWith('/links')) {
    res.end(
      `<!doctype html><html><head><title>links</title></head>
       <body style="font:16px system-ui;padding:40px;line-height:2.6">
         <p><a id="known" href="http://localhost:${PORT}/orders/42?ref=email">A link inside a configured group</a></p>
         <p><a id="stranger" href="https://example.org/nothing">A link to somewhere unconfigured</a></p>
       </body></html>`,
    );
    return;
  }

  res.end(fixture);
});
await new Promise((r) => server.listen(PORT, r));

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'ts-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  // A real window, not headless: there is no tab strip to photograph otherwise.
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--window-size=1000,620',
    '--window-position=0,0',
  ],
  viewport: null,
});

const shot = (name) => {
  const path = join(SHOTS, `tabstrip-${name}.png`);
  try {
    execFileSync('import', ['-window', 'root', path], { env: process.env });
  } catch {
    console.error(
      'FAIL  could not photograph the display. This needs ImageMagick (`import`) and a\n' +
        '      real X display. On a headless machine: xvfb-run -a npm run test:tabstrip',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`  ${path}`);
};

const id = await extensionId(ctx);
const options = await ctx.newPage();
await createGroup(options, `chrome-extension://${id}/src/options/index.html`, 'Probe', {
  local: `http://localhost:${PORT}`,
  dev: `http://127.0.0.1:${PORT}`,
});
// A second environment so the context menu has more than one row, and deliberately another
// loopback origin: those are granted statically, so no permission prompt lands on top of the
// screenshot. Flow C reassigns dev later, which is fine; flow D's link points at local.
// ---- flow B: open the tab FIRST, with the flag off
const page = await ctx.newPage();
await page.goto(`http://localhost:${PORT}/host-page.html`, { waitUntil: 'load' });
await page.waitForSelector(HOST_TAG, { timeout: 5000 });
await page.bringToFront();
await page.waitForTimeout(1500);
shot('b1-flag-off');

// ...then switch it on from settings and come back, touching nothing else.
await options.bringToFront();
await options.click('.group-card .btn-edit');
await options.waitForSelector('#group-title');
await options.selectOption('[data-tristate="tabIcon"]', 'on');
await options.click('.btn-primary');
await options.waitForSelector('.group-card');
await page.bringToFront();
await page.waitForTimeout(2500);
const href = await page.$eval('link[rel~="icon"]', (l) => l.getAttribute('href'));
console.log(`  DOM link: ${href.slice(0, 46)}\u2026`);
shot('b2-flag-on-existing-tab');

// ---- flow A: a fresh tab with the flag already on
const fresh = await ctx.newPage();
await fresh.goto(`http://localhost:${PORT}/host-page.html`, { waitUntil: 'load' });
await fresh.waitForSelector(HOST_TAG, { timeout: 5000 });
await fresh.bringToFront();
await fresh.waitForTimeout(2000);
shot('a1-fresh-load');

// ---- flow C: a site with NO <link rel="icon">, only /favicon.ico
//
// What most real sites look like. Chrome resolves the .ico by convention before any
// content script runs, which is a different code path from replacing an existing link
// element, and it was a live suspect when the icon first failed to appear.
const ICO_PORT = PORT + 1;
const ico = await buildIco();
const icoServer = createServer((req, res) => {
  if (req.url === '/favicon.ico') {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    res.end(ico);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><title>No link tag, ico only</title></head><body><p>hi</p></body></html>');
});
await new Promise((r) => icoServer.listen(ICO_PORT, r));

await options.bringToFront();
await options.click('.group-card .btn-edit');
await options.waitForSelector('#group-title');
await options.fill('.env-row[data-env="dev"] .url-input', `http://localhost:${ICO_PORT}`);
await options.selectOption('[data-tristate="tabIcon"]', 'on');
await options.waitForTimeout(200);
await options.click('.btn-primary');
await options.waitForSelector('.group-card');

const icoPage = await ctx.newPage();
await icoPage.goto(`http://localhost:${ICO_PORT}/`, { waitUntil: 'load' });
await icoPage.waitForSelector(HOST_TAG, { timeout: 5000 });
await icoPage.bringToFront();
await icoPage.waitForTimeout(2500);
shot('c1-favicon-ico-only');
icoServer.close();

// ---- flow D: the link context menu
//
// Registered ahead of time and filtered by the LINK's URL, because Chrome has no onShown
// event. So the thing worth seeing is that a link inside a group shows the environments and
// a link to somewhere else shows nothing of ours.
//
// One page per capture, closed in between. Playwright cannot dismiss a native context menu:
// the OS grabs input, so neither Escape nor a click reaches it, and the first attempt at this
// silently photographed the same stale menu twice.
for (const [name, selector] of [
  ['d1-menu-on-a-configured-link', '#known'],
  ['d2-menu-on-a-stranger', '#stranger'],
]) {
  const linkPage = await ctx.newPage();
  await linkPage.goto(`http://localhost:${PORT}/links`, { waitUntil: 'load' });
  await linkPage.bringToFront();
  await linkPage.waitForTimeout(500);

  const box = await linkPage.locator(selector).boundingBox();
  await linkPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await linkPage.waitForTimeout(900);
  shot(name);
  await linkPage.close();
  await new Promise((r) => setTimeout(r, 400));
}

await ctx.close();
server.close();


/** A 32x32 solid magenta PNG, served as /favicon.ico. Chrome sniffs content, not names. */
async function buildIco() {
  const zlib = await import('node:zlib');
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(32, 0);
  ihdr.writeUInt32BE(32, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.concat(
    Array.from({ length: 32 }, () =>
      Buffer.concat([
        Buffer.from([0]),
        Buffer.concat(Array.from({ length: 32 }, () => Buffer.from([0xff, 0x00, 0xff]))),
      ]),
    ),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

console.log(
  '\nNothing above is asserted. Open those images: the framed tab should show a green\n' +
    'rounded square with a white inner square, not the page\u2019s own magenta icon.',
);
