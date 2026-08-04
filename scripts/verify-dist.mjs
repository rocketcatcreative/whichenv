import { readFile, access } from 'node:fs/promises';
import { resolve, dirname, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { allMarkFileNames } from '../src/core/marks.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

/**
 * Checks that a built extension is actually loadable.
 *
 * Two things can be missing, and Chrome reports both as an unhelpful
 * `Could not load manifest`:
 *
 *  1. A file the manifest points at.
 *  2. A file one of those files IMPORTS. The service worker and the HTML entries are
 *     code split, so they pull in chunks from assets/. A missing chunk is just as
 *     fatal and far easier to miss, since the manifest looks complete.
 *
 * So this walks the manifest first, then follows the static import graph out of every
 * JavaScript and HTML entry it found.
 */
const manifestPath = resolve(dist, 'manifest.json');
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch {
  console.error('FAIL  dist/manifest.json is missing or not valid JSON. Run `npm run build` first.');
  process.exit(1);
}

/** Files named directly by the manifest, mapped to why. */
const declared = new Map();
const declare = (path, why) => {
  if (path && !declared.has(path)) declared.set(path, why);
};

const declareIcons = (icons, why) => {
  if (icons) for (const path of Object.values(icons)) declare(path, why);
};

declareIcons(manifest.icons, 'manifest icons');
declareIcons(manifest.action?.default_icon, 'action icon');
declare(manifest.action?.default_popup, 'action popup');
declare(manifest.options_ui?.page, 'options page');
declare(manifest.options_page, 'options page');
declare(manifest.background?.service_worker, 'service worker');
for (const script of manifest.content_scripts ?? []) {
  for (const path of script.js ?? []) declare(path, 'content script');
  for (const path of script.css ?? []) declare(path, 'content script css');
}
for (const resource of manifest.web_accessible_resources ?? []) {
  for (const path of resource.resources ?? []) {
    if (!path.includes('*')) declare(path, 'web accessible resource');
  }
}

// The marks are declared in the manifest as a glob, so expand it from the source rather
// than waving it through. This is what stops a new palette, or a renamed environment,
// shipping with a tab icon that 404s: the file list comes from the same function the
// content script asks for a mark by name.
for (const path of allMarkFileNames()) declare(path, 'environment mark');

const exists = async (path) => {
  try {
    await access(resolve(dist, path));
    return true;
  } catch {
    return false;
  }
};

/** Which npm script is responsible for producing a given output path. */
function producedBy(path) {
  if (path.startsWith('content/')) return 'npm run build:content';
  if (path.startsWith('icons/')) return 'npm run icons, then npm run build:main';
  if (path.startsWith('marks/')) return 'npm run marks, then npm run build:main';
  return 'npm run build:main';
}

/** Static import specifiers in a JS file. Bundled output has no dynamic paths. */
function importsIn(source) {
  const specifiers = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]?.startsWith('.')) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** Local script and stylesheet references in an HTML file. */
function referencesIn(source) {
  const refs = [];
  for (const match of source.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    const value = match[1] ?? '';
    if (!value || /^(https?:|data:|#|mailto:|chrome)/.test(value)) continue;
    refs.push(value);
  }
  return refs;
}

/**
 * Resolves a specifier against the file that referenced it, as a dist-relative path.
 *
 * Vite emits ROOT-ABSOLUTE paths in HTML (`/assets/x.js`), which resolve against the
 * extension root at runtime, and relative ones in JS (`./assets/x.js`). Both have to
 * be understood, and treating the first kind as relative was silently reporting every
 * asset as missing from a perfectly good build.
 */
function resolveFrom(fromPath, specifier) {
  const absolute = specifier.startsWith('/')
    ? resolve(dist, `.${specifier}`)
    : resolve(dist, dirname(fromPath), specifier);
  return relative(dist, absolute).split(/[\\/]/).join(posix.sep);
}

const missing = [];
const seen = new Set();
const queue = [];

for (const [path, why] of declared) queue.push({ path, why });

let followed = 0;

while (queue.length > 0) {
  const { path, why } = queue.shift();
  if (seen.has(path)) continue;
  seen.add(path);

  if (!(await exists(path))) {
    missing.push({ path, why });
    continue;
  }

  if (!/\.(js|mjs|html)$/.test(path)) continue;

  let source;
  try {
    source = await readFile(resolve(dist, path), 'utf8');
  } catch {
    continue;
  }

  const children = path.endsWith('.html') ? referencesIn(source) : importsIn(source);
  for (const specifier of children) {
    const child = resolveFrom(path, specifier);
    if (seen.has(child)) continue;
    followed += 1;
    queue.push({ path: child, why: `imported by ${path}` });
  }
}

for (const path of [...seen].sort()) {
  const problem = missing.find((entry) => entry.path === path);
  if (problem) {
    console.error(`  MISS  ${path}   <- ${problem.why}; produced by ${producedBy(path)}`);
  } else {
    console.log(`  ok    ${path}`);
  }
}

const problems = [];
if (missing.length) {
  problems.push(
    `${missing.length} file(s) are missing from dist/. ` +
      `Chrome will refuse to load this build with "Could not load manifest".`,
  );
}
if (manifest.version === '0.0.0') {
  problems.push('manifest version is still 0.0.0, so the version stamp did not run');
}
if (manifest.manifest_version !== 3) {
  problems.push(`expected manifest_version 3, got ${manifest.manifest_version}`);
}

if (problems.length) {
  console.error(`\nFAIL\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

console.log(
  `\nOK  manifest v${manifest.version}, ${declared.size} declared + ${followed} imported file(s), all present.`,
);
