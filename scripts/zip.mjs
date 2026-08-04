/**
 * Packages dist/ into the zip the Chrome Web Store wants, then checks it.
 *
 * The checks matter because a bad upload is slow to find out about: the store accepts
 * the file, then a reviewer or a user hits the problem days later. Everything here is
 * something that has bitten real extensions:
 *
 *  - **Source maps.** They are 3x the size of the code and expose the whole source
 *    tree. Useful locally, not something to publish.
 *  - **A stale manifest version.** Uploading a version the store already has is
 *    rejected, and uploading 0.0.0 means the stamp did not run.
 *  - **Remote code.** The store forbids loading script from off-package. A CDN URL that
 *    crept into a bundle is grounds for rejection.
 *  - **A missing file.** Same class of problem verify-dist catches, checked again here
 *    against the actual archive rather than the directory.
 */
import { spawnSync } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const zipPath = resolve(root, 'dist.zip');

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

await rm(zipPath, { force: true });

const zipped = spawnSync(
  'zip',
  ['-r', '-9', '-q', zipPath, '.', '-x', '*.map', '-x', '.DS_Store', '-x', '__MACOSX/*'],
  { cwd: dist, stdio: 'inherit' },
);

if (zipped.status !== 0) {
  console.error('FAIL  zip failed. Is the `zip` command available on this system?');
  process.exit(zipped.status ?? 1);
}

// ------------------------------------------------------------------ inspect it
const listing = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
if (listing.status !== 0) {
  console.error('FAIL  could not read the archive back. Is `unzip` available?');
  process.exit(1);
}

const entries = listing.stdout
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.endsWith('/'));

const problems = [];
const notes = [];

const maps = entries.filter((entry) => entry.endsWith('.map'));
if (maps.length) problems.push(`${maps.length} source map(s) are in the archive`);

const sources = entries.filter((entry) => /\.(ts|tsx|scss|md)$/.test(entry));
if (sources.length) problems.push(`source files are in the archive: ${sources.join(', ')}`);

if (!entries.includes('manifest.json')) problems.push('manifest.json is not in the archive');

// Every file the manifest and the import graph need. verify-dist already checked the
// directory; this checks the archive, which is what actually gets uploaded.
const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  problems.push(`manifest says v${manifest.version} but package.json says v${pkg.version}`);
}
if (manifest.version === '0.0.0') problems.push('version is still 0.0.0');

const required = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...Object.values(manifest.icons ?? {}),
  ...(manifest.content_scripts ?? []).flatMap((script) => script.js ?? []),
].filter(Boolean);

for (const path of required) {
  if (!entries.includes(path)) problems.push(`${path} is referenced by the manifest but not in the archive`);
}

// Remote code is grounds for rejection. Only look at what ships, not the maps.
const scripts = entries.filter((entry) => entry.endsWith('.js'));
for (const path of scripts) {
  const source = await readFile(resolve(dist, path), 'utf8');
  const remote = source.match(/["'`]https?:\/\/[^"'`\s]+["'`]/g) ?? [];
  // Documentation links and example hostnames in strings are fine; a fetch or an
  // import is not.
  const executable = remote.filter((match) =>
    /\b(import|importScripts|src\s*=|fetch)\b/.test(
      source.slice(Math.max(0, source.indexOf(match) - 40), source.indexOf(match)),
    ),
  );
  if (executable.length) {
    problems.push(`${path} appears to load remote code: ${executable.slice(0, 2).join(', ')}`);
  }
}

const { size } = await stat(zipPath);
if (size > 10 * 1024 * 1024) notes.push('over 10 MB, which is larger than this needs to be');

for (const entry of entries.sort()) console.log(`  ${entry}`);

if (problems.length) {
  console.error(`\nFAIL\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

console.log(
  `\nOK  dist.zip  v${pkg.version}  ${(size / 1024).toFixed(1)} KB  ${entries.length} files, no maps, no remote code.`,
);
for (const note of notes) console.log(`    note: ${note}`);
