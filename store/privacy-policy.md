# WhichEnv privacy policy

**Effective August 3, 2026. Last updated August 3, 2026.**

WhichEnv is a Chrome extension that shows which environment a browser tab is on and switches
between a site's environments at the same path. It is published by Rocket Cat Creative.

**WhichEnv does not collect your data.** Nothing it holds is sent to Rocket Cat Creative or to
anyone else, because it makes no network requests of its own at all. There are no analytics, no
tracking, no advertising, and no third-party services in it.

The rest of this page says precisely what it stores, what it reads, and what it never does, in
enough detail to be checked rather than taken on trust.

---

## What WhichEnv stores

One thing: the configuration you enter yourself.

- **Environment groups.** The title and optional description you give a group, and for each
  environment in it, the base URL, any aliases, an optional display label, and its per-group
  options.
- **Your settings.** Indicator position and size, color set, collapse timing, how a switch
  opens, and the page-marker defaults.

This is written to `chrome.storage.sync`, which is storage provided by Chrome itself. If you have
Chrome Sync enabled, Chrome replicates it across the browsers signed in to your Google account, in
the same way it syncs your bookmarks. That replication is performed by Chrome and governed by
[Google's privacy policy](https://policies.google.com/privacy), not by us. If Chrome Sync is off,
it never leaves the machine.

Rocket Cat Creative has no server, no account system, and no way to read any of it.

We disclose this even though it stays inside your browser, because Chrome Web Store policy
requires extensions to explain how they handle user data whether or not that data is transmitted
anywhere.

---

## What WhichEnv reads and does not keep

To do its job the extension has to look at a few things. It looks, decides, and discards. None of
the following is written to storage, logged, or transmitted.

| What it reads | Why | What happens to it |
|---|---|---|
| The URL of a tab | To decide whether that URL belongs to a group you configured, and which environment it is | Compared in memory against your groups; the answer is a color and a label. The URL itself is not retained |
| The URL of a link you right-click | Only when you use the WhichEnv item in the context menu, to determine the same link on another environment | Used for that one action, then gone |
| The page's existing icon links | Only when the tab-icon marker is turned on, to draw your site's own favicon with a color bar under it | Read from the page, composited in the tab, restored when you turn the marker off |

No browsing history is assembled. There is no record of where you have been, no timestamps, and no
counters. Closing a tab ends the extension's knowledge of it.

---

## Permissions, and why each one exists

| Permission | Why WhichEnv needs it |
|---|---|
| `storage` | To save your groups and settings. This is the only thing it stores |
| `activeTab` | To act on the tab you are on when you click the toolbar icon, press a shortcut, or use the context menu. It grants access only to that tab, only at that moment |
| `scripting` | To place the on-page indicator on origins you have granted, and to copy a URL to your clipboard when you use the copy action |
| `contextMenus` | To add the right-click items that open or copy a link on another environment |
| `tabGroups` | To gather tabs opened by a switch into a Chrome tab group named after the site, if you leave that setting on |
| `http://localhost/*`, `http://127.0.0.1/*` | Granted at install so local development works immediately. These addresses are your own machine |

### Access to other sites

WhichEnv asks for **no website access when you install it**. Access to a remote site is requested
only when you save a group that mentions that site, it is requested for those specific origins
rather than for all sites, and it is released again automatically once no group refers to it.

You can decline. The group still saves and switching still works; the extension simply cannot draw
its indicator on that site until you allow it.

---

## What WhichEnv never does

- No data of any kind is sold or transferred to third parties.
- No data is used or transferred for advertising, personalization, retargeting, or assessing
  creditworthiness.
- No data is used for any purpose unrelated to showing and switching environments.
- No human at Rocket Cat Creative reads your data, because no data reaches us.
- No remotely hosted code is fetched or executed. Everything that runs was reviewed as part of the
  published package, as Manifest V3 requires.

---

## Deleting your data

- Delete a single group from the extension's settings page, and it is gone.
- Uninstall WhichEnv and Chrome removes everything it stored.
- If Chrome Sync replicated it, clearing synced data is done through your Google account, since
  that copy belongs to Chrome rather than to us.

---

## Changes to this policy

If the way WhichEnv handles data ever changes, this page will be updated with a new date and the
change will be described in the extension's release notes on the Chrome Web Store, so it is
visible to people who have already installed it. Material changes to data handling will be
disclosed before they take effect.

---

## Contact

Questions about this policy or about WhichEnv:

**hello@rocketcatcreative.com**
Rocket Cat Creative
[https://rocketcatcreative.com](https://rocketcatcreative.com)
