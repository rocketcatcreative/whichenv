# WhichEnv

[![CI](https://github.com/rocketcatcreative/whichenv/actions/workflows/ci.yml/badge.svg)](https://github.com/rocketcatcreative/whichenv/actions/workflows/ci.yml)

A Chrome extension that shows which environment you are looking at, and switches
between dev, staging, prod and local at the same path.

Named for the question it answers. The store listing is
`WhichEnv: Environment Indicator and Switcher`; `short_name` is `WhichEnv`, which is what
Chrome shows wherever space is tight, including the context menu.

Register a **group** for a site, list that site's environments, and every tab on
one of those environments gets a color coded indicator. Click it to jump to a
sibling environment, keeping the path, query string and hash intact.

**Status: Phase 7 complete, plus the visibility, link-action, page-marker and wildcard passes.** Works on every site in a group, local and remote.
Create a group, allow access to its hosts when asked, and any tab on one of those
environments shows the indicator; click it to switch, keeping the path, query and
fragment.

---

## Install

[**Add to Chrome**](https://chromewebstore.google.com/detail/whichenv-environment-indi/jfpaiglimpffdehfmpeehdgimalnldno) from the Chrome Web Store.

It asks for no website access at install. Access to a site is requested only when you save
a group that names it, for those origins alone, and released again automatically once no
group refers to them. Loopback addresses are granted up front, so local development never
prompts at all.

To build and run it from source instead, carry on below.

---

## Quick start

```bash
npm install
npm run dev        # watches and rebuilds into dist/
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the `dist/` folder. Reload the extension from that page after
a rebuild.

### What works today

**Switching.** On a configured environment the pill appears in the top right.
Click it for the list of siblings, then click one:

- click: whatever you set as the default (replace the current tab, out of the box)
- the copy button on a row: puts that environment's URL for this page on your clipboard,
  without navigating
- Cmd or Ctrl click, or the ⧉ button: **inverts** that default
- Shift click: new window

New tabs are gathered into a Chrome tab group named after the site, colored by the
riskiest environment open in it. One prod tab in there and the whole group reads red.
The tab you switched from joins the group too, as long as it was not already in one
of your own.

The path, query string and fragment all carry over, so you land on the same page
you were already looking at. An environment with **Confirm before entering** turned
on takes a second, deliberate click first.

`Alt+Shift+H` hides the indicator on the current tab until reload. A group can also
hide it permanently for its sites, and switching still works from the popup.

**The toolbar badge** takes the environment's color and a three letter code, per
tab. It is the backup signal for when the indicator is hidden or the page has no
content script.

**Right-click any link** that belongs to one of your groups to open it on another
environment, in a new tab, or to copy that environment's URL for it. The page you came from
joins the new tab group, so the two you are comparing sit together, unless it is already in a
group of your own. This is the entry point the pill cannot be: a prod link pasted into
Slack or a ticket sits on a page that is in no group, so there is nothing to click. The menu
only appears on links it can actually do something with.

**Settings page** (right-click the toolbar icon, or the popup's Settings button):

- Create, edit and delete environment groups. Everything persists to
  `chrome.storage.sync`, so it follows your Chrome profile.
- Base URLs normalize as you leave the field, so you see exactly what gets stored,
  including the port that was filled in for you.
- Validation is live and per field. Errors block saving; warnings do not.
- **A host can start with `*.`** to match any subdomain: `*.preview.acme.dev` catches
  `pr-482.preview.acme.dev` and every other preview deploy whose hostname is different
  each time. An exact host always wins over a wildcard that also covers it, whichever
  group each is in, and the most specific wildcard wins among wildcards. A wildcard
  environment can be recognized but not switched INTO, since there is no way to know
  which host you meant; switching *away* from one works normally and keeps the path.
  `*.localhost` and `*.test` are allowed; `*.dev` is not, because it would match every
  site on the TLD.
- Local environments get a port suggestion that no other group has claimed, and
  a registry shows which local ports are spoken for.
- The indicator corner picker moves the indicator in every open tab immediately, and an
  indicator size picker offers a larger pill. Both are global: the point of the indicator
  is that it is the same thing in the same place on every site.
- **Page markers**, two of them, set globally and overridable per group:
  - *Frame the page* draws a border around the whole viewport in the current
    environment's color, at a thickness you choose (3 to 16px). It never intercepts
    clicks, and the indicator moves in from the edge to match, so the frame never sits
    on top of it.
  - *Mark the tab icon* keeps the site's own favicon and adds a bar of the environment
    color across the bottom, so tabs of the same site are tellable apart without losing
    the icon that identifies the site. Where the page's Content Security Policy forbids a
    generated image, it falls back to a solid mark. The site's own icon comes back when
    you switch it off.

  Each group's copy of these is **Use the default / On / Off**, so "on everywhere except
  this one site" and "off everywhere except this one site" are both sayable, and changing
  the global default reaches every group that has not opted out. They apply to every
  environment in a group, each in its own color, so a marker tells you *which*
  environment you are on rather than only that you are somewhere that matters.
- A color set picker swaps the whole palette (Default, Vivid, Subtle, Colorblind safe)
  and repaints every open tab, the toolbar badges and the swatch panel in place.
  Individual colors stay fixed; only the set changes.
- A Switching panel controls the default open mode, tab grouping, and how long the
  pill stays expanded.
- Environments and groups reorder with up and down buttons. Order drives the switcher
  list and the numeric shortcuts.
- Backup and sharing: download or copy the whole config, and copy a single group as
  JSON to paste to a teammate. Import shows exactly what it will do before writing.
- Groups needing site access show a Grant button, and the keyboard shortcuts panel
  lists every command with a link to Chrome's shortcut editor.

**Site access.** Loopback hosts work out of the box. Remote hosts are requested when
you save a group that mentions them, and released again when no group does. Declining
is fine: the group still saves and switching still works, you just do not get the
indicator on those hosts until you allow it. `chrome.storage.sync` means a group set
up on one machine will ask for access again on the next, since permissions are
per-profile-per-machine rather than synced.

**Try it in about ten seconds.** Open a site you work on, click the toolbar icon, and
choose **Create a group from this tab**. It works out which environment you are
looking at, names the group, and guesses the sibling URLs for you to check. Tick the
ones that are right, save, allow access, and you are done.

**In the address bar,** type `env` then a space to switch by name: `env staging`.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Both Vite builds in watch mode, verifying `dist/` after each |
| `npm run build` | Production build into `dist/`, then verifies it is loadable |
| `npm run verify:dist` | Checks every file the manifest points at exists |
| `npm run typecheck` | `tsc -b` across the app and tooling projects |
| `npm test` | Vitest unit suite |
| `npm run test:e2e` | Indicator rendering, corners, color sets, the frame, the tab icon, CSS isolation |
| `npm run test:e2e:editor` | Drives the group editor in a real browser |
| `npm run test:e2e:switching` | Creates a group and switches environments for real, wildcards included |
| `npm run test:e2e:popup` | Popup, including create-group-from-tab |
| `npm run test:e2e:csp` | The tab icon under a page Content Security Policy |
| `npm run test:e2e:all` | All five e2e suites |
| `npm run test:tabstrip` | Photographs the real tab strip. Manual: look at the images |
| `npm run verify` | typecheck, unit tests, build, and manifest validation |
| `npm run check` | Everything: verify, packaging, and all five e2e suites |
| `npm run zip` | Builds `dist.zip` for the Chrome Web Store, then verifies it |
| `npm run icons` | Regenerates the placeholder icons (needs Python + Pillow) |
| `npm run palette:preview` | Regenerates `docs/palette-preview.html` from `palette.ts` |
| `npm run marks` | Regenerates the committed tab marks (needs Playwright, only after a color change) |

`npm run test:e2e` needs Playwright, kept out of `devDependencies` so a normal
checkout does not have to download a browser:

```bash
npm install --no-save playwright && npx playwright install chromium
npm run build && npm run test:e2e
```

Screenshots land in `tests/e2e/screenshots/`. They are worth a look after any
change to `indicator.css`, since CSS isolation failures are visual by nature.

Shared plumbing for the suites lives in `tests/e2e/harness.mjs`. If Playwright is
missing it says so and how to fix it, rather than failing with a module resolution
stack.

`npm run zip` verifies the archive as well as building it: no source maps, no source
files, the manifest version agreeing with `package.json`, every manifest-referenced file
present, and nothing that looks like loading remote code. A bad upload to the store is
slow to find out about, so it is worth catching locally.

---

## How the build is put together

Two Vite builds write into the same `dist/`:

- **`vite.config.ts`** handles the service worker (an ES module) plus the popup
  and options HTML entries.
- **`vite.content.config.ts`** handles the content script separately, because
  content scripts declared in a manifest are not ES modules and need a
  self contained IIFE bundle at a stable filename.

`manifest.json` at the repo root is the source of truth. A small plugin copies it
into `dist/` and stamps it with the version from `package.json`, so the version
lives in exactly one place.

Because two builds share one output directory, either can succeed while `dist/` as
a whole is missing something the manifest points at. Chrome's only report of that
is `Could not load manifest`, which says nothing about what is absent. So
`npm run build` ends with `verify:dist`, which walks the built manifest, checks
every referenced file exists, and names the npm script that should have produced
any that do not. `npm run dev` runs the same check after each rebuild.

It also follows the **static import graph** out of every entry. The service worker
shares code chunks with the options page, and a missing chunk is exactly as fatal as a
missing manifest file while being far easier to miss, because the manifest still looks
complete.

One footgun worth knowing: `npm run <script> <extra args>` forwards those args to
the script, quoted. For a script that shells out to `vite`, a stray argument
becomes vite's positional project-root argument, and the build then runs against
the wrong root and quietly emits nothing useful. Do not paste trailing comments
onto an `npm run` line.

TypeScript is split into two projects so Node globals cannot leak into browser
code and DOM globals cannot leak into build scripts: `tsconfig.app.json` for
`src/` and `tests/`, `tsconfig.node.json` for the Vite configs and `scripts/`.

`@crxjs/vite-plugin` is deliberately not used. It offers content script HMR at
the cost of a third party dependency in the critical path of the build, and
reloading the extension by hand is not a real cost at this size.

---

## Layout

```
manifest.json            source of truth, version stamped at build time
src/core/                pure logic and storage, fully unit tested
  url.ts                 base URL parsing, explicit ports, canonical match keys
  schema.ts              group model, draft vs stored, validation
  ports.ts               local port claims, suggestions, collision detection
  storage.ts             group CRUD on chrome.storage.sync
  match.ts               URL -> group and environment
  translate.ts           URL + target environment -> new URL
  indicator.ts           group tri-state over global default -> what to draw
  settings.ts            global settings: corner, size, color set, markers, collapse
  messages.ts            typed protocol between the worker and the UI
  permissions.ts         per-origin host access: patterns, request, prune
  guess.ts               infer a group from a single URL
  config.ts              export, import, and import planning
  pending.ts             popup to options draft handoff
  palette.ts             environment metadata plus four selectable color sets
  marks.ts               the environment glyphs as vector paths, for tab favicons
  menu.ts                the link context menu, as pure data
src/background/          service worker, navigation, badge, tab groups, registration
src/content/             the on-page indicator (closed shadow DOM)
src/popup/               toolbar popup
src/options/             settings and the group editor
scripts/                 build helpers (clean, dev watcher, zip, verify, icons,
                         palette preview)
tests/unit/              Vitest
tests/e2e/harness.mjs    shared launch, extension id, reporter
tests/e2e/pixels.mjs     reads rendered colors back out of a screenshot
tests/e2e/tabstrip.mjs   photographs the browser's own tab strip (manual)
tests/e2e/csp.mjs        the tab icon under a page Content Security Policy
tests/e2e/               Chromium smoke test and its hostile-CSS fixture
docs/PLAN.md             design, decisions, phases, risks
docs/palette-preview.html  every color set, with colorblind simulations
store/                   submission assets: listing copy, privacy policy source, screenshots
```

`notes/` is deliberately not committed: research and scratch inputs, including the bookmark
exports fed to `npm run from-bookmarks`.

`src/core/` is where the two functions that matter live: **match** (URL to group and
environment) and **translate** (URL plus target environment to a new URL). Both are
pure and dependency free, and they are the reason the unit suite exists.

They share one rule from `url.ts`: **a match key always has an explicit port.**
`http://localhost` and `http://localhost:80` are the same server, and treating them
as two environments would be a silent, maddening bug.

Path handling is segment-aware in both. A base path of `/shop` covers `/shop` and
`/shop/items` but not `/shopping`, which a naive `startsWith` would happily mangle
into nonsense.

Wildcard hosts live in their own bucket in the index and are consulted only after every
exact origin has been tried, which is what makes "an exact host always wins" a structural
property rather than something to remember. A wildcard hit is handed downstream with the
tab's real hostname substituted for the star, so translation has an origin it can actually
rewrite from.

---

## Design commitments

These are decided, and changing them should be a deliberate act rather than a
drive-by edit.

**The tab icon has two tiers, and the reason is Content Security Policy.** Favicons are
fetched under the page's `img-src`. A composite of the site's favicon has to be generated
at page load, so it can only be a `data:` URL, and a site with `img-src 'self'` refuses
that (as it refuses blob URLs from either origin). So the composite is used where the page
permits it, and a packaged solid mark from a `chrome-extension://` URL, which is exempt
from page CSP, is used where it does not. Those marks are committed PNGs in
`public/marks/`, regenerated by `npm run marks` only when a color or shape changes, and
`verify:dist` fails if one a palette needs is missing.

Do not detect this by loading a data URL from the content script and seeing if it works.
A content script runs in an isolated world and is exempt from the page's CSP for its own
requests, so that always succeeds while the browser's favicon fetch still fails.

**Individual environment colors are not user editable.** The value of the
indicator comes from "amber means staging" becoming muscle memory across every
site you work on, which only holds if the mapping never varies. What you *can*
choose is which of four **sets** is in use, globally, and the mapping stays fixed
inside every set. They live in
[`src/core/palette.ts`](src/core/palette.ts), and the unit suite enforces the same
rules over all four: WCAG AA on every pair, no two environments within CIELAB
deltaE 25, and staging at least 40 from prod so it cannot read as a second shade of
red.

Those last two are `STRICT_FLOORS`, and a set may declare lower `floors` when it is
trading separation for something else. **Subtle** is the only one that does: it is
deliberately pale, and low chroma collapses the distance between hues. The floors
still hold it to what it claims, so it cannot quietly get worse, and the suite
refuses a relaxed floor on any other set.

One of the sets, `deuteranopia`, is not a taste option. In the default set prod red
and local green sit about 10 CIELAB units apart under simulated deuteranopia, which
is close to indistinguishable and inherent to any red/green pairing. That set gets
around it by separating the six environments by *lightness* rather than hue, holding
at least 32 units under deuteranopia, protanopia and tritanopia.

[`docs/palette-preview.html`](docs/palette-preview.html) shows all four side by side
with those simulations. It is generated from the source by `npm run palette:preview`,
so it cannot drift from what ships.

**Color is never the only signal.** Every environment also renders its name as
text and carries a distinct glyph, so the indicator stays readable for colorblind
users and in greyscale screenshots. Do not remove the glyphs.

**The indicator's position is a global setting, not a per group one.** All four
corners are available and it defaults to top right. The value of the indicator is
that you learn to glance at one spot, and that habit only forms if the spot never
moves between sites. Per group, the only position-adjacent control is hiding it
entirely.

**The extension asks for no remote host permissions at install time.** It uses
`activeTab` to read the current tab when you click the toolbar icon, which is what makes
"create a group from this tab" possible on a site it has no other access to, and which
shows no install warning. Loopback is
declared statically, because it is the developer's own machine and covering it is
what makes the tool work the moment it is installed. Everything else is requested per
origin when you save a group that mentions it, and released when no group does. It
never requests `<all_urls>` on its own initiative, and it does not use the `tabs`
permission.

Content script registration is derived from the **granted permissions**, not from the
groups, so the two cannot disagree. Revoke access in Chrome's own settings and the
script stops being registered on the next sync.

**The permission prompt is never awaited before saving.** Chrome's prompt is modal
and can be dismissed or ignored indefinitely; blocking the write on it would mean
ignoring the prompt silently throws away the group you just filled in.

**Nothing leaves the browser.** No analytics, no telemetry, no network requests.
Configuration lives in your own Chrome profile sync. This is both the privacy
position and the Chrome Web Store disclosure, and it is worth keeping true.

**Ports are part of an environment's identity.** `localhost:3000` and
`localhost:3001` are different environments. Implicit ports are normalized at save
time, and two groups cannot claim the same origin and port. This is enforced rather
than hoped for, because two projects on the same port cannot be told apart by any
amount of URL inspection. The port registry and the port suggestions exist to make
that constraint painless.

**The editor patches the DOM in place; only structural changes rebuild it.** Blur
fires as focus moves to the next field, so rebuilding the editor on blur tears out
the element the browser is mid-way through focusing and loses whatever was typed
into it. Adding or removing an environment rebuilds; nothing else does.

Relatedly, **nothing in the editor may change height as a side effect of losing
focus.** The alias offers refresh while you type and their row reserves its height,
because a row that grows on blur moves every control below it at exactly the moment
a click is landing there, sending that click to the wrong element.

**The service worker owns matching and navigation; the content script only
renders.** The content script knows nothing about groups, storage or URL rules, and
it is never given target URLs. It sends the URL it is on plus which environment was
picked, and the worker derives the destination. That keeps one source of truth for
URL rules, keeps this bundle small, and means a single page app that changed route
since the pill rendered still switches to the route you are looking at.

---

## Support

Bug reports and feature requests go to
[GitHub issues](https://github.com/rocketcatcreative/whichenv/issues). There are templates for
both, and they open with the one request that matters here: **redact your hostnames.** This
extension is configured with the addresses of environments you work on, some of them internal or
belonging to a client, and an issue is public and permanent. Placeholders in the `example.com`
style keep every detail that determines matching (scheme, port, path prefix, wildcard) without
publishing anyone's infrastructure.

Security problems go through the [private advisory flow](SECURITY.md) instead, never a public
issue.

---

## License

[MIT](LICENSE). Copyright 2026 Rocket Cat Creative.
