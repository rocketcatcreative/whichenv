/**
 * Turns a Chrome bookmarks export into an importable WhichEnv config.
 *
 * One-off, kept because it will be wanted again: a folder per site with an
 * "Environments" subfolder is a common way people already organise this, and it maps onto
 * a group almost exactly.
 *
 * Everything is built through the real `draftToGroup` and checked with the real
 * `validateDraft`, so the output cannot contain a shape the extension would then have to
 * salvage on import. Anything that does not validate is reported and dropped rather than
 * written out half-right.
 *
 * Usage:
 *   node --import ./scripts/ts-resolve.mjs scripts/from-bookmarks.mjs <bookmarks.html> [out.json]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  draftToGroup,
  emptyDraft,
  newEnvironmentDraft,
  validateDraft,
  summarize,
} from '../src/core/schema.ts';
import { byPipelineOrder } from '../src/core/palette.ts';
import { parseBaseUrl } from '../src/core/url.ts';

const [, , inputPath, outputPath = 'whichenv-from-bookmarks.json'] = process.argv;
if (!inputPath) {
  console.error('Usage: from-bookmarks.mjs <bookmarks.html> [out.json]');
  process.exit(1);
}

/**
 * How a bookmark name maps onto an environment slot.
 *
 * Ordered, and first match wins, so "Staging - Hostinger" is tested against the explicit
 * second-staging rules before the generic /stag/ rule can claim it.
 */
const RULES = [
  { test: /^local/i, key: 'local' },
  { test: /^dev/i, key: 'dev' },
  { test: /hostinger/i, key: 'qa', label: 'Staging Hostinger' },
  { test: /stag|stg/i, key: 'staging' },
  { test: /^prod/i, key: 'prod' },
  { test: /^preview/i, key: 'preview' },
  { test: /^qa|^uat/i, key: 'qa' },
];

const notes = [];

/** Parses the bookmark file into [{ title, environments: [{ name, href }] }]. */
function readBookmarks(html) {
  const sites = [];
  let current = null;
  let inEnvironments = false;

  for (const line of html.split('\n')) {
    const folder = /<H3[^>]*>([^<]*)<\/H3>/i.exec(line);
    if (folder) {
      const name = decode(folder[1]);
      if (/^environments$/i.test(name)) {
        inEnvironments = true;
      } else {
        // A top level folder is a site. Depth is not tracked: this format nests only one
        // level here, and the "Environments" marker is what actually delimits the links
        // we care about.
        current = { title: name, environments: [] };
        sites.push(current);
        inEnvironments = false;
      }
      continue;
    }

    // Closing tags end the environments block, so sibling links (Figma, GitHub) that come
    // after it are not mistaken for environments.
    if (/<\/DL>/i.test(line)) {
      inEnvironments = false;
      continue;
    }

    const link = /<A HREF="([^"]*)"[^>]*>([^<]*)<\/A>/i.exec(line);
    if (link && current && inEnvironments) {
      current.environments.push({ href: decode(link[1]), name: decode(link[2]) });
    }
  }

  return sites.filter((site) => site.environments.length > 0);
}

/** "Staging - WPEngine" -> "Staging WPEngine", inside the 24 character label limit. */
function cleanLabel(name) {
  return name.replace(/\s*[-–—:]\s*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24);
}

function decode(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Reduces a bookmarked URL to something usable as a base URL.
 *
 * Bookmarks are pages, not origins, so a deep link with a query string is normal and has
 * to be cut back. `parseBaseUrl` would otherwise keep `/wp-admin/post.php` as the base
 * path, which would match that one page and nothing else: technically valid, silently
 * useless. A path that looks like a FILE is dropped; a plain directory-ish path is kept,
 * since that is how a base path is legitimately written.
 */
function toBaseUrl(href, siteTitle, envName) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.username || url.password) {
    notes.push(
      `${siteTitle} / ${envName}: basic auth credentials (${url.username}:***) were dropped. ` +
        `A base URL is scheme, host, port and path only. Chrome will still prompt, or keep the ` +
        `bookmark for the one-click version.`,
    );
  }

  let path = url.pathname.replace(/\/+$/, '');
  if (/\.[a-z0-9]{2,4}$/i.test(path) || url.search) {
    notes.push(
      `${siteTitle} / ${envName}: reduced "${url.pathname}${url.search}" to the origin. ` +
        `That bookmark points at a page, not at the root the environment shares.`,
    );
    path = '';
  }

  return `${url.protocol}//${url.host}${path}`;
}

const sites = readBookmarks(await readFile(inputPath, 'utf8'));
const now = Date.now();
const groups = [];

for (const site of sites) {
  const draft = emptyDraft(randomUUID());
  draft.title = site.title;
  draft.environments = [];

  const used = new Set();
  /** Bookmark name per accepted environment, for labelling a second staging. */
  const sourceNames = new Map();

  for (const bookmark of site.environments) {
    const rule = RULES.find((candidate) => candidate.test.test(bookmark.name));
    if (!rule) {
      notes.push(`${site.title} / ${bookmark.name}: no environment slot matched that name. Skipped.`);
      continue;
    }

    const baseUrl = toBaseUrl(bookmark.href, site.title, bookmark.name);
    if (!baseUrl) {
      notes.push(`${site.title} / ${bookmark.name}: "${bookmark.href}" is not a URL. Skipped.`);
      continue;
    }

    const parsed = parseBaseUrl(baseUrl);
    if (!parsed.ok) {
      notes.push(`${site.title} / ${bookmark.name}: ${parsed.error.message} Skipped.`);
      continue;
    }

    // Two bookmarks on the same URL cannot be two environments: the matcher would have no
    // way to tell them apart, and validation blocks the save. Report and drop the later one.
    const clash = draft.environments.find(
      (existing) => parseBaseUrl(existing.baseUrl).ok &&
        parseBaseUrl(existing.baseUrl).value.matchKey === parsed.value.matchKey,
    );
    if (clash) {
      notes.push(
        `${site.title} / ${bookmark.name}: same URL as "${clash.label || clash.key}" ` +
          `(${parsed.value.display}). Two environments cannot share a URL, so this one was skipped.`,
      );
      continue;
    }

    if (used.has(rule.key)) {
      notes.push(
        `${site.title} / ${bookmark.name}: the ${rule.key} slot was already taken. Skipped.`,
      );
      continue;
    }
    used.add(rule.key);

    const env = newEnvironmentDraft(rule.key);
    env.baseUrl = parsed.value.normalized;
    if (rule.label) env.label = rule.label;
    sourceNames.set(rule.key, bookmark.name);
    draft.environments.push(env);
  }

  // A group with a SECOND staging needs both of them labelled, or the amber one reads as
  // "the" staging and the other as an unrelated QA box. Only done where there are two: the
  // groups with one staging are clearer left on the default label.
  if (used.has('staging') && used.has('qa')) {
    const staging = draft.environments.find((env) => env.key === 'staging');
    if (staging && !staging.label) {
      staging.label = cleanLabel(sourceNames.get('staging') ?? 'Staging');
    }
  }

  // Pipeline order, lowest risk first, since it drives the switcher list and the numeric
  // shortcuts.
  draft.environments.sort((a, b) => byPipelineOrder(a.key, b.key));

  if (draft.environments.length === 0) {
    notes.push(`${site.title}: nothing usable found. Group skipped.`);
    continue;
  }

  const result = validateDraft(draft, groups.map(summarize));
  if (!result.canSave) {
    notes.push(
      `${site.title}: skipped, it does not validate. ` +
        result.issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => issue.message)
          .join(' '),
    );
    continue;
  }

  groups.push(draftToGroup(draft, now));
}

// A bare array rather than a full exported config. Import accepts both, and an array
// carries no `settings` block, so this cannot quietly overwrite settings already chosen.
await writeFile(outputPath, `${JSON.stringify(groups, null, 2)}\n`);

console.log(`\n${groups.length} group(s) written to ${outputPath}\n`);
for (const group of groups) {
  const envs = group.environments
    .map((env) => `${env.label ?? env.key}=${parseBaseUrl(env.baseUrl).value.display}`)
    .join('  ');
  console.log(`  ${group.title.padEnd(16)} ${envs}`);
}

if (notes.length > 0) {
  console.log(`\n${notes.length} thing(s) worth knowing:\n`);
  for (const note of notes) console.log(`  - ${note}`);
}
