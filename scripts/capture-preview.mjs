import { chromium } from '@playwright/test';
import { createStudio } from '../server/index.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-public-preview-'));
const studio = await createStudio({ directory });
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: /多专长团队/ }).click();
  await page.locator('.agent-node').nth(5).waitFor();
  await page.waitForTimeout(800);
  // Hide machine-specific file locations before making a public screenshot.
  await page.addStyleTag({ content: '.statusbar-path { visibility: hidden !important; }' });
  await page.mouse.move(220, 20);
  fs.mkdirSync(path.join(root, 'docs', 'images'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'docs', 'images', 'workspace.png') });
  console.log('Public preview captured without machine paths. No model tasks were run.');
} finally {
  await browser?.close();
  await studio.close();
  if (
    path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) &&
    path.basename(directory).startsWith('studio-public-preview-')
  )
    fs.rmSync(directory, { recursive: true, force: true });
}
