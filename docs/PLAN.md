# WhichEnv, Chrome Extension Plan

**Status:** Phases 0 through 7 complete, plus the three pre-Phase-8 enhancements:
selectable color sets, per-environment viewport frame, colored tab icon. The tab icon's
visual treatment is deliberately held open, with a title-prefix alternative sketched (see
Phase 7.5). Next: Phase 8, store submission.
**Name:** `WhichEnv` (`short_name`), listed as `WhichEnv: Environment Indicator and Switcher`
**Target:** Chrome / Edge / Brave, Manifest V3, published to the Chrome Web Store
**Stack:** Vite + TypeScript, no UI framework
**Revised:** 2026-07-31 (rev 9)

---

## 1. What it does

You register a **group** for a site (say "Acme Storefront") and list that site's
environments (prod, staging, dev, local). From then on, any tab whose URL belongs
to one of those environments shows a color coded indicator telling you where you
are.

**Clicking the indicator opens a list of the other environments in that group.**
Each row shows the environment's color, its label, and the target hostname.
Selecting one takes you there at the same path with the same query string. Default
is to replace the current tab; modifier keys or an explicit button open a new tab
or window instead.

The whole product rests on two pure functions: **match** (URL to group + env) and
**translate** (URL + target env to new URL). Everything else is UI around those
two. They get built and unit tested first.

---

## 2. Decisions locked

| Decision | Choice |
|---|---|
| Environment matching | Base URL per environment, longest prefix match on scheme + host + **port** + base path. Wildcard patterns deferred to v2, schema reserves the field. |
| Storage | `chrome.storage.sync` (follows your Chrome profile) plus JSON export/import for sharing. |
| Indicator | Floating corner pill injected into the page. **The pill itself is filled with the environment color**, not just an accent dot, so the environment is readable at a glance from anywhere on screen. Toolbar icon badge is color matched as a secondary signal. |
| Build | Vite multi entry + TypeScript, plain DOM for UI. |
| Distribution | Chrome Web Store listing. This drives the permission strategy in section 6. |

---

## 3. Data model

`schemaVersion` ships from day one so migrations are cheap later.

```ts
type EnvKey = 'prod' | 'staging' | 'dev' | 'local' | 'preview' | 'qa';

interface EnvironmentDef {
  key: EnvKey;              // determines the color, non editable
  label?: string;           // display override, e.g. "UAT" shown in the qa slot
  baseUrl: string;          // "https://staging.acme.com", "http://localhost:3000",
                            // may include a base path: "https://acme.com/shop"
  aliases?: string[];       // extra origins that match this env (www vs bare,
                            // 127.0.0.1 vs localhost, vanity domains)
  enabled: boolean;
  confirmOnEnter?: boolean;  // default FALSE. Per environment opt in guard (see 8.4)
  pattern?: string;          // RESERVED for v2 wildcard matching, unused in v1
  // The frame and the tab icon were here until pass D. They are per GROUP now: see
  // EnvGroup.indicator below, and the trade recorded in 7.8 D.
}

/** A per group override of a global default. Absent means the same as 'default'. */
type Tristate = 'default' | 'on' | 'off';

interface EnvGroup {
  id: string;                    // crypto.randomUUID()
  title: string;                 // required
  description?: string;          // optional
  environments: EnvironmentDef[];  // user ordered, order is meaningful (see 8.7)
  indicator?: {
    // Note: no corner and no size here. Both are global (see Settings below).
    hidden?: boolean;            // turn the indicator off entirely for this site
    frame?: Tristate;            // frame the viewport, over settings.frameByDefault
    tabIcon?: Tristate;          // mark the tab icon, over settings.tabIconByDefault
  };
  createdAt: number;
  updatedAt: number;
}

interface Settings {
  schemaVersion: 1;
  /**
   * Where the indicator sits, on every page, for every group. Global on
   * purpose: the value of the indicator is that you learn to glance at one spot,
   * and that habit only forms if the spot never moves. Defaults to top right,
   * which is the most noticeable corner and the least likely to collide with
   * what sites pin to the bottom of the viewport (cookie banners, chat widgets,
   * toasts).
   */
  corner: 'tl' | 'tr' | 'bl' | 'br';   // default 'tr'
  /** Global for the same reason the corner is. 'normal' is what shipped before it existed. */
  indicatorSize: 'normal' | 'large';   // default 'normal'
  autoCollapseMs: number;              // default 4000, 0 = never collapse
  openInNewTabByDefault: boolean;      // default false
  createTabGroupOnNewTab: boolean;     // default true
  /** Defaults for the two page markers, each overridable per group. */
  frameByDefault: boolean;             // default false
  frameWidth: 3 | 5 | 8 | 12 | 16;     // default 5, snapped rather than rejected
  tabIconByDefault: boolean;           // default false
  paletteId: PaletteId;                // default 'default'
  theme: 'auto' | 'light' | 'dark';    // default 'auto'
}
```

Settings changes propagate through `chrome.storage.onChanged`, so moving the
indicator repositions it in every tab that is already open rather than waiting
for a reload.

`normalizeSettings()` is the pure, total coercion function that turns whatever is
in storage into a valid `Settings`. Every other context reads through it, which
is what makes settings safe to use without defensive checks at each call site,
and it is where schema migrations will live. `normalizeGroup()` plays the same
role for groups.

### Draft versus stored

The editor holds a `GroupDraft`, where every field is a plain string that may be
empty or wrong. Only `EnvGroup` reaches storage, normalized and validated. Keeping
them apart means the editor never has to fake a valid group to render a partly
typed one, and nothing downstream has to defend against a group that was saved
mid-edit.

**Invariant: `enabled` implies a parseable `baseUrl`.** Both `draftToGroup` and
`normalizeGroup` enforce it, so the matcher and the switcher never have to check
for an environment that is switched on with nowhere to go. An environment with an
empty base URL is kept but forced off, because it is a placeholder row the user
has not filled in yet and dropping it would silently delete rows from the editor
between saving and reopening.

### Errors versus warnings

Errors block saving; warnings do not. A group with one environment and a bare
`http://localhost` are both legal, just worth a nudge. Warnings currently cover:
a loopback URL with no explicit port, a host with no domain suffix (`https://acme`,
which is valid for docker service names and intranet hosts but far more often a
half-typed domain), only one usable environment, and none usable yet.

### Storage layout

`chrome.storage.sync` caps at **8 KB per item** and 100 KB total, so groups are
stored one per key rather than as a single array. Editing one group then does not
rewrite the others, which also keeps us clear of the 1800 writes/hour ceiling.

```
settings          -> Settings
groups:index      -> string[]   (ordered group ids, drives display order)
grp:<uuid>        -> EnvGroup
```

A flattened lookup table (normalized origin + basePath to `{groupId, envKey}`) is
derived on startup and cached in `chrome.storage.session`, rebuilt whenever a
`grp:*` key changes. Matching a tab is then a single map lookup, not a scan.

---

## 4. Color palette

Individual colors are hard coded and identical across every group, as specified.
What *is* selectable is which **set** is in use, globally: four sets, each keeping
the same environment-to-color mapping so the habit survives the choice.

Everything that does not vary between sets (glyph, label, badge code, meaning)
lives in `ENV_META`. Only the six colors vary, which keeps each set to six lines
and makes it obvious what a new set has to supply.

### The four sets

| Set | For | Min separation | Lowest contrast |
|---|---|---|---|
| `default` | Semantic first: red means stop and think | 41 | 5.02:1 |
| `vivid` | Same hues, more chroma. Loudest on a busy page | 50 | 4.71:1 |
| `muted` (Subtle) | Pale tints, for sitting next to a design you are judging | 14 | 6.31:1 |
| `deuteranopia` | Separated by lightness, not hue | 46 | 6.29:1 |

The default set:

| Env | Hex | Text | Contrast | Glyph | Meaning |
|---|---|---|---|---|---|
| `prod` | `#C62828` red | white | 5.62:1 | ● | you can break real things here |
| `staging` | `#F59E0B` amber | `#1C1917` | 8.14:1 | ▲ | production-like, shared, be considerate |
| `dev` | `#1D4ED8` blue | white | 6.70:1 | ◆ | integration, safe to break |
| `local` | `#15803D` green | white | 5.02:1 | ■ | your machine, fully safe |
| `preview` | `#A21CAF` magenta | white | 6.32:1 | ◇ | reserved slot for a custom env |
| `qa` | `#475569` slate | white | 7.58:1 | ▣ | reserved slot for a custom env |

`docs/palette-preview.html` renders all four side by side with simulations and
measured figures. It is **generated** from `palette.ts` by
`npm run palette:preview`, so it cannot drift from what ships.

### Rules any set has to satisfy

All four are enforced by the unit suite, over every set, not just the default:

1. Every bg/fg pair clears WCAG AA (4.5:1).
2. No two environments sit within CIELAB deltaE 25 of each other.
3. Staging stays at least 40 from prod, so it cannot read as a second shade of
   red. The original `#B45309` sat 28.2 units away, which is exactly how it went
   wrong the first time; `#F59E0B` sits 58.1 away.
4. Color is never the only signal. Every environment also has a distinct glyph
   and always renders its label as text.

Rules 2 and 3 are `STRICT_FLOORS`, and a set may declare its own lower `floors`
when it trades separation for something else. **`muted` (Subtle) is the only one
that does**, at 13 and 28. It is a deliberately pale, low-chroma set, and dropping
chroma collapses the perceptual distance between hues: nothing gets that back short
of making it louder, which would defeat the point of it.

That tradeoff is safe to make precisely because of rule 4. The glyph and the text
label carry the information regardless, the strict sets remain available, and one of
them is built specifically for guaranteed separation. What the floors buy is that a
relaxed set is still held to what it claims, so it cannot quietly get worse, and the
suite refuses a relaxed floor on any set other than that one.

### Why a colorblind set exists at all

The worst confusable pair in the default set is prod red against local green
under deuteranopia, which is inherent to any red/green semantic pairing: measured,
they sit about **10** CIELAB units apart. That is close to indistinguishable, and
no amount of tweaking a red fixes it while green means local.

The `deuteranopia` set solves it by not relying on hue. It spreads the six
environments across a very wide *lightness* range (near-white grey, light sky,
amber, crimson, violet, near-black navy) so every pair stays apart once hue
collapses. Measured separation is at least **32** under simulated deuteranopia,
protanopia and tritanopia. That also lets prod stay a real red, which is worth
keeping.

### Chrome tab group color mapping

Chrome permits nine tab group colors, so each set maps down to the closest nine.
The default set:

```
prod -> red        staging -> orange     dev -> blue
local -> green     preview -> purple     qa -> grey
```

The toolbar *icon* is generated at build time and does not follow the setting: it
is the product mark, not an environment indicator. The icon **badge** does follow
it, because that one is an environment indicator.

---

## 5. Matching and translation

### Matching (`core/match.ts`)

1. Ignore anything that is not `http:` or `https:` (skips `chrome://`,
   `file://`, extension pages, the new tab page).
2. Normalize to a **match key** of `scheme://host:port` plus `pathname`.
3. Look up against every enabled environment's `baseUrl` and `aliases`, taking
   the **longest matching prefix**. Longest prefix is what lets `acme.com` and
   `acme.com/shop` coexist as separate groups.
4. Only then, fall back to **wildcard hosts** (pass E). A host written `*.preview.acme.dev`
   matches that domain and anything under it, with the port and base path still exact. Exact
   origins are consulted first and exhaustively, so a wildcard can never shadow one, whichever
   group each belongs to; among wildcards the longest suffix wins. A wildcard hit is handed on
   with the tab's REAL host substituted in, which is what makes it possible to switch away
   from one. A wildcard is never a switch target.
5. No match means no indicator and no badge color. Silence is the default state.

### Ports are first class

You are right that this is the case that will bite, and it needs to be designed
for rather than handled. Almost every local site is `http://localhost` on a
different port, so **the port is frequently the only thing distinguishing one
group's local environment from another's**.

- The match key always includes an explicit port. Implicit ports are normalized
  at save time, so `http://localhost` becomes `http://localhost:80` and
  `https://acme.com` becomes `https://acme.com:443`. Without this normalization
  `http://localhost` and `http://localhost:80` would be treated as two different
  environments while being the same server.
- Collision detection compares **full origins including port**.
  `localhost:3000` and `localhost:3001` in two different groups is completely
  fine. The same `localhost:3000` in two groups is blocked at save time, with the
  conflicting group named in the error.
- Saving a local base URL with **no explicit port** produces a warning:
  bare `http://localhost` means port 80, which almost no dev server uses, and it
  is guaranteed to collide with the next group that does the same thing. The
  options page nudges you toward `http://localhost:3000`.
- Saving `http://localhost:3000` automatically offers `http://127.0.0.1:3000` as
  an alias, since the browser treats those as different origins while they are
  the same server. Same for `[::1]`.

**The one case origin matching genuinely cannot solve:** if you run project A and
project B both on `:3000` at different times, no amount of URL inspection can
tell which one a given tab belongs to. There is no clever fix, only a choice.
I would enforce unique ports (the collision check already does this) and help you
comply with it via the port registry in 8.8, because that is also just healthier
local setup. The alternative, disambiguating by base path, only works if your dev
servers actually mount projects at distinct paths, which they usually do not.

Worth noting given your `~/Sites` directory: if you are on Laravel Valet or
anything else serving `*.test` hostnames, those are distinct hosts on port 80 and
have no collision problem at all. The port issue is mostly a Node, Vite, and
Docker concern.

### Translation (`core/translate.ts`)

```
current:      https://staging.acme.com/shop/products/42?ref=email&v=2#reviews
matched base: https://staging.acme.com
target base:  http://localhost:3000

remainder = /shop/products/42?ref=email&v=2#reviews
result    = http://localhost:3000/shop/products/42?ref=email&v=2#reviews
```

Rules:

- Strip the matched base (origin **and** its base path) to get the remainder.
- Join the target base to the remainder, collapsing duplicate slashes.
- Query string and hash carry over untouched.
- Scheme, host, and port always come from the **target** base, never the source.
  This is what makes `https://acme.com` to `http://localhost:3000` work, crossing
  both a scheme boundary and a port boundary in one hop.
- Trailing slashes on stored base URLs are normalized away at save time.
- Credentials embedded in the URL (`https://user:pass@host`) are stripped.
- Empty remainder yields the bare target base.

These two modules are pure, dependency free, and get a thorough Vitest suite.
If a bug ever reaches you in this extension, it lives here.

---

## 6. Permissions strategy

Now that a store listing is the goal, this section stops being a matter of taste.

**Do not request `<all_urls>`.** Broad host permissions trigger the "Read and
change all your data on all websites" warning, push the submission into deeper
review, and are the single most common cause of slow or rejected listings. For a
tool whose job is knowing about four specific domains, it is also simply more
access than we need.

**Also drop the `tabs` permission.** It surfaces as "Read your browsing history",
which is alarming out of proportion to what we do with it. We do not need it:
host permissions already grant read access to `tab.url`, `title`, `pendingUrl`
and `favIconUrl` for the origins we have been granted. Removing it costs nothing
and materially improves the install prompt.

```json
{
  "permissions": ["activeTab", "contextMenus", "storage", "scripting", "tabGroups"],
  "host_permissions": ["http://localhost/*", "http://127.0.0.1/*"],
  "optional_host_permissions": ["*://*/*"],
  "incognito": "split"
}
```

Loopback hosts are declared statically. They are the developer's own machine, and
covering them by default is what lets the extension work on a local site the moment
it is installed with no prompt at all. They appear in `host_permissions` as well as
`content_scripts` because reading a tab's URL, which the toolbar badge needs,
requires host access: a content script match alone does not confer it under
Manifest V3.

`activeTab` is what lets the popup read the URL of the active tab when you click the
toolbar icon. Host permissions are not enough for that: "create a group from this tab"
is for a site you have NOT set up, which is precisely a site no host permission covers.
It shows no install warning, so it costs nothing in the permission story.

Two constraints from Chrome's match pattern syntax shape `core/permissions.ts`. A
port is optional in a pattern and behaves as `:*` when omitted, so host permissions
are per HOST, not per host and port: `localhost:3000` and `localhost:3001` are two
environments but one permission. And IPv6 literal hosts have no match pattern
syntax at all, so an `http://[::1]:3000` alias cannot be granted and is filtered out
rather than failing the whole request.

When you save a group, the options page calls `chrome.permissions.request()` for
exactly the origins in that group. This must happen inside a user gesture, so it
is wired to the Save button. The service worker then registers the indicator
content script for only those origins via
`chrome.scripting.registerContentScripts()`. Install time asks for nothing, and
the extension can genuinely only see the sites you told it about, which is also
the easiest possible story to tell in the store's privacy disclosure.

Other manifest notes:

- Content script runs in the **top frame only** (`all_frames: false`) so iframes
  do not each grow their own pill.
- `commands` for keyboard shortcuts (a manifest key, not a permission).
- No remote code of any kind. Everything is bundled at build time. This is a hard
  store requirement, not a preference.

---

## 7. Indicator UX

### Rendering

Injected into a **closed shadow root** on a single positioned host element, with
`all: initial` as the reset and `z-index: 2147483647`. Closed shadow DOM means the
host page's CSS cannot leak in and mangle it, and the page's scripts cannot reach
inside. The host element is `position: fixed` and does not participate in layout,
so it cannot reflow the site.

### States

Position defaults to **top right** and is set globally in settings, with all four
corners available. The pill sits flush against the viewport edge so its color
reads as a marker on the edge of the screen; the switcher list floats with a
small inset from that edge.

**Collapsed** (resting state): a small tab filled with the environment color,
roughly 9px by 34px, flush against the chosen edge. Big enough to read the color
from across the room, small enough to never cover anything.

**Expanded**: a pill **filled with the environment color**, showing the env glyph,
the environment name, and the group title, in white or near black text per the
palette. Expands on hover or keyboard focus. Starts expanded for 4 seconds on page
load (configurable, 0 to disable) so you get the signal on arrival without
permanent clutter.

**List** (on click): the other environments in the group, each row showing its
color, label, and target hostname. Interactions:

- Click: replace the current tab (default)
- `Cmd`/`Ctrl` + click, or the ⧉ button on the row: open in a new tab
- `Shift` + click: open in a new window

Accessibility: the pill is a real `<button>` in the shadow root, the list is a
listbox with arrow key navigation, `Esc` closes it, focus is trapped while open
and restored on close. Honors `prefers-reduced-motion` and
`prefers-color-scheme`.

### Escape hatches

`Alt+Shift+H` hides the indicator on the current tab until reload. Per group
`indicator.hidden` kills it permanently for that site. Both exist because you
will eventually need a clean screenshot or a shared screen. Moving the indicator
to a different corner is the other escape hatch, for the site whose own UI
happens to live where yours does.

---

## 8. Recommended additions

Ordered by value per unit of effort.

### 8.1 Create group from the current tab  ★ highest value (done, Phase 6)
Clicking the toolbar icon on an unrecognized site offers "Create a group from
this tab." It prefills the title from the page title, drops the current origin
into a slot you pick, then **guesses the siblings**: `staging.<domain>`,
`dev.<domain>`, `<domain>.test`, and a `localhost` entry pre-filled with the
lowest port not already claimed by another group. Without this, every group is a
tedious manual form and the extension dies of onboarding friction. With it,
adding a site takes about ten seconds.

### 8.2 Keyboard shortcuts
`Alt+Shift+1` through `4` jump straight to the nth environment in the current
group. `Alt+Shift+E` opens the switcher. For anyone hopping environments dozens of
times a day these become the primary interface and the pill goes purely
informational. Cheap, via the `commands` API.

### 8.3 Omnibox keyword
Type `env staging` in the address bar to switch. Roughly 40 lines using the
`omnibox` API, and it composes with muscle memory people already have.

### 8.4 Optional guard on entering an environment  (revised)
A per environment checkbox, **off by default**, that requires a second click
before switching **into** that environment. It lives on each environment row
rather than being prod specific, so you can also guard a shared staging box that
runs real integrations. Leaving a guarded environment is never blocked, only
entering it. Most sites will never turn this on, and that is fine. The value is
that on the one project where a stray write against prod is expensive, the option
is right there.

### 8.5 Shareable group snippets
Beyond whole config export/import, let a single group export as a small JSON blob
you can paste into Slack and paste back in to import. Team onboarding becomes
"here, paste this" instead of "go set up four URLs."

### 8.6 Duplicate origin detection
Covered in section 5, listed here because it is a feature and not just
validation. Two groups silently claiming the same origin and port produces
behavior that is close to impossible to debug from the outside.

### 8.7 Environment order is meaningful
Environments are user draggable, and that order drives everything: the list order
in the switcher, the keyboard shortcut indices, tab group ordering. People think
in a pipeline from local up to prod, and the UI should match whatever pipeline
they actually have.

### 8.8 Local port registry  (new, follows from the port discussion)
A small panel in the options page listing every localhost port claimed across all
groups, and which group owns each. It makes the uniqueness constraint from
section 5 feel like a helpful map instead of an arbitrary rejection, it feeds the
port guess in 8.1, and it answers "what was that project running on again?"
which is a question you will ask anyway. Maybe 60 lines of UI over data we
already have indexed.

### Deliberately out of scope

- **Health/status dots per environment.** Showing whether staging is up needs
  network requests to every environment on every page load plus broader
  permissions, and under the August 2026 store policy any data touching gets more
  scrutiny. It is a monitoring feature wearing a switcher's clothes.
- **Auto redirect rules.** Automatically bouncing you from prod to local is a
  great way to lose an afternoon. Switching stays explicit.
- **Credential or cookie syncing across environments.** Tempting, genuinely
  dangerous, and a different product.
- **Firefox port.** The code will be close to portable, but browser specific
  quirks around dynamic content scripts are not free. Revisit once Chrome is
  stable and listed.

---

## 9. Resolved questions

1. **Custom environments beyond the four defaults:** yes. `preview` (magenta) and
   `qa` (slate) are exposed as two extra slots with a `label` override, so you can
   add "UAT" or "Demo" without ever letting a user choose a color. Capped at six.
   A group needing more than six is a sign it should be split.
2. **Multiple hosts per environment:** yes, via `aliases`. Match only, never a
   switch target. This also does useful work for `127.0.0.1` against `localhost`.
3. **Distribution:** Chrome Web Store. See section 10.

---

## 10. Chrome Web Store requirements

Worth knowing up front, because two of these shape the code and one is landing
immediately.

### Policy changes effective August 1, 2026

Google is tightening three things that touch us, all of which we pass cleanly
provided we are deliberate:

- **Limited Use.** Data collection must be strictly necessary to the stated
  purpose. We collect nothing and transmit nothing, so the honest answer to every
  disclosure question is "no".
- **Disclosure.** Any data collection requires prominent notification, and
  changes to data handling after install must be proactively disclosed. Our
  commitment is simple: config lives in your own Chrome profile sync, nothing
  leaves the browser, no analytics, no telemetry. Putting that in writing in the
  listing and the README is the whole compliance story, and it is worth keeping
  it true rather than adding analytics later and having to re-disclose.
- **Single purpose.** One clear job. We satisfy this comfortably.

### What we need to produce

- 128x128 store icon, plus the 16/32/48 set for the toolbar
- 1 to 5 screenshots at 1280x800
- 440x280 small promo tile (1400x560 marquee tile is optional)
- Detailed description, no keyword stuffing
- Primary category, most likely Developer Tools
- A hosted privacy policy URL. GitHub Pages off this repo is sufficient.
- A support URL or contact address
- Per permission justification text in the dashboard, one short paragraph each
  for `storage`, `scripting`, `tabGroups`, and the optional host permissions
- A one time developer registration fee on the publishing account

### Consequences for the build

The permission decisions in section 6 stop being nice-to-have. Requesting host
permissions per origin instead of `<all_urls>`, and dropping `tabs`, is the
difference between a listing that reviews quickly and one that sits in a queue
being asked to justify why a URL switcher needs to read every page you visit.

---

## 11. File layout

```
whichenv/
├── manifest.json
├── package.json
├── tsconfig.json
├── vite.config.ts
├── README.md
├── PRIVACY.md                     served via GitHub Pages for the store listing
├── docs/
│   ├── PLAN.md                    (this file)
│   └── palette-preview.html       generated: all four sets, with CVD simulations
├── public/
│   ├── icons/                     16/32/48/128 toolbar icons
│   └── marks/                     generated tab marks, 6 envs x 4 palettes
├── store/                         screenshots, promo tiles, listing copy
├── src/
│   ├── core/                      ← pure, framework free, fully unit tested
│   │   ├── schema.ts              types, runtime validation, migrations
│   │   ├── storage.ts             group CRUD, index, settings, change events
│   │   ├── url.ts                 origin normalization incl. implicit ports
│   │   ├── match.ts               URL → { group, env }
│   │   ├── translate.ts           URL + target env → new URL
│   │   ├── palette.ts             ENV_META plus four color sets, tab group mapping
│   │   ├── marks.ts               the env glyphs as vector paths, for tab favicons
│   │   ├── icon-pick.ts           which of a page's icons to composite on
│   │   ├── csp.ts                 does this page's policy permit a data: image
│   │   ├── menu.ts                the link context menu, as pure data
│   │   ├── indicator.ts           group tri-state over global default → what to draw
│   │   ├── settings.ts            global settings: corner, size, color set, markers, collapse
│   │   ├── messages.ts            typed protocol between worker and UI
│   │   ├── permissions.ts         per-origin host access: patterns, request, prune
│   │   ├── guess.ts               infer a group from one URL
│   │   ├── config.ts              export, import, and import planning
│   │   ├── pending.ts             popup to options draft handoff
│   │   ├── ports.ts               local port registry and collision checks
│   │   └── permissions.ts         optional host permission request/revoke
│   ├── background/
│   │   ├── service-worker.ts      wiring, message router
│   │   ├── index-cache.ts         match index cached in storage.session
│   │   ├── badge.ts               per-tab toolbar badge
│   │   ├── scripts.ts             dynamic content script registration
│   │   ├── tab-groups.ts          Chrome tab groups for new-tab switches
│   │   ├── omnibox.ts             the "env" address bar keyword
│   │   ├── context-menu.ts        open a right-clicked link on another environment
│   │   ├── badge.ts               toolbar icon color per tab
│   │   ├── navigate.ts            same tab / new tab / new window, tab groups,
│   │   │                          guard confirmation
│   │   └── scripts.ts             dynamic content script registration
│   ├── content/
│   │   ├── indicator.ts           shadow DOM pill + environment list + page frame
│   │   ├── favicon.ts             takes over and gives back the tab icon
│   │   ├── composite.ts           site favicon + environment bar, and the CSP verdict
│   │   └── indicator.css          inlined into the shadow root at build time
│   ├── popup/                     quick switch, create group from tab
│   ├── options/                   group editor, port registry, import/export
│   └── ui/                        shared primitives (color dot, env row, toggle)
└── tests/
    ├── unit/                      Vitest: url, match, translate, ports, schema
    └── e2e/                       Playwright: load unpacked, smoke tests,
                                    pixels.mjs reads colours back off the screen
```

### Build

Plain Vite with multiple entry points (service worker, content script, popup,
options) plus a small plugin that copies and version stamps the manifest.
Deliberately avoiding `@crxjs/vite-plugin`: it gives nice content script HMR but
puts a third party dependency in the critical path of the build, and reloading the
extension by hand is not a real cost at this size.

`npm run dev` watches and rebuilds into `dist/`, which you load unpacked.
`npm run build` produces a minified `dist/` plus a `dist.zip` ready to upload.

---

## 12. Build phases

Each phase ends at something you can load and use, so you can redirect early.

**Phase 0 — Scaffold**  ✅ complete
Repo hygiene (`.gitignore`, `.editorconfig`, `.nvmrc`), dual Vite build, split TS
projects, manifest version stamping, placeholder icons, `palette.ts` with a
contrast enforcing unit test, the indicator rendering in a closed shadow root, and
a Chromium smoke test that loads the built extension against a deliberately
hostile host page.

Pulled forward from Phase 1: `settings.ts` and the global indicator corner
picker, because making the corner a real setting required the storage read/write
and change subscription anyway.

**Phase 1 — Data layer and group editor**  ✅ complete
`url.ts`, `schema.ts`, `ports.ts` and `storage.ts`, plus the options page group
list and editor: full CRUD, live per-field validation, port normalization,
in-group duplicate and cross-group collision detection, loopback alias offers,
port suggestions and the local port registry. 157 unit tests and 35 editor e2e
checks. No matching yet.

Pulled forward from Phase 6: the local port registry (8.8), because it falls out
of `ports.ts` for about forty lines of UI and it is what makes the port
uniqueness rule read as help rather than as an arbitrary rejection.

**Phase 2 — Match and translate**  ✅ complete
`match.ts` and `translate.ts` on top of the existing `url.ts`, plus their unit
tests, including the full localhost port matrix. Path matching is segment-aware, so a base path of `/shop` covers `/shop/items`
but not `/shopping`. Translation always takes scheme, host and port from the
target, which is what lets one hop cross from https on 443 to http on 3000.

**Phase 3 — Indicator and switching**  ✅ complete
The indicator resolves from real stored config via the service worker, and
switching navigates. The worker owns matching and navigation; the content script
only renders and reports clicks, so this bundle knows nothing about groups,
storage or URL rules.

The match index is cached in `chrome.storage.session`, invalidated by group
changes rather than by a timer, so it cannot serve stale results after an edit.

Target URLs are deliberately NOT sent to the content script. The switch message
carries the URL the tab is on at click time and the worker derives the
destination, which means a single page app that has changed route since the pill
rendered still switches to the route you are actually looking at, and a stale or
tampered-with target cannot send a tab somewhere your config does not describe.

Pulled forward from Phase 5: new tab and new window switching, and the opt-in
enter guard. Both had visible affordances already (the modifier keys, the ⧉
button, the editor checkbox), and shipping visible controls that do nothing is
worse than a slightly larger phase. Phase 5 is now just Chrome tab groups.

**Phase 4 — Permissions, badge, shortcuts**  ✅ complete
Per-origin host permissions and dynamic content script registration, pulled forward
from Phase 6 because without them the indicator only worked on loopback, which is
half a product. Plus the per-tab toolbar badge, the keyboard commands, and a
shortcuts panel in settings.

Registration is derived from the GRANTED PERMISSIONS rather than from the groups, so
the two can never disagree: revoke access in Chrome's own settings and the script
stops being registered on the next sync, with no separate bookkeeping.

Access is requested from the Save click but deliberately never awaited before
writing. Chrome's prompt is modal and can be dismissed or ignored indefinitely;
waiting on it would mean ignoring the prompt silently discards the group you just
filled in. A group without access is perfectly usable, it just cannot draw its
indicator on those hosts, and the group list offers a Grant button for that.

Access is also given up again when no group mentions an origin any more, with one
exception: a deliberate blanket grant is never revoked on our initiative.

Deferred to Phase 6: create group from the current tab (8.1).

**Phase 5 — Chrome tab groups**  ✅ complete
A new-tab switch puts the tab into a Chrome tab group named after the environment
group. One group per SITE, not per environment: a group holding a prod tab and a
staging tab is the useful arrangement, and splitting it per environment would be
four tab groups for one site.

That leaves colour, since the tabs inside span environments. The rule is **the
riskiest environment currently in the group**: one prod tab anywhere in there and
the whole group reads red. Deliberately not recomputed when a tab closes, so the
colour stays at its high-water mark rather than quietly downgrading a group that
had prod in it.

The tab a switch came FROM is pulled in too, but only when it is currently
ungrouped. Grouping only the new tab left the pair split, which defeated the point:
the two tabs being compared ended up in different places. A tab already in some group
is left exactly where it is, because that arrangement is the user's and not ours to
rearrange. This applies whether the group is being created or joined, since the
adjacency argument does not care which.

An existing group is found by remembered id first, then by title. The id survives
the user renaming the group; the title survives the worker losing session storage.
New windows are never grouped: opening one is a request to separate this tab, and
gathering it up would undo that.

Also here, because they had no UI and were therefore unreachable: a Switching panel
in settings exposing `openInNewTabByDefault`, `createTabGroupOnNewTab` and
`autoCollapseMs`. Wiring the first of those revealed that the pill ignored it
entirely, so a modifier now INVERTS the configured default rather than always
meaning "new tab" — otherwise someone who prefers new tabs has no gesture left for
replacing the current one.

**Phase 6 — Sharing and polish**  ✅ complete
Create a group from the current tab (8.1), config export and import, per group
snippet share (8.5), the omnibox keyword (8.3), and reordering (8.7).

**Create from tab** is the onboarding fix. Filling in four URLs and a title by hand
is enough friction to stop people bothering, and an extension nobody sets up does
nothing. `core/guess.ts` infers which environment a URL looks like, strips the
environment label to get the apex, and generates siblings from it. Guessed siblings
are filled in but left DISABLED: a hostname that does not exist would otherwise be a
switch target that goes nowhere, so ticking one is a deliberate "yes, that is right".
Unknown hostnames guess prod, which puts the red pill on them, the safe direction to
be wrong in.

**Import is generous in, strict out.** It accepts a full exported config, a bare
array of groups, or a single shared group, because all three are things a person will
plausibly paste. Everything comes back through `normalizeGroup`, so an import cannot
introduce a shape the rest of the extension has to defend against. It always shows
what it is about to do and waits for a second click, because an import that silently
overwrote a group would be a mistake with no undo. Merge refuses anything that would
create a URL collision with a group it is not replacing; replace frees the outgoing
groups' URLs first, so those are not collisions at all.

**Reordering is buttons, not drag.** Order drives the switcher list and the numeric
shortcuts, so it has to be reachable from the keyboard, and two buttons do that
without a drag interaction to make accessible.

Also here: `verify:dist` now follows the static import graph out of every built entry.
The service worker began sharing code chunks with the options page this phase, and a
missing chunk is exactly as fatal as a missing manifest file while being far easier to
miss, since the manifest still looks complete.

Deferred: drag-and-drop reordering, and any theme control beyond the automatic
light/dark the CSS already does.

**Phase 7 — Harden**  ✅ complete
Real icons, the remaining test gaps closed, a verified package, and one command that
runs the lot.

**The icons** are three left-aligned bars in local green, staging amber and production
red: a stack of environments growing toward the one that matters most, in the pill's own
shape language. Three constraints shaped it and are worth keeping if it is redrawn.
Thin horizontal strokes are the first thing to turn to mush at 16px, so the bars are
thick with generous gaps and everything renders at 8x before reduction. Chrome's badge
covers roughly the bottom 40%, so the mark sits above centre. And the near-black plate
works on both light and dark toolbars, which a light plate would not.

**Tests** now cover `index-cache`, `badge`, `pending` and the DOM helpers, which had
none. 390 unit tests, 114 e2e checks.

**`npm run zip` verifies the archive**, not just builds it. A bad upload is slow to find
out about, so it refuses source maps, source files, a version that disagrees with
package.json, a manifest-referenced file that is not in the archive, and anything that
looks like loading remote code. Each check was confirmed by deliberately breaking the
build.

**The e2e suites share one harness.** Four copies of the launch options, the extension
id lookup, the permission stub and the reporter became one. It also turns a missing
Playwright into an explanation rather than a module resolution stack, which is the
failure a fresh checkout will actually hit.

`npm run check` is the single command: typecheck, unit tests, build, dist verification,
packaging, and all four e2e suites.

**Phase 7.5 — Visibility enhancements**  ✅ complete
Three refinements to what already exists, all requested as preferences rather than
bug fixes. Ordered so the one that touches every other consumer lands first.

1. **Selectable color sets**  ✅ done
   `paletteId` becomes a global setting with four sets: Default, Vivid, Muted and
   Colorblind safe. Individual colors stay uneditable, so the mapping is fixed
   inside every set (see section 4).

   The set had to reach the pill, the switcher rows, the toolbar badge, the tab
   group color, the popup and every environment chip in the options page. Two
   different mechanisms, chosen per context rather than uniformly:

   - The **service worker** threads `PaletteId` explicitly, because it paints
     badges and tab groups from a place with no document to hang variables on. It
     repaints every badge on any settings change rather than diffing the palette,
     since the worker is usually STARTED BY the change it would be comparing
     against and has no previous value to compare with.
   - The **options page and popup** publish the set as `--env-<key>-bg` /
     `--env-<key>-fg` custom properties on the document root (`ui/palette-vars.ts`).
     A dozen renderers reference the variables, so switching sets is one assignment
     and the browser repaints everything: no re-render, no lost focus, no scroll
     jump while someone is trying the sets out.
   - The **content script** deliberately uses neither. Its shadow root is closed
     specifically so nothing on the host page can influence it, and inheriting
     custom properties from the page would hand that influence straight back. It
     receives `paletteId` in the resolve response and repaints in place, which
     preserves the pill's collapse state and any open list.

   The set arrives in `ResolvedTab` rather than being read from storage by the
   content script, so the pill's colors and its position always come from the same
   snapshot instead of disagreeing for a frame.

   The toolbar **icon** does not follow the setting; the icon **badge** does. The
   icon is the product mark, the badge is an environment indicator.

2. **Per-environment viewport frame**  ✅ done
   `EnvironmentDef.border`, opt in **per group, per environment**, drawing a 5px
   frame around the viewport in that environment's color.

   Per environment rather than per group or global because the point is usually to
   make ONE environment unmistakable (prod, or a shared staging box) while leaving
   the others alone. On every environment it stops being a signal and becomes
   wallpaper.

   It is a `border` on one fixed, zero-content box rather than four positioned
   edges: one element, one color to update, and no corner gaps to get wrong. It
   lives in the same closed shadow root as the pill, as a sibling of `.root` rather
   than a child, since `.root` is a flex column and a fixed-position flex item is a
   needless thing to reason about.

   `position: fixed` resolves against the viewport even though the host element is
   itself fixed in a corner, because only `transform`, `filter`, `will-change` and
   `contain` create a containing block for fixed descendants and nothing on the way
   down uses them. That is a real constraint on future CSS here, and it is commented
   in `indicator.css`.

   Three properties the e2e suite pins, because each would be a bug you would only
   notice later: `pointer-events: none` (it covers the whole viewport, so without it
   every page under a framed environment is unclickable), no layout effect (page
   content does not move or resize), and hidden in print. The color assertion reads
   the **rendered pixel** out of a screenshot via `tests/e2e/pixels.mjs`, because the
   shadow root is closed and there is no other honest way to check that a color
   actually reached the screen.

   The frame takes its color from `--es-bg` on the host, so it follows a palette
   change for free, and it deliberately does NOT follow the pill's collapse state:
   the pill is a label you glance at, the frame is an ambient reminder, and one that
   came and went would be worse than none.

   A group with the indicator hidden, or a tab dismissed with `Alt+Shift+H`, gets no
   frame either. Hidden means hidden; that escape hatch exists for clean screenshots
   and a frame would defeat it.

3. **Colored tab icon**  ✅ done
   `EnvironmentDef.tabIcon`, opt in per group, per environment: the tab's favicon is
   replaced with an environment mark, a rounded plate in the environment color
   carrying that environment's shape.

   **Not composited onto the site's own favicon**, which was the original plan and is
   the wrong answer. The tabs you cannot tell apart are prod, staging and local OF THE
   SAME SITE, and they all carry the SAME favicon. That shared icon IS the problem, so
   keeping it and adding a corner badge solves the wrong half, and a 6px badge on a
   16px icon is unreadable anyway. Replacing it outright is what makes the tab strip
   scannable. It is opt in precisely because it is destructive.

   **It composites onto the site's own favicon rather than replacing it.** Replacing was
   the first design and it was wrong. With a lot of tabs open the site's favicon is how you
   find the site at all; the environment is the SECOND question, not the first. A bar across
   the bottom 28% answers the second without destroying the answer to the first.

   28% of a 64px render is about four real pixels at tab size. Below that it stops reading
   as a color at a glance; much above it and it eats the part of the icon that identifies
   the site. The favicon is drawn at full size with the bar laid over it, rather than
   squashed into the space above it: squashing distorts artwork that is nearly always
   square, and shrinking wastes the pixels that do the identifying. Most favicons carry
   edge padding, so the band costs little.

   The bar is color only, with no glyph, because four pixels fits no shape. That is a real
   weakening of the rule that color is never the only signal, and it is why the pill and
   the toolbar badge keep the glyph and the label.

   **Two tiers, because a composite cannot always be delivered.** A composite must be
   generated at page load, so it can only be a `data:` URL, and `img-src 'self'` refuses
   those. Measured: `data:`, `blob:` from the page, and `blob:` from the extension origin
   are ALL refused, so there is no way to hand a generated image to such a page. So:

   - **Where the page permits it:** the site's favicon plus the environment bar.
   - **Where it does not:** the packaged solid mark from a `chrome-extension://` URL, which
     is exempt from page CSP. Twenty-four committed PNGs, six environments across four
     palettes, generated by `npm run marks`. `verify:dist` expands the manifest's
     `marks/*.png` glob from `allMarkFileNames()` in the source, so a new palette cannot
     ship with a tab icon that 404s.

   The packaged mark is written first and the composite upgrades over it, so a slow or
   missing favicon costs nothing: the tab is correctly colored throughout and simply gains
   the site's artwork a moment later.

   **Marks are vector paths, not the ENV_META glyph as text** (`core/marks.ts`). An SVG
   favicon renders in whatever font the platform resolves, and `■ ◆ ▲ ◇ ▣ ●` are exactly
   the characters that fall back to another font, shift off centre, or come out as tofu.
   Stored once as SVG path data and fed to `<path d>` for the preview and `new Path2D(d)`
   for the canvas, since Path2D accepts SVG path syntax.

   **Detecting the CSP is where this went wrong twice.** The first attempt loaded a data
   URL from the content script and checked whether it worked. It always worked: a content
   script runs in an isolated world and is exempt from the page's CSP for its own requests,
   while the browser's favicon fetch is not. That measured the wrong thing entirely.

   What it does instead: parse any `<meta http-equiv="Content-Security-Policy">`
   (`core/csp.ts`, pure and unit tested), and otherwise attempt the composite and listen for
   `securitypolicyviolation`. A header-delivered policy is unreadable from JavaScript, so
   one refusal is the only way to learn. The verdict is then cached per origin in
   `storage.session`, because a red "Refused to load the image" on the site's own console
   on EVERY page load reads as a bug in this extension. The service worker calls
   `setAccessLevel` so content scripts can reach that cache.

   One CSP subtlety worth pinning: `img-src *` does NOT permit a data URL. The wildcard
   matches network schemes only. Reading it as permissive would mean confidently writing a
   composite the browser throws away.

   **The visual treatment is not settled.** Shipped and working, but explicitly held open:
   replacing the favicon outright was rejected for losing the site's identity, and the bar
   is the first thing that fixed that, not a considered winner among alternatives. Whoever
   revisits this should know which levers are cheap:

   - **Bar thickness** is `BAR_FRACTION` in `core/marks.ts`, one number. The floor is
     legibility at four real pixels; the ceiling is eating the site's artwork.
   - **Bar position** is one `fillRect` in `content/composite.ts`. A left edge stripe, a
     top bar or a corner wedge are each a one line change, and a vertical stripe would
     survive on icons whose meaning lives at the bottom.
   - **A different treatment entirely** (tinting the icon, desaturating it, a border ring)
     is still just canvas work in that same function. Nothing above it assumes a bar.
   - **The two tier structure stays regardless.** Any generated treatment is a data URL and
     therefore refused under `img-src 'self'`, so a packaged fallback is required no matter
     what the treatment becomes.

   What should NOT be reopened without a reason: compositing rather than replacing, and the
   packaged fallback. Both were settled by evidence rather than taste.

   **Likely direction: a colored glyph prepended to `document.title` instead.** Not built,
   recorded so the reasoning is not re-derived. The appeal is real and it is not only
   simplicity:

   - **It is CSP immune.** A title is a string, not a subresource, so `img-src` never enters
     into it. That collapses the whole two tier design: no packaged fallback, no policy
     parsing, no `securitypolicyviolation` listener, no per origin verdict cache, no
     `web_accessible_resources` entry to justify to store review.
   - **The favicon is left completely alone**, which is the actual goal. The bar was a
     compromise toward it; this reaches it.
   - **Tab search matches on title.** Cmd+Shift+A for the environment glyph would list every
     prod tab, which the favicon approach cannot do at all.

   Three things to know before committing to it:

   1. **The color cannot follow the palette.** Colored squares exist only as emoji
      (U+1F7E5 onward), and their colors come from the platform font, not from us. There is
      no colored glyph whose color we control, and no styling in a title. So Default maps
      approximately, and Vivid, Subtle and Colorblind safe do not map at all. Either the
      palette setting stops applying to this surface, or the emoji stand in as a coarse
      signal and the mismatch is documented. This is the one genuine loss versus the bar.
   2. **SPAs rewrite `document.title` constantly**, so this needs the same MutationObserver
      and re-assert treatment `content/favicon.ts` already has, plus the same "our own write
      must not retrigger it" guard. That code is worth reading before writing this.
   3. **The title travels further than the tab.** Bookmarks, history entries and anything
      that copies the page title pick up the glyph. Analytics too, which the user has
      considered and accepted: this is used by a handful of internal people who are not
      valid analytics traffic anyway.

   Open when it happens: a separate per environment toggle, or a replacement for `tabIcon`?
   A separate one is kinder, since the two answer slightly different questions, and the
   favicon composite is genuinely better where a tab is identified by its icon.

   **The tab strip needed a different kind of test.** Every other check here asserts on
   the DOM, and for this feature that is not enough: a `<link rel="icon">` in the
   document proves we asked, not that Chrome decoded the image and drew it. The tab strip
   is browser UI and Playwright cannot screenshot it. `tests/e2e/tabstrip.mjs` drives a
   real windowed browser and photographs the X display instead, covering both the
   already-on-at-load flow and the switch-it-on-with-the-tab-open flow. It is manual (it
   needs a display and ImageMagick, and a person to look at the images) so it stays out
   of `test:e2e:all`.

   That gap was not hypothetical: this shipped with DOM-only coverage and the first
   report back was "I do not see the icon in the tab", which nothing in the suite could
   have answered either way.

   Two bugs found while building it, both worth remembering. The observer originally
   guarded on `ours.isConnected`, which silently skipped the exact case it existed for:
   a page swapping its favicon removes every icon link first, ours included, so we are
   already detached by the time the repair runs. And `paint()` referenced the favicon
   handle before its `let` declaration, a temporal dead zone crash TypeScript did not
   catch because it happens through a closure.

**Phase 7.6 — Open a link on another environment**  ✅ complete
Right-click a link, open it on any environment of the group that link belongs to. From the
competitive review: the entry point the pill structurally cannot be. A prod link pasted into
Slack, a ticket or an email sits on a page that is in no group, so there is no indicator to
click.

`contextMenus` is a permission with no install warning.

**The menu shape is forced by an API gap.** Chrome has no `onShown` event, so items cannot be
built from the link you right-clicked; everything must be registered in advance. What rescues
it is `targetUrlPatterns`, which filters items by the LINK's URL. So every group's
environments are registered up front and Chrome shows only the ones matching the link under
the cursor. In practice, right-clicking a link shows exactly the environments of the one group
it belongs to, and a link to somewhere unconfigured shows nothing of ours at all. The parent
item carries the union of its children's patterns so it disappears too.

Decisions worth keeping:

- **Always a new tab**, whatever `openInNewTabByDefault` says. You right-clicked a link on
  some other page; replacing that page is not what was asked for. This is the one case where
  the global default is clearly wrong.
- **The new tab is grouped, but the page you came from is not dragged in.** `groupTab` is
  called without an origin tab, because that page is usually Slack or a ticket.
- **The resolved group wins over the clicked item.** A match pattern cannot express a port, so
  an item from the group owning `localhost:3000` appears on a link to `localhost:9999`. The
  link is the truth about where it points; the item is trusted only for which environment was
  chosen.
- **A guarded environment is offered, and NOT decorated.** The first version appended the
  editor's ⚑ to it. The first person to see it asked what it meant, which is the whole answer:
  a context menu has no tooltip, so a bare glyph is a puzzle, and it promised a confirmation
  this path does not ask for. The guard is not weakened by leaving it out: it exists so you do
  not ACT on production by accident, and choosing an environment by name from a menu is not an
  accident. The page you land on carries the pill in production colours.
- **Choosing the environment the link is ALREADY on opens the link as it is.** Not an error
  case, a normal one: pages routinely link to their own production URL, so the link under your
  cursor is often already on the environment you pick. `switchTargets` omits the environment
  you are on, by design, so it has nothing to offer and the raw link is used. **The first
  release got this wrong and did nothing at all, silently**, which is exactly how it was
  reported. Every no-op path now logs why.
- **Registration is rebuilt wholesale**, not diffed. Chrome throws on a duplicate id rather
  than replacing, so `removeAll` first. A diff would be a second model of the same state
  waiting to disagree with the first.

Testing: Playwright cannot open or dismiss a native context menu, so the unit suite pins what
a click DOES (via a `contextMenus` fake that mirrors Chrome's duplicate-id throw), and
`test:tabstrip` photographs the real menu. Two things that cost time and are worth knowing: an
extension gets no context menu on `about:blank`, and since the OS grabs input for a native
menu, neither Escape nor a click dismisses it, so each capture needs its own page.

Deliberately not built: cycle-to-next-environment. Useful only with two environments, where
the switcher list is already one click.

**Phase 7.7 — Copy a link for another environment**  ✅ complete
Two surfaces, because they answer different questions. The switcher rows gain a copy control:
you are on a page and want to paste its staging link into Slack without leaving. The link
context menu gains "Copy <env> link" beside "Open on <env>": someone sent you a prod link and
you want the local equivalent on the clipboard rather than opened.

**One top-level context menu item, not one per action.** Chrome automatically wraps an
extension's top-level items under the extension name as soon as there is more than one, which
turned two parents into three levels of hovering. With a single parent, titled from
`getManifest().name` so it survives the rename, Chrome shows it directly and both actions sit
one hover away with a separator between them. Row titles put the verb first (`Open on Local`,
`Copy Local link`) so eight rows scan.

**Both paths resolve the URL through one function**, so a copied URL can never disagree with
where clicking would take you. In the worker that is `targetUrl()`, which the new `urlFor`
message also uses.

**Where the clipboard write happens differs by surface, and has to.** A service worker has no
document and cannot reach the clipboard.

- From the **context menu**, the write is injected into the page with
  `scripting.executeScript`. Chrome grants `activeTab` when a context menu item is activated,
  so this works on the Slack or ticket page the link came from even though that page is in no
  group and no host permission covers it.
- From the **switcher**, the content script writes it directly. That is the better place: it
  has a focused document, which `navigator.clipboard` requires and a worker cannot offer. It
  asks the worker for the URL via `urlFor` rather than being told target URLs up front, so the
  rule that the content script never holds destinations still holds.
- `navigator.clipboard` rejects on an unfocused document, which happens often enough right
  after a menu closes, so a detached-textarea `execCommand` fallback sits behind it.

**The row icons are inline SVG, not glyph characters.** At 10px a font fallback is the
difference between an icon and a smudge, which is the same reason the tab marks are drawn
paths. Copying flashes "Copied" in the row label, reusing the pattern the enter guard's
"Confirm" already established.

Testing: the fake's `executeScript` records the call rather than running the function, because
the injected code exists to touch `navigator.clipboard` and the DOM and running it under Node
would fail for reasons unrelated to the code. What matters at that boundary is which tab was
targeted and what was handed to it. The real write is asserted end to end by clicking the row
and reading the clipboard back, which needs `clipboard-read` granted to the Playwright context.

**Phase 7.8 — Agreed backlog**  ◐ planned 2026-07-31

Five passes, in this order. The ordering is driven by what would otherwise be written twice.

**A. Rename to WhichEnv.**  ✅ done
First, so no later pass writes the old name again. Mechanical but wide: manifest, package,
both UI headers, every doc, the custom element tag (`whichenv-indicator`), the
`data-whichenv` attribute, the `[WhichEnv]` log prefix, and the
strings the e2e suites assert. The context menu parent already reads `getManifest().name`, so
it follows for free. Kept alone deliberately: a rename diff should be reviewable as "only
strings changed", with no behaviour hidden in it. The repo directory keeps its current name
unless asked otherwise.

**B. Two small user-visible fixes.**  ✅ done
- Right-click open pulls the ORIGIN tab into the new tab group as well. `shouldAdoptOrigin`
  already refuses to touch a tab that is in a group of the user's own, so this only ever
  adopts an ungrouped one. Consequence to accept: open a prod link from Slack and the Slack
  tab joins that site's group.
- Drop the hex, contrast ratio and tab-group name from the Environment colors panel. The
  descriptions stay. Nothing is lost: the numbers live in `docs/palette-preview.html` where
  they belong, and the unit suite enforces the contrast floor whether or not it is displayed.

**C. A new group starts with production only.**  ✅ done
Local, dev and staging become add-buttons alongside preview and QA.

Bigger than it looks, because `DEFAULT_ENV_KEYS` currently does three jobs at once and they
now diverge. It has to become three lists:

| List | Contents | Used by |
|---|---|---|
| everything | all six | validation, ordering, palettes |
| what a blank group starts with | `prod` | `emptyDraft` |
| what create-from-tab guesses | local, dev, staging, prod | `guess.ts` |
| spare renameable slots | preview, qa | the colours panel's "spare slot" note |

Two regressions to avoid: `guess.ts:188` iterates the same constant, so without the split,
create-from-tab silently stops guessing anything but prod, which would gut the onboarding
feature. And `draftFromGuess` FILLS existing rows rather than adding them, so it must learn to
append a row for a guess whose environment is not present.

This pass also extracted a shared `createGroup` helper for the e2e suites, and a
`tests/helpers/groups.ts` builder for the unit ones. Ten unit files had grown their own copy of
"make a draft, then fill the rows I care about", which worked only while a blank draft contained
the four environments those tests wanted; the shared builder derives rows FROM the URLs instead,
so nothing depends on what a blank draft happens to contain.

Three things fell out of doing it that were not in the plan:

- **Adding an environment now inserts in pipeline order rather than appending.** Found because
  the e2e suite built local and dev onto the prod default and the switcher listed production
  first. Order is meaningful here, so the default should be the order people think in.
- **Adding an environment focuses its URL field.** With production alone by default, adding then
  typing is now the main way a group gets built.
- **Stable hooks on the remaining controls** (`data-add-env`, `data-action="remove"`,
  `data-toggle="enabled"`). Selecting the remove button by `.btn-icon` picked a disabled reorder
  button, which is the third time this session that a positional or class-based selector has
  broken on an unrelated change.

**C.1 Removing an environment replaces switching it off.**  ✅ done (2026-07-31)

The per-row on/off checkbox is gone. The × is the only control, and it switches the
environment off rather than splicing it out, keeping its base URL, aliases and label. Adding it
back restores all of that. A removed environment behaves exactly like a disabled one
everywhere downstream, which it is.

Two states collapsed into one. "Disabled but visible" and "deleted" were separate before, and
the difference between them was invisible: unchecking kept your URL, the × threw it away, and
nothing said so. Now there is one action and it is never destructive.

The model already supported this, which is why it was cheap: matching, the switcher, the
context menu, origin claims and cross-group collision checks all skip `enabled: false`
already, and `draftToGroup` and `groupToDraft` both retain disabled rows.

Two things that did need care:

- **A removed row must never block a save.** It is not rendered, so an error against it would
  be unfixable: no field to correct and a save button disabled for an invisible reason. The
  label-length check ran before the `enabled` guard and could do exactly that. It is now below
  it, and a test throws every kind of garbage at a removed row to prove nothing blocks.
- **Guessed siblings from create-from-tab were prefilled rows left switched off**, which is a
  state that can no longer be rendered. They moved onto the add-buttons instead, which now
  carry the guessed URL. That reads better than the old version: same information, one click to
  accept, and taking a guess is still deliberate, which was the property that mattered (a
  guessed hostname that does not exist would otherwise be a switch target going nowhere).

**D. Global defaults, per-group overrides, and indicator size.**  ✅ done (2026-07-31, v0.19.0)

**The ribbon was cut before it was built** (2026-07-31). Judged ugly and in the way, which is
the same complaint Environment Marker's own reviewers make about their ribbon: it covers page
content. Replaced by an indicator SIZE option, which serves the underlying want (make it
harder to miss) without putting a new object on the page. That is a straight simplification:
no new treatment, no third tri-state, and no ribbon-versus-pill corner geometry to resolve.

Settled: **two levels, not three.** Global default, overridable per group, and NOT per
environment. A group with the frame on frames every environment, each in its own colour, so
you still always know where you are. The cost, accepted knowingly: you can no longer frame
production only. Two tri-states per group beats up to twelve per group.

- New settings: frame width, indicator size, plus a default for each of frame and tab icon.
- `EnvGroup.indicator` gains `frame` and `tabIcon`, each `'default' | 'on' | 'off'`.
- `EnvironmentDef.border` and `.tabIcon` are removed, with a migration in `normalizeGroup`:
  any environment that had one turns the group's setting on, since that is the closest
  honest reading of what the user asked for.
- **Indicator size**: default is exactly today's, plus a large option with bigger text and
  more padding. Global, since the argument for a fixed corner applies equally to a fixed size.
  Everything in `indicator.css` that sets a size has to become relative to one custom
  property, or the two sizes drift apart.
- **Fixes the frame overlapping the indicator.** Already wrong at 5px, since the frame is
  `inset: 0` and the pill sits at `right: 0`; at a user-chosen width it would swallow the
  collapsed tab whole. The corner offsets have to be `calc()` against the frame width,
  published as a custom property. The size option makes this more pressing, not less: both
  dimensions now vary, so the offset has to be computed rather than guessed once.

Built as planned. Five things worth recording from doing it:

- **The resolver is its own module** (`core/indicator.ts`, `applyTristate` + `resolveIndicator`).
  Two callers need it and neither is testable where it sits: the worker builds the resolved
  shape per tab, and the content script has to answer "did this actually change?" after a
  settings change. Getting the second one wrong means either a stale frame or a pill that
  rebuilds itself under the cursor.
- **`undefined` has to mean `'default'`.** A group that overrides nothing stores no `indicator`
  object at all, so the absent case is the common case, not an edge one. Treating it as `'off'`
  would have made every group saved before this pass immune to the new defaults.
- **A stored tri-state beats a leftover legacy flag.** Migration reads any per environment
  `border`/`tabIcon` as the group's setting being `'on'`, but only when the group has not set
  its own. Without that ordering, a group whose switch was turned back off would have it
  reapplied on every load, and there would be no way to turn it off at all.
- **The content script re-resolves through the worker rather than duplicating the tri-state.**
  It sends a `resolve` on any settings change and remounts only if `frame` or `tabIcon` came
  back different. One place decides, and the pill keeps its collapse state and any open list
  for every other setting. Guarded by a `live` flag, because a second change (or a refresh
  push) can land while that round trip is in flight, and acting then would unmount whatever
  replaced this instance and remount a stale snapshot.
- **The frame clearance is asserted at every width, from pixels.** `--es-edge` is measured
  through the closed shadow root via `getBoundingClientRect`, and the frame's colour is sampled
  from a screenshot in the same loop, so "the pill clears the frame" cannot pass by there being
  no frame. Right gap 3/5/8/12/16 and top gap 15/17/20/24/28, exactly the width plus the
  existing 12px offset. The large pill measured 177.73×34 → 249.27×52 and returns to 177.73×34
  byte for byte, which is the guard on `normal` still being what shipped.

**D.1 Large got larger** (2026-07-31). The first attempt at large (14px text, 44px tall) was a
nudge, and a size option that reads as "slightly different" fails at the only job it has. Now
16px on 52px, half again the normal height. Two variables had to join the set to do it: the
pill's `max-width` and the group name's, which were the only caps on how wide it can get.
Leaving them fixed meant the large size bought bigger text and then truncated the group name to
pay for it, which is the opposite trade.

**E. Wildcard hosts.**  ✅ done (2026-07-31, v0.20.0)
A single leading `*.` on a base URL or alias host, resolved as a SUFFIX match and ranked below
every exact match. Deliberately not user-authored regex: a pattern supplied by a user runs
against every URL visited, and one bad backtracking case is a hang.

What it buys is hostnames that cannot be written down in advance, which is now the normal case
for preview deploys: `pr-482.preview.acme.dev`, `acme-git-pr-99-team.vercel.app`. Also wildcard
internal staging, and multi-region production without one group per region. Chrome match
patterns already accept `*.example.com`, so host permissions come along free.

Touches `url.ts` (parse and normalise a wildcard host), `match.ts` (suffix bucket in the index,
ranked after exact), `schema.ts` (validation and collision rules), `permissions.ts`, and the
port registry. `pattern` stays reserved for regex, for v2, only if anyone asks.

Built as planned. Seven things worth recording:

- **Chromium percent-encodes `*` in a hostname; Node does not.** `new URL('http://*.localhost')`
  gives hostname `*.localhost` under Node and `%2a.localhost` under Chromium. Reading the host
  back off the parsed URL therefore passed 44 unit tests and stored a host literally named
  `%2a.localhost` in the browser, matching nothing and reading as "the feature does not work".
  The star is now stripped before `URL` sees it and re-attached after. This is the second time
  this project has been caught by asserting on our own data structures instead of on what the
  browser resolved, and the fix was the same both times: a test in real Chromium.
- **A wildcard entry arrives downstream pinned to the tab's real host.** Translation requires
  `from.origin` to equal the tab's actual origin, so `lookup` returns the entry with
  `concreteBase(base, host)` substituted. That one substitution is why nothing else in the
  switcher, the copy action, the context menu or `translateUrl` needed changing at all.
- **A wildcard is match-only.** There is no way to know which host `*.preview.acme.dev` meant,
  so it is never a switch target. `switchTargets` skips it, and the editor says so as a warning
  rather than hiding the consequence.
- **New warning: only one switch target.** Several environments where only one has a fixed URL
  leaves every other row with an empty switcher. That reads as a bug rather than as a
  consequence of the config, so it is called out. Same for zero.
- **The star is part of the identity.** `*.acme.dev` and `acme.dev` get different match keys, so
  one group may hold both and neither overwrites the other in the index. Two groups claiming the
  identical wildcard still collide; a wildcard overlapping another group's exact host does NOT,
  because exact always wins and that is deterministic in both directions.
- **`*.dev` is rejected as too broad**, since it would match every site on the TLD and the
  permission prompt would say exactly that. Single-label suffixes are allowed only for the local
  conventions (`localhost`, `test`, `local`, `internal`), which never leave the machine. Malformed
  shapes (`**.a.com`, `*a.com`, `a.*.com`) are rejected by the STAR rather than by the `*.`
  prefix, otherwise they would store as ordinary hosts that silently never match.
- **Host permissions came free, and the port registry did not.** `patternFor` already produces
  `https://*.acme.dev/*`, which is valid Chrome syntax read the same way we read it (hence
  `hostUnderWildcard` covering the bare suffix, deliberately). But `loopbackClaims` keyed off
  `isLoopbackHost(host)`, which is false for `*.localhost`, so a local wildcard occupied a port
  the registry then offered to the next group as free.

**Not covered end to end, knowingly:** every wildcard except `*.localhost` needs a granted
subdomain permission, and Playwright cannot accept Chrome's permission dialog. The e2e block
uses `*.localhost:PORT`, which matches `localhost:PORT` (a wildcard covers its bare suffix) and
so runs under the statically granted loopback host. That still exercises the whole path: the
separate bucket, the suffix match, pinning to the real host, switching away, and exact-beats-
wildcard across two groups.

**F. Batched writes.**  ✅ done (2026-07-31, v0.20.1)

Not planned. Found by the first real use of the extension: importing ten groups converted from
a bookmarks export hit `MAX_WRITE_OPERATIONS_PER_MINUTE` and stored **seven of them**.

The bug is not the quota, it is the loop. `chrome.storage.sync` rejects the whole request when
the per-minute budget is spent, so a loop over `saveGroup` commits everything before the
failure and nothing after it. There is no record of where it stopped, and the user has agreed
to a specific plan that then only half happened. An import is the one operation in this product
where partial application is worst, because the preview is the whole contract.

- New `saveGroups` and `deleteGroups`. An import of any size is now at most three write
  operations (index-and-remove for deletions, one `set` for every group plus the index)
  instead of two per group. Measured in the browser by counting `storage.onChanged`: ten
  groups went from 10 events to 1.
- Sizes are checked for the whole batch BEFORE anything is written, so one oversized group
  cannot land the others and then fail.
- The failure message no longer passes Chrome's wording through. "This request exceeds the
  MAX_WRITE_OPERATIONS_PER_MINUTE quota" names an internal constant and omits the two things
  worth knowing: nothing was written, and it clears by itself in a minute.
- The fake chrome gained a write counter and a settable write limit, so the original failure is
  reproducible as a unit test. The test that matters asserts storage is left EMPTY when the
  quota refuses the batch, which is what makes a retry safe.

Worth noting what this was NOT: there is no write amplification. `listGroups` repairs a stale
index as a side effect of reading, and reads are triggered from change listeners, which looked
like a plausible feedback loop. Measured: zero index-only rewrites during an import. The
per-group loop was the whole story.

**Phase 8 — Store submission**
Privacy policy page, screenshots and promo tiles, listing copy, per permission
justifications, privacy disclosure form, upload and submit for review.

Phases 0 through 3 are the minimum viable version. Phases 4 and 5 make it
pleasant. Phases 6 through 8 make it publishable.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| URL translation subtly wrong on a real site (base paths, ports, SPA routing) | Pure functions with a broad unit suite, written in Phase 2 before any UI depends on them |
| Two projects sharing a localhost port cannot be told apart | Enforced unique ports via collision detection, made painless by the port registry (8.8). Documented as a deliberate constraint, not a bug. |
| Implicit vs explicit port treated as different environments | Normalize every origin to an explicit port at save time and at match time, in one shared `url.ts` |
| Indicator breaks or is broken by a host page's CSS | Closed shadow root, `all: initial`, fixed positioning, top frame only, plus a per site kill switch |
| `storage.sync` 8 KB per item limit | One key per group. A group exceeding 8 KB is pathological and gets a clear error. |
| Store review stalls on permissions | No `<all_urls>`, no `tabs`, per origin optional host permissions, written justifications prepared in Phase 8 |
| Permission prompt per group annoys users | Measure it in real use. `<all_urls>` stays available as a fallback, at a known review cost. |
| Service worker cold start delays the indicator | Match data cached in `chrome.storage.session`. Content script renders from cache and reconciles after. |
| Chrome tab group colors do not match the palette exactly | Documented nine color mapping in `palette.ts`, closest hue per env |
