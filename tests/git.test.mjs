import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server/index.mjs';
import { git } from '../server/system.mjs';
test('worktree creates an isolated branch and merges committed results', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-studio-git-'));
  const projectDir = path.join(directory, 'project');
  fs.mkdirSync(projectDir);
  await git(projectDir, ['init', '-b', 'main']);
  await git(projectDir, ['config', 'user.name', 'Studio Test']);
  await git(projectDir, ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(projectDir, 'seed.txt'), 'base\n');
  await git(projectDir, ['add', '--', 'seed.txt']);
  await git(projectDir, ['commit', '-m', 'seed']);
  const studio = await createStudio({ directory: path.join(directory, 'app') });
  t.after(async () => {
    await studio.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const call = async (route, body) => {
    const r = await fetch(studio.url + '/api' + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': studio.token },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  const p = (await call('/projects', { name: '真实 Git 测试', directory: projectDir })).data;
  const layer = (await call('/worktrees', { projectId: p.id, name: 'feature' })).data;
  assert.ok(layer.directory && layer.branch);
  assert.equal(fs.existsSync(path.join(layer.directory, '.git')), true);
  fs.writeFileSync(path.join(layer.directory, 'feature.txt'), 'worktree result');
  await git(layer.directory, ['add', '--', 'feature.txt']);
  await git(layer.directory, ['commit', '-m', 'feature']);
  assert.equal(fs.existsSync(path.join(projectDir, 'feature.txt')), false);
  const result = await call(`/worktrees/${layer.id}/land`, {});
  assert.equal(result.status, 200);
  assert.equal(fs.readFileSync(path.join(projectDir, 'feature.txt'), 'utf8'), 'worktree result');
  fs.writeFileSync(path.join(projectDir, 'uncommitted.txt'), 'preserve me');
  const blocked = await call(`/worktrees/${layer.id}/land`, {});
  assert.equal(blocked.status, 400);
  assert.equal(fs.readFileSync(path.join(projectDir, 'uncommitted.txt'), 'utf8'), 'preserve me');
});
