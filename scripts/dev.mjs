import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureElectron } from './ensure-electron.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
await ensureElectron();
const vite = spawn(
  process.execPath,
  [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);
vite.on('close', async (code) => {
  if (code) return process.exit(code);
  const { default: executable } = await import('electron');
  const child = spawn(executable, [root], { stdio: 'inherit', windowsHide: true });
  child.on('close', (result) => process.exit(result || 0));
});
