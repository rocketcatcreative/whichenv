/**
 * How the tab icon behaves with and without a page Content Security Policy.
 *
 * The bug this exists for: favicons are subject to `img-src`, so a site shipping
 * `img-src 'self'` makes Chrome refuse a `data:` favicon in ANY format, log "Refused to
 * load the image", and keep its own icon. Most production sites ship a CSP. Every other
 * fixture here ships none, which is why the whole suite passed while the feature did
 * nothing on the sites people actually work on.
 *
 * That constraint decides the whole design, because the icon people actually want is the
 * site's own favicon with an environment bar across the bottom, and a composite like that
 * can only exist as a generated `data:` URL. Measured: `data:`, page `blob:` and
 * extension `blob:` are all refused under `img-src 'self'`, so there is no way to hand a
 * generated image to such a page.
 *
 * So there are two tiers, and this asserts both:
 *
 *  - **No CSP:** the site's favicon composited with the environment bar, as a data URL.
 *  - **Strict CSP:** the packaged solid mark from a `chrome-extension://` URL, which is
 *    exempt, with no violation logged.
 *
 * Every assertion about which icon won reads the value CHROME resolved for the tab, not
 * the DOM. A correct `<link rel="icon">` in the document is exactly what fooled the
 * original tests, twice.
 *
 *   npm run build && npm run test:e2e:csp
 */

import { HOST_TAG, checks, createGroup, extensionId, launch } from './harness.mjs';
import { near } from './pixels.mjs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const PORT = Number(process.env.PORT ?? 8221);

/**
 * The page's own favicon, served as a real file at /their.png.
 *
 * Deliberately NOT a data URL. The first version of this fixture used one, and the page's
 * own `img-src 'self'` blocked it, so the suite reported a CSP violation that had nothing
 * to do with the extension. A same-origin file is what a real site does anyway, and it
 * means any violation logged here is ours.
 */
const THEIR_ICON = '/their.png';

/**
 * The page's icon: 32x32 solid magenta.
 *
 * Solid and unmistakable on purpose. A composite has to keep this colour in its upper
 * area and carry the environment colour in a band at the bottom, which is checkable by
 * sampling two pixels.
 */
const THEIR_COLOR = '#FF00FF';
const THEIR_PNG = (() => {
  const zlib = require('node:zlib');
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(32, 0);
  header.writeUInt32BE(32, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.concat(
    Array.from({ length: 32 }, () =>
      Buffer.concat([
        Buffer.from([0]),
        Buffer.concat(Array.from({ length: 32 }, () => Buffer.from([0xff, 0x00, 0xff]))),
      ]),
    ),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
})();

const server = createServer((request, response) => {
  if (request.url === THEIR_ICON) {
    response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    response.end(THEIR_PNG);
    return;
  }

  const headers = { 'content-type': 'text/html; charset=utf-8' };
  // Only /csp carries the policy, so both cases run in one browser against one origin.
  if (request.url.startsWith('/csp')) {
    headers['content-security-policy'] =
      "default-src 'self'; img-src 'self'; script-src 'self' 'unsafe-inline'";
  }
  response.writeHead(200, headers);
  response.end(
    `<!doctype html><html><head><title>${
      request.url.startsWith('/csp') ? 'with CSP' : 'no CSP'
    }</title><link rel="icon" href="${THEIR_ICON}"></head><body><p>hi</p></body></html>`,
  );
});
await new Promise((r) => server.listen(PORT, r));

const { check, report } = checks();
const ctx = await launch({ width: 900, height: 560 });

try {
  const id = await extensionId(ctx);

  const options = await ctx.newPage();
  await createGroup(options, `chrome-extension://${id}/src/options/index.html`, 'CSP', {
    local: `http://localhost:${PORT}`,
  });

  // The tab icon is what this suite is about, so turn it on.
  await options.click('.group-card .btn-edit');
  await options.waitForSelector('#group-title');
  await options.selectOption('[data-tristate="tabIcon"]', 'on');
  await options.click('.editor .btn-primary');
  await options.waitForSelector('.group-card');

  /** Decodes an icon URL in the page and samples two pixels out of it. */
  const sample = (page, href) =>
    page.evaluate(async (src) => {
      const bitmap = await createImageBitmap(await (await fetch(src)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const at = (x, y) => {
        const [r, g, b] = context.getImageData(x, y, 1, 1).data;
        return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
      };
      return {
        size: bitmap.width,
        // Well above the bar, and two rows up from the bottom edge.
        top: at(bitmap.width / 2, Math.round(bitmap.height * 0.25)),
        bottom: at(bitmap.width / 2, bitmap.height - 2),
      };
    }, href);

  /** What Chrome resolved for a tab, which is the only verdict that counts. */
  const resolvedFor = (target) =>
    options.evaluate(
      (suffix) =>
        new Promise((done) => {
          chrome.tabs.query({}, (tabs) => {
            const tab = tabs.find((candidate) => (candidate.url ?? '').endsWith(suffix));
            done(tab?.favIconUrl ?? '(none)');
          });
        }),
      target,
    );

  // ---- a normal page: the site's favicon, composited with the environment bar
  {
    const page = await ctx.newPage();
    const violations = [];
    page.on('console', (message) => {
      if (/Refused to load/i.test(message.text())) violations.push(message.text().slice(0, 90));
    });

    await page.goto(`http://localhost:${PORT}/plain`, { waitUntil: 'load' });
    await page.waitForSelector(HOST_TAG, { timeout: 5000 });
    // The composite replaces the packaged mark once the site's favicon has loaded.
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

    const href = await page.evaluate(
      () => document.querySelector('link[data-whichenv]')?.getAttribute('href') ?? '',
    );
    check('no CSP violation without a CSP', violations.length === 0, violations.join(' | ') || 'clean');
    check('a composite is built without a CSP', href.startsWith('data:image/png'), href.slice(0, 30));

    if (href.startsWith('data:image/png')) {
      const pixels = await sample(page, href);
      check(
        "the composite keeps the site's own icon above the bar",
        near(pixels.top, THEIR_COLOR),
        `${pixels.top} vs ${THEIR_COLOR} at ${pixels.size}px`,
      );
      check(
        'and carries the environment colour in the bar',
        near(pixels.bottom, '#15803D'),
        `${pixels.bottom} vs #15803D`,
      );
    }

    const resolved = await resolvedFor('/plain');
    check(
      'Chrome resolves the tab icon to the composite',
      resolved.startsWith('data:image/png'),
      resolved.slice(0, 30),
    );
    await page.close();
  }

  // ---- a page with a strict CSP: no composite is possible, so the packaged mark stands
  //
  // A header-delivered policy cannot be read from JavaScript, so the only way to learn is
  // to have one icon refused. What matters is that it happens ONCE per origin: repeated on
  // every page load, a red console error on the site's own console reads as our bug.
  const visitCsp = async () => {
    const page = await ctx.newPage();
    const refusals = [];
    page.on('console', (message) => {
      if (/Refused to load/i.test(message.text())) refusals.push(message.text().slice(0, 60));
    });

    await page.goto(`http://localhost:${PORT}/csp`, { waitUntil: 'load' });
    await page.waitForSelector(HOST_TAG, { timeout: 5000 });
    await page.waitForTimeout(1800);

    const href = await page.evaluate(
      () => document.querySelector('link[data-whichenv]')?.getAttribute('href') ?? '',
    );
    return { page, refusals, href };
  };

  const first = await visitCsp();
  check(
    'the first visit learns the policy by having one icon refused',
    first.refusals.length === 1,
    `${first.refusals.length} refusal(s)`,
  );
  check(
    'and settles on the packaged mark',
    /^chrome-extension:\/\/[a-p]{32}\/marks\/default-local\.png$/.test(first.href),
    first.href.slice(0, 62),
  );
  check(
    'Chrome resolves the tab icon to the packaged mark',
    (await resolvedFor('/csp')).includes('/marks/default-local.png'),
  );
  await first.page.close();

  const second = await visitCsp();
  check(
    'a later visit to the same origin does not try again',
    second.refusals.length === 0,
    `${second.refusals.length} refusal(s)`,
  );
  check(
    'and goes straight to the packaged mark',
    second.href.endsWith('/marks/default-local.png'),
    second.href.slice(0, 62),
  );
  await second.page.close();
} finally {
  await ctx.close();
  server.close();
}

process.exit(report() ? 0 : 1);
