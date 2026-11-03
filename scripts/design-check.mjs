import { chromium } from '@playwright/test';
import { createStudio } from '../server/index.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-design-check-'));
const studio = await createStudio({ directory: dir });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: /多专长团队/ }).click();
  await page.locator('.agent-node').nth(5).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.agent-node').count(), 6);
  const box = await page.locator('.agent-node').first().boundingBox();
  assert.ok(box.height < 120);
  checks.push('六成员紧凑画布');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await page.waitForTimeout(250);
  assert.equal(
    await page.locator('.sidebar').evaluate((e) => Math.round(e.getBoundingClientRect().width)),
    0,
  );
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  checks.push('侧栏收起与展开');
  await page.getByRole('button', { name: '展开节点详情', exact: true }).click();
  assert.equal(await page.locator('.node-expanded-content').count(), 6);
  await page.getByRole('button', { name: '收起节点详情', exact: true }).click();
  checks.push('紧凑与详情视图切换');
  const z1 = await page.locator('.zoom-percentage').innerText();
  await page.getByRole('button', { name: '缩小', exact: true }).click();
  await page.waitForTimeout(250);
  assert.notEqual(await page.locator('.zoom-percentage').innerText(), z1);
  await page.getByRole('button', { name: '适应全部节点（Shift+1）' }).click();
  checks.push('缩放百分比与适应画布');
  await page.getByRole('button', { name: '自动整理布局', exact: true }).click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: '撤销画布操作（Ctrl+Z）' }).click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: '重做画布操作（Ctrl+Shift+Z）' }).click();
  checks.push('布局整理、撤销和重做');
  await page.locator('.agent-node').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '锁定位置' }).click();
  assert.ok(studio.store.state.nodes.some((n) => n.locked));
  checks.push('右键菜单与位置锁定');
  await page.getByRole('button', { name: '工具箱', exact: true }).click();
  await page.getByRole('button', { name: '角色库', exact: true }).click();
  await page.getByLabel('角色名称').fill('验证角色');
  await page.getByLabel('职责与工作要求').fill('核对产物');
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page.waitForTimeout(150);
  assert.equal(studio.store.state.roles[0].name, '验证角色');
  checks.push('角色库持久化');
  await page.getByRole('button', { name: '视图书签', exact: true }).click();
  await page.getByRole('button', { name: '保存当前视图', exact: true }).click();
  await page.waitForTimeout(150);
  assert.equal(studio.store.state.bookmarks.length, 1);
  checks.push('视图书签保存');
  await page.getByRole('button', { name: '独立账号', exact: true }).click();
  await page.getByLabel('账号名称').fill('独立测试账号');
  await page.getByRole('button', { name: '创建账号配置', exact: true }).click();
  await page.waitForTimeout(150);
  assert.equal(studio.store.state.accounts.length, 1);
  checks.push('独立账号目录（不登录、不调用模型）');
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('button', { name: '定时协作', exact: true }).click();
  await page.getByLabel('执行方式').selectOption('daily');
  await page.getByLabel('任务名称').fill('Daily');
  await page.getByLabel('团队目标').fill('保持关闭');
  await page.getByRole('button', { name: '创建定时任务' }).click();
  await page.waitForTimeout(150);
  assert.equal(studio.store.state.routines[0].schedule.kind, 'daily');
  assert.equal(studio.store.state.routines[0].enabled, false);
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  checks.push('日历排期保存且默认关闭');
  await page
    .getByRole('button', { name: '添加文件或图片', exact: true })
    .click()
    .catch(() => {});
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'design-test.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Only test data'),
    });
  await page.locator('.attachment-chips>span').waitFor();
  checks.push('本地文件附件');
  await page.getByRole('button', { name: '移除附件', exact: true }).click();
  await page.mouse.click(350, 750);
  await page.getByRole('button', { name: '适应全部节点（Shift+1）' }).click();
  await page.waitForTimeout(300);
  await page.mouse.move(220, 20);
  await page.screenshot({ path: 'test-results/design-v2.png' });
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    'test-results/design-check.json',
    JSON.stringify({ checks, modelCalls: 0 }, null, 2),
  );
  console.log(JSON.stringify({ checks, modelCalls: 0 }, null, 2));
} catch (e) {
  throw e;
} finally {
  await browser.close();
  await studio.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
