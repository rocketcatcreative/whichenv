# Security

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** A public issue about a browser
extension hands a working exploit to everyone who reads it, including before there is a fix.

Two private routes, either is fine:

1. **GitHub private advisory**, which is preferred because the discussion, the fix and the
   disclosure all stay in one place:
   [report a vulnerability](https://github.com/rocketcatcreative/whichenv/security/advisories/new)
2. **Email hello@rocketcatcreative.com** with `WhichEnv security` in the subject.

Useful things to include, as far as you have them: the extension version, your Chrome version, what
an attacker would gain, and the smallest set of steps that shows it. A proof of concept page is
welcome. As with bug reports, redact real internal or client hostnames; placeholders are fine.

You will get an acknowledgement within a few days. If a report is valid I will tell you what the fix
is and when it ships, and credit you in the release notes unless you would rather I did not.

## What is in scope

WhichEnv runs entirely in the browser and has no server, so the interesting surface is what it does
inside a page and what it can be tricked into doing:

- Escaping the closed shadow root the indicator renders in, or otherwise letting page script reach
  or alter extension state
- Getting the extension to inject into, or read from, an origin the user never granted
- Turning a crafted group configuration, an imported backup, or a crafted link into script
  execution or an unintended navigation
- Getting configuration out of `chrome.storage` to somewhere it should not go
- Any path by which a page could learn about environments or tabs it has no business knowing about

## What is not in scope

- **Reading the extension's own source, or the group configuration in `chrome.storage`, on a machine
  you already control.** Extension code is readable by design and that data is the user's own.
- **Configuration being visible to other things on your own machine.** Anything running with your
  user account can read your Chrome profile. That is the platform's boundary, not this extension's.
- **Chrome Sync replicating configuration** when the user has Chrome Sync enabled. That is Chrome
  moving the user's own data between the user's own browsers, and it is disclosed in the
  [privacy policy](https://rocketcatcreative.com/whichenv/privacy-policy/).
- Vulnerabilities in Chrome itself. Those belong to the
  [Chrome VRP](https://g.co/chrome/vrp).

## Supported versions

The version published on the Chrome Web Store is the one that gets fixes. There are no long term
support branches; a security fix ships as a new release and Chrome updates installed copies
automatically.

## Design notes that are relevant to a report

Three deliberate choices, so you know what is intended rather than accidental:

- **No host permissions are requested at install.** Access to a remote origin is requested only when
  a group naming that origin is saved, for those specific origins, and it is released again once no
  group refers to it.
- **The content script is not trusted with targets.** It knows nothing about groups, storage or URL
  rules, and it is never handed a destination URL. It reports the URL it is on plus which
  environment was picked; the service worker derives the destination. A compromised page therefore
  cannot ask it to navigate anywhere.
- **No remotely hosted code is ever fetched or executed**, as Manifest V3 requires. Everything that
  runs was reviewed as part of the published package.
