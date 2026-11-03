import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server/index.mjs';
import { safePath } from '../server/system.mjs';
test('HTTP enforces local session, origin, mutation validation and persistence', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-studio-http-'));
  const studio = await createStudio({ directory: dir });
  t.after(async () => {
    await studio.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = async (route, body, method = body ? 'POST' : 'GET', extraHeaders = {}) => {
    const r = await fetch(studio.url + route, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Studio-Token': studio.token,
        ...extraHeaders,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json() };
  };
  assert.equal((await fetch(studio.url + '/api/state')).status, 401);
  assert.equal(
    (await request('/api/state', undefined, 'GET', { Origin: 'https://evil.example' })).status,
    403,
  );
  const state = (await request('/api/state')).data;
  const p = state.projects[0];
  assert.equal(state.nodes.length, 0);
  assert.equal((await request('/api/template', { projectId: p.id, kind: 'coding' })).status, 200);
  const after = (await request('/api/state')).data;
  assert.equal(after.nodes.filter((n) => n.type === 'agent').length, 3);
  const note = after.nodes.find((n) => n.type === 'note');
  assert.equal(
    (await request(`/api/nodes/${note.id}`, { data: { content: 'hello' } }, 'PATCH')).status,
    200,
  );
  assert.equal(
    (await request('/api/file', { projectId: p.id, path: '../escape.txt', content: 'bad' }, 'PUT'))
      .status,
    400,
  );
  assert.equal((await request('/api/settings', { maxConcurrency: 99 }, 'PATCH')).status, 400);
  assert.equal(
    (
      await request(
        '/api/file',
        { projectId: p.id, path: 'report.txt', content: '真实文件' },
        'PUT',
      )
    ).status,
    200,
  );
  assert.equal(fs.readFileSync(path.join(p.directory, 'report.txt'), 'utf8'), '真实文件');
  assert.equal((await request('/api/tasks', { nodeId: note.id, prompt: 'no' })).status, 400);
  assert.equal((await request('/api/bridge', { method: 'team_peers' })).status, 403);
});
test('filesystem tools reject traversal and symlink escape', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-studio-path-'));
  const root = path.join(base, 'project'),
    outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  assert.throws(() => safePath(root, '../outside'), /超出/);
  assert.throws(() => safePath(root, '.git/config', true), /不允许/);
  fs.symlinkSync(
    outside,
    path.join(root, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => safePath(root, 'link/new-file.txt', true), /链接/);
});
