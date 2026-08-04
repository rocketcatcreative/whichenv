import { resolve } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

const root = import.meta.dirname;

/**
 * Clears the directories this build owns before each run.
 *
 * Both builds write into the same dist/ with `emptyOutDir: false`, so neither can
 * be allowed to wipe the whole directory. Without this, `npm run dev` accumulates
 * every hashed asset it has ever produced: Chrome still loads the right files via
 * the manifest, but dist/ grows without bound and makes it genuinely hard to tell
 * which build output you are looking at.
 *
 * Each build prunes only its own output. This one owns assets/ and the HTML entry
 * directories; the content build owns content/.
 */
function pruneOwnOutputPlugin(): Plugin {
  return {
    name: 'whichenv:prune-own-output',
    buildStart() {
      for (const dir of ['dist/assets', 'dist/src']) {
        rmSync(resolve(root, dir), { recursive: true, force: true });
      }
    },
  };
}

/**
 * Copies manifest.json into the build output and stamps it with the version
 * from package.json, so the version lives in exactly one place.
 *
 * Deliberately hand rolled rather than pulling in @crxjs/vite-plugin: this is
 * the only manifest processing we need, and it keeps a third party dependency
 * out of the critical path of the build.
 */
function manifestPlugin(): Plugin {
  return {
    name: 'whichenv:manifest',
    buildStart() {
      // Rebuild the manifest when either file changes during `--watch`.
      this.addWatchFile(resolve(root, 'manifest.json'));
      this.addWatchFile(resolve(root, 'package.json'));
    },
    generateBundle() {
      const pkg = JSON.parse(
        readFileSync(resolve(root, 'package.json'), 'utf8'),
      ) as { version: string; description: string };
      const manifest = JSON.parse(
        readFileSync(resolve(root, 'manifest.json'), 'utf8'),
      ) as Record<string, unknown>;

      manifest.version = pkg.version;
      manifest.description ??= pkg.description;

      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  root,
  publicDir: resolve(root, 'public'),
  plugins: [pruneOwnOutputPlugin(), manifestPlugin()],
  resolve: {
    alias: {
      '@core': resolve(root, 'src/core'),
      '@ui': resolve(root, 'src/ui'),
    },
  },
  build: {
    outDir: 'dist',
    // The content script build writes into the same directory afterwards.
    emptyOutDir: false,
    target: 'chrome116',
    sourcemap: true,
    minify: process.env.NODE_ENV === 'production',
    rollupOptions: {
      input: {
        'service-worker': resolve(root, 'src/background/service-worker.ts'),
        popup: resolve(root, 'src/popup/index.html'),
        options: resolve(root, 'src/options/index.html'),
      },
      output: {
        // The service worker path is referenced by the manifest, so it must be
        // stable and unhashed. Everything else can be hashed normally.
        entryFileNames: (chunk) =>
          chunk.name === 'service-worker'
            ? 'service-worker.js'
            : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
