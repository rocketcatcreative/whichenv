/**
 * Lets build scripts import `src/` modules directly.
 *
 * Node 22 strips TypeScript types on its own, so the code runs, but its resolver still
 * will not turn `./palette` into `./palette.ts`. The extension is omitted throughout
 * `src/` because that is what the bundler expects, and changing the whole source tree so
 * one reporting script can read it would be the wrong way round.
 *
 * Only used by scripts, never by anything that ships. Register it with:
 *
 *   node --import ./scripts/ts-resolve.mjs scripts/whatever.mjs
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(
  // The hook itself, as a data URL, so this stays one file.
  'data:text/javascript,' +
    encodeURIComponent(`
      import { existsSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';

      export async function resolve(specifier, context, next) {
        // Only relative, extensionless specifiers, and only when the .ts file is really
        // there. Anything else behaves exactly as Node would on its own.
        if (specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier)) {
          try {
            const url = new URL(specifier + '.ts', context.parentURL);
            if (existsSync(fileURLToPath(url))) {
              return next(specifier + '.ts', context);
            }
          } catch {
            // Not resolvable as a URL. Fall through.
          }
        }
        return next(specifier, context);
      }
    `),
  pathToFileURL('./'),
);
