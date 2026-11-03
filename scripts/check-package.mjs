import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { killProcessTree } from '../server/system.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const build = JSON.parse(fs.readFileSync(path.join(root, 'release', 'latest-build.json'), 'utf8'));
if (!build.executable.startsWith(path.join(root, 'release') + path.sep))
  throw new Error('Unexpected build path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-portable-'));
const ready = path.join(dir, 'ready.json');
let child,
  browser,
  log = '';
try {
  const portServer = net.createServer();
  await new Promise((r) => portServer.listen(0, '127.0.0.1', r));
  const port = portServer.address().port;
  await new Promise((r) => portServer.close(r));
  const env = {
    ...process.env,
    STUDIO_TEST_DATA: path.join(dir, 'data'),
    STUDIO_TEST_READY: ready,
    STUDIO_HEADLESS_TEST: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(build.executable, ['--disable-gpu', `--remote-debugging-port=${port}`], {
    cwd: build.directory,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => {
    log += d;
  });
  child.stderr.on('data', (d) => {
    log += d;
  });
  for (let i = 0; i < 200 && !fs.existsSync(ready); i++) {
    if (child.exitCode !== null) throw new Error('Portable process exited: ' + log);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!fs.existsSync(ready)) throw new Error('Portable startup timeout: ' + log);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().startsWith('http://127.0.0.1:'));
  assert.ok(page);
  page.setDefaultTimeout(10000);
  await page.getByRole('heading', { name: /让你的 AI/ }).waitFor();
  await page.getByRole('button', { name: /多专长团队/ }).click();
  await page.locator('.agent-node').nth(5).waitFor();
  await page.screenshot({ path: path.join(root, 'test-results', 'portable-desktop.png') });
  await page.evaluate(() => {
    globalThis.__portableTerminal = '';
    window.addEventListener('studio-terminal', (e) => {
      globalThis.__portableTerminal += e.detail.data || '';
    });
  });
  await page.getByRole('button', { name: '打开本机终端', exact: true }).click();
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('Write-Output PORTABLE_TERMINAL_OK', { delay: 12 });
  await page.keyboard.press('Enter');
  let terminal = false;
  for (let i = 0; i < 60; i++) {
    terminal = await page.evaluate(() =>
      globalThis.__portableTerminal
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .split(/\r?\n/)
        .some((s) => s.trim() === 'PORTABLE_TERMINAL_OK'),
    );
    if (terminal) break;
    await page.waitForTimeout(100);
  }
  assert.equal(terminal, true);
  const record = {
    checkedAt: new Date().toISOString(),
    version: build.version,
    executable: build.executable,
    startup: true,
    sixAgentCanvas: true,
    packagedNativeTerminal: true,
    modelCalls: 0,
  };
  fs.writeFileSync(
    path.join(root, 'test-results', 'portable-check.json'),
    JSON.stringify(record, null, 2),
  );
  console.log(JSON.stringify(record, null, 2));
} finally {
  await browser?.close();
  if (child) {
    killProcessTree(child);
    if (child.exitCode === null) await new Promise((r) => child.once('close', r));
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
