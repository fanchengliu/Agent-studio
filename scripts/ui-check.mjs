import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { killProcessTree } from '../server/system.mjs';
import { createStudio } from '../server/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-studio-ui-'));
const artifacts = path.join(root, 'test-results');
fs.mkdirSync(artifacts, { recursive: true });
const checks = [];
let browser, desktop, desktopProcess, studio, debugPage, portalFixture;
const driver = async (ctx) => {
  ctx.onDelta('测试进程正在验证任务传递。');
  await new Promise((r) => setTimeout(r, 120));
  return {
    output: `传输测试产物 · ${ctx.node.data.name}\n\n此内容来自独立测试驱动，未调用任何 AI 账户。`,
  };
};
try {
  studio = await createStudio({
    directory: path.join(data, 'web'),
    drivers: { codex: driver, claude: driver },
  });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({
    viewport: { width: 1510, height: 980 },
    deviceScaleFactor: 1,
  });
  debugPage = page;
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('UI console:', m.text().slice(0, 2000));
  });
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(studio.launchUrl);
  await page.getByRole('heading', { name: /让你的 AI/ }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'welcome.png') });
  checks.push('本地入口与首次启动界面');
  await page.getByRole('button', { name: /开发协作/ }).click();
  await page.locator('.agent-node').nth(2).waitFor();
  assert.equal(await page.locator('.agent-node').count(), 3);
  checks.push('创建三节点团队与共享便签');
  await page.locator('.agent-node').first().click();
  await page.getByRole('button', { name: '节点设置', exact: true }).last().click();
  await page.getByLabel('节点名称').fill('规划负责人');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForTimeout(200);
  assert.equal(studio.store.state.nodes.find((n) => n.type === 'agent').data.name, '规划负责人');
  checks.push('节点角色编辑与持久化');
  await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  // Explicit test configuration: only fixtures can run during this browser check.
  studio.store.state.settings.providers.claude = { executable: process.execPath };
  studio.store.state.settings.providers.codex = { executable: process.execPath };
  studio.store.changed(true);
  await page.locator('.goal-input').fill('验证规划、实现和审查的任务交接');
  await page.getByRole('button', { name: '派发任务', exact: true }).click();
  for (let i = 0; i < 100 && !studio.store.state.runs.some((r) => r.status === 'completed'); i++)
    await page.waitForTimeout(50);
  assert.equal(studio.store.state.runs.at(-1)?.status, 'completed');
  assert.equal(studio.store.state.tasks.length, 3);
  checks.push('完整团队流程与上游输出传递（测试进程）');
  await page.locator('.view-tabs button').nth(1).click();
  await page.locator('.task-table-row').first().waitFor();
  assert.equal(await page.locator('.task-table-row').count(), 3);
  checks.push('任务列表与会话回看');
  await page.getByRole('button', { name: '连接与套餐入口' }).click();
  await page.getByRole('dialog', { name: '连接你的 AI 工具' }).waitFor();
  await page.getByRole('button', { name: 'DeepSeek', exact: true }).last().click();
  await page.getByLabel('API 地址').waitFor();
  await page.getByRole('button', { name: '关闭对话框' }).click();
  checks.push('多 Provider 连接配置');
  await page.getByRole('button', { name: '定时协作', exact: true }).click();
  await page.getByLabel('任务名称').fill('测试定时记录');
  await page.getByLabel('团队目标').fill('仅保存记录，保持关闭');
  await page.getByRole('button', { name: '创建定时任务' }).click();
  await page.waitForTimeout(150);
  assert.equal(studio.store.state.routines.at(-1).enabled, false);
  await page.getByRole('button', { name: '关闭对话框' }).click();
  checks.push('定时任务默认关闭');
  assert.deepEqual(errors, []);
  await browser.close();
  browser = null;
  await studio.close();
  studio = null;
  const readyFile = path.join(data, 'desktop-ready.json');
  const env = {
    ...process.env,
    STUDIO_TEST_DATA: path.join(data, 'desktop'),
    STUDIO_HEADLESS_TEST: '1',
    STUDIO_TEST_READY: readyFile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const reservation = net.createServer();
  await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
  const cdpPort = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  let desktopLog = '';
  desktopProcess = spawn(
    path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['--disable-gpu', `--remote-debugging-port=${cdpPort}`, root],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  desktopProcess.stdout.on('data', (d) => {
    desktopLog += d;
  });
  desktopProcess.stderr.on('data', (d) => {
    desktopLog += d;
  });
  for (let i = 0; i < 200 && !fs.existsSync(readyFile); i++) {
    if (desktopProcess.exitCode !== null) throw new Error('桌面进程退出：' + desktopLog);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!fs.existsSync(readyFile)) throw new Error('桌面启动未就绪：' + desktopLog);
  desktop = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const window = desktop
    .contexts()[0]
    .pages()
    .find((p) => p.url().startsWith('http://127.0.0.1:'));
  assert.ok(window, 'desktop renderer must exist');
  await window.getByRole('heading', { name: /让你的 AI/ }).waitFor();
  await window.getByRole('button', { name: /开发协作/ }).click();
  await window.locator('.agent-node').nth(2).waitFor();
  await window.waitForTimeout(300);
  await window.screenshot({ path: path.join(artifacts, 'desktop.png') });
  checks.push('Windows 桌面窗口与真实工具检测');
  await window.evaluate(() => {
    globalThis.__terminalCheck = '';
    window.addEventListener('studio-terminal', (e) => {
      globalThis.__terminalCheck += e.detail.data || '';
    });
  });
  await window.getByRole('button', { name: '打开本机终端', exact: true }).click();
  await window.locator('.terminal-panel').waitFor();
  await window.locator('.xterm-helper-textarea').focus();
  await window.keyboard.type('Write-Output STUDIO_DESKTOP_PTY_OK', { delay: 15 });
  await window.keyboard.press('Enter');
  let terminalVerified = false;
  for (let i = 0; i < 60; i++) {
    terminalVerified = await window.evaluate(() =>
      (globalThis.__terminalCheck || '')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .split(/\r?\n/)
        .some((line) => line.trim() === 'STUDIO_DESKTOP_PTY_OK'),
    );
    if (terminalVerified) break;
    await window.waitForTimeout(100);
  }
  assert.equal(terminalVerified, true, 'native terminal must return the actual command output');
  await window.getByRole('button', { name: '收起终端' }).click();
  checks.push('Windows ConPTY 交互终端启动与输入');
  const nativeState = await window.evaluate(() => fetch('/api/state').then((r) => r.json()));
  const codexNode = nativeState.nodes.find((n) => n.data.provider === 'codex');
  await window.evaluate(
    async ({ executable, fixture, nodeId }) => {
      const session = await fetch('/api/session').then((r) => r.json());
      const call = (url, data, method = 'POST') =>
        fetch('/api' + url, {
          method,
          headers: { 'Content-Type': 'application/json', 'X-Studio-Token': session.token },
          body: JSON.stringify(data),
        }).then((r) => r.json());
      await call(
        '/settings',
        { provider: { id: 'codex', executable, prefixArgs: [fixture, 'codex'] } },
        'PATCH',
      );
      await call('/tasks', {
        nodeId,
        prompt: '协议测试子进程，请求一次权限并返回文本；无模型调用。',
      });
    },
    {
      executable: process.execPath,
      fixture: path.join(root, 'tests', 'mock-provider.mjs'),
      nodeId: codexNode.id,
    },
  );
  await window.getByRole('dialog', { name: '确认这项操作' }).waitFor();
  await window.getByRole('button', { name: '允许本次操作' }).click();
  let completed = false;
  for (let i = 0; i < 60; i++) {
    completed = await window.evaluate(() =>
      fetch('/api/state')
        .then((r) => r.json())
        .then((s) => s.tasks.at(-1)?.status === 'completed'),
    );
    if (completed) break;
    await window.waitForTimeout(100);
  }
  assert.equal(completed, true);
  checks.push('桌面真实子进程 → 权限对话框 → 结果回传（测试协议）');
  portalFixture = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><title>Portal verification</title><button id="go" onclick="document.querySelector(\'#result\').textContent=\'PORTAL_CLICK_OK\'">Verify click</button><p id="result">Waiting</p>',
    );
  });
  await new Promise((r) => portalFixture.listen(0, '127.0.0.1', r));
  const portalResult = await window.evaluate(
    async ({ projectId, url }) => {
      const session = await fetch('/api/session').then((r) => r.json());
      const call = async (route, data) => {
        const r = await fetch('/api' + route, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Studio-Token': session.token },
          body: JSON.stringify(data),
        });
        const result = await r.json();
        if (!r.ok) throw new Error(result.error);
        return result;
      };
      const node = await call('/nodes', {
        projectId,
        type: 'portal',
        data: { name: '测试浏览器', url },
      });
      const snapshot = await call(`/portal/${node.id}`, { action: 'snapshot' });
      const ref = snapshot.elements.find((e) => e.label === 'Verify click')?.ref;
      const clicked = await call(`/portal/${node.id}`, { action: 'click', ref });
      const image = await call(`/portal/${node.id}`, { action: 'screenshot' });
      return {
        title: snapshot.title,
        clicked: clicked.text.includes('PORTAL_CLICK_OK'),
        screenshot: image.image.startsWith('data:image/png;base64,'),
      };
    },
    {
      projectId: nativeState.projects[0].id,
      url: `http://127.0.0.1:${portalFixture.address().port}`,
    },
  );
  assert.equal(portalResult.clicked, true);
  assert.equal(portalResult.screenshot, true);
  checks.push('桌面浏览器快照、真实点击与截图');
  await desktop.close();
  desktop = null;
  killProcessTree(desktopProcess);
  await new Promise((r) =>
    desktopProcess.exitCode !== null ? r() : desktopProcess.once('close', r),
  );
  desktopProcess = null;
  fs.writeFileSync(
    path.join(artifacts, 'ui-check.json'),
    JSON.stringify({ checkedAt: new Date().toISOString(), checks, errors, modelCalls: 0 }, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        checks,
        modelCalls: 0,
        screenshots: ['test-results/welcome.png', 'test-results/desktop.png'],
      },
      null,
      2,
    ),
  );
} catch (e) {
  if (debugPage && !debugPage.isClosed()) {
    console.log('UI failure page:', (await debugPage.locator('body').innerText()).slice(0, 4000));
    await debugPage.screenshot({ path: path.join(artifacts, 'failure.png') });
  }
  throw e;
} finally {
  await browser?.close();
  await desktop?.close();
  if (desktopProcess) {
    killProcessTree(desktopProcess);
    await new Promise((r) =>
      desktopProcess.exitCode !== null ? r() : desktopProcess.once('close', r),
    );
  }
  await studio?.close();
  if (portalFixture) await new Promise((r) => portalFixture.close(r));
  fs.rmSync(data, { recursive: true, force: true });
}
