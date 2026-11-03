import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
for (const directory of ['server', 'electron', 'scripts', 'tests']) {
  for (const file of fs.readdirSync(path.join(root, directory)).filter((f) => f.endsWith('.mjs'))) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, directory, file)], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) {
      process.stderr.write(result.stderr);
      process.exit(1);
    }
    count++;
  }
}
console.log(`Syntax checked ${count} Node modules. JSX is checked by the Vite build.`);
