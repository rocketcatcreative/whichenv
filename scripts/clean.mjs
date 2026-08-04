import { rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const target of ['dist', 'dist.zip']) {
  await rm(resolve(root, target), { recursive: true, force: true });
}

console.log('cleaned dist/');
