import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree } from '../server/system.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const smoke = path.join(root, 'test-results', 'electron-smoke.cjs');
fs.writeFileSync(
  smoke,
  `const {app,BrowserWindow}=require('electron');console.log('MODULE_LOADED');app.whenReady().then(async()=>{console.log('ELECTRON_READY');let w=new BrowserWindow({show:false});console.log('WINDOW_CREATED');await w.loadURL('data:text/html,hello');console.log('PAGE_LOADED');app.quit()});`,
);
for (const [label, entry] of [
  ['smoke', smoke],
  ['app', root],
]) {
  const env = {
    ...process.env,
    STUDIO_TEST_DATA: path.join(root, 'test-results', 'diagnostic-data'),
    STUDIO_HEADLESS_TEST: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['--disable-gpu', entry],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (d) => {
    output += d;
  });
  child.stderr.on('data', (d) => {
    output += d;
  });
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      killProcessTree(child);
      resolve();
    }, 12000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  console.log(JSON.stringify({ label, output: output.slice(-6000) }));
}
