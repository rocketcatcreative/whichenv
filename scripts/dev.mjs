import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runs both Vite builds in watch mode side by side. Written by hand instead of
 * pulling in a task runner, since it is about twenty lines and one less
 * dependency in the build.
 */
const builds = [
  { label: 'main   ', args: ['build', '--watch'] },
  { label: 'content', args: ['build', '--watch', '--config', 'vite.content.config.ts'] },
];

/**
 * Both watchers write into the same dist/, and each only regenerates its own
 * output. That means a build can be individually fine while dist/ as a whole is
 * missing something the manifest points at, and Chrome's error for that is just
 * "Could not load manifest". So verify once both have reported a successful
 * build, and again on every subsequent rebuild.
 */
const reported = new Set();
let verifyTimer;

function scheduleVerify() {
  if (reported.size < builds.length) return;
  clearTimeout(verifyTimer);
  // Debounced: a rebuild in one watcher often coincides with the other.
  verifyTimer = setTimeout(() => {
    const check = spawn('node', ['scripts/verify-dist.mjs'], { cwd: root, stdio: 'ignore' });
    check.on('exit', (code) => {
      console.log(
        code === 0
          ? '[verify ] dist/ is complete and loadable.'
          : '[verify ] dist/ is INCOMPLETE. Run `npm run verify:dist` to see what is missing.',
      );
    });
  }, 400);
}

const children = builds.map(({ label, args }) => {
  const child = spawn('npx', ['vite', ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const prefix = (stream) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        console.log(`[${label}] ${line}`);
        if (line.includes('built in')) {
          reported.add(label);
          scheduleVerify();
        }
      }
    });
  };

  prefix(child.stdout);
  prefix(child.stderr);

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[${label}] exited with code ${code}`);
      shutdown(code);
    }
  });

  return child;
});

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('Watching. Load the unpacked extension from dist/ and reload it after changes.');
