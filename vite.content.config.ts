import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = import.meta.dirname;

/**
 * Content scripts declared in the manifest are not ES modules, so they need a
 * self contained IIFE bundle with a stable filename. That is a different output
 * format from the rest of the extension, which is why this is a second Vite build
 * rather than another entry in the main one.
 *
 * Deliberately NOT using `build.lib`. Library mode's `fileName` hook is
 * documented to return a file name, and returning a path with a separator in it
 * ("content/indicator.js") worked but was relying on unspecified behaviour that
 * differs across Vite and Rollup versions. Setting `entryFileNames` on the output
 * directly is the supported way to control the output path, and it is explicit
 * about what lands where.
 *
 * A content script must be ONE self-contained file, since it cannot import chunks at
 * runtime. That falls out of having a single input, which disables code splitting.
 * `npm run verify:dist` follows the import graph of every built entry, so if this ever
 * did start emitting chunks the build would fail rather than producing something
 * Chrome refuses to load.
 */
export default defineConfig({
  root,
  publicDir: false,
  resolve: {
    alias: {
      '@core': resolve(root, 'src/core'),
      '@ui': resolve(root, 'src/ui'),
    },
  },
  build: {
    outDir: 'dist',
    // The main build writes into the same directory, so neither may empty it.
    emptyOutDir: false,
    target: 'chrome116',
    sourcemap: true,
    minify: process.env.NODE_ENV === 'production',
    rollupOptions: {
      input: { indicator: resolve(root, 'src/content/indicator.ts') },
      output: {
        format: 'iife',
        name: 'EnvironmentSwitcherIndicator',
        // Must match the path in manifest.json's content_scripts.
        entryFileNames: 'content/indicator.js',
        assetFileNames: 'content/[name][extname]',
      },
    },
  },
});
