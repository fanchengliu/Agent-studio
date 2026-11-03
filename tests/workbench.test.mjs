import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server/index.mjs';
import { nextScheduled } from '../server/schedules.mjs';
test('daily, weekly and once schedules use the chosen timezone and do not repeat completed one-offs', () => {
  const from = Date.parse('2026-11-03T00:30:00Z');
  assert.equal(
    new Date(
      nextScheduled({ kind: 'daily', time: '09:00', offsetMinutes: 480 }, from),
    ).toISOString(),
    '2026-11-03T01:00:00.000Z',
  );
  assert.equal(
    new Date(
      nextScheduled({ kind: 'daily', time: '08:00', offsetMinutes: 480 }, from),
    ).toISOString(),
    '2026-11-04T00:00:00.000Z',
  );
  assert.equal(
    new Date(
      nextScheduled({ kind: 'weekly', time: '09:00', days: [1], offsetMinutes: 480 }, from),
    ).toISOString(),
    '2026-11-09T01:00:00.000Z',
  );
  assert.equal(nextScheduled({ kind: 'once', at: '2026-11-02T09:00:00+08:00' }, from), null);
  assert.throws(() => nextScheduled({ kind: 'daily', time: '25:00' }, from), /超出/);
});
test('canvas edits, profiles, roles, binders, views, folders and backups preserve their contracts', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-workbench-'));
  const studio = await createStudio({ directory });
  t.after(async () => {
    await studio.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const call = async (route, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(studio.url + '/api' + route, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': studio.token },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { code: r.status, data: await r.json() };
  };
  const p = studio.store.state.projects[0];
  const a = (await call('/nodes', { projectId: p.id, type: 'agent', position: { x: 10, y: 10 } }))
    .data;
  const b = (await call('/nodes', { projectId: p.id, type: 'agent', position: { x: 300, y: 10 } }))
    .data;
  await call(`/nodes/${b.id}`, { locked: true }, 'PATCH');
  assert.equal(
    (
      await call('/canvas/positions', {
        projectId: p.id,
        positions: [
          { id: a.id, position: { x: 50, y: 50 } },
          { id: b.id, position: { x: 100, y: 100 } },
        ],
      })
    ).code,
    400,
  );
  assert.deepEqual(studio.store.node(a.id).position, { x: 10, y: 10 });
  await call(`/nodes/${b.id}`, { locked: false }, 'PATCH');
  assert.equal(
    (
      await call('/canvas/positions', {
        projectId: p.id,
        positions: [
          { id: a.id, position: { x: 50, y: 50 } },
          { id: b.id, position: { x: 100, y: 100 } },
        ],
      })
    ).code,
    200,
  );
  const group = (await call('/canvas/group', { projectId: p.id, nodeIds: [a.id, b.id] })).data;
  assert.equal(studio.store.node(a.id).groupId, group.id);
  await call('/canvas/ungroup', { id: group.id });
  assert.equal(studio.store.node(a.id).groupId, undefined);
  const n1 = (
      await call('/nodes', {
        projectId: p.id,
        type: 'note',
        data: { name: 'one', content: 'keep' },
      })
    ).data,
    n2 = (await call('/nodes', { projectId: p.id, type: 'note', data: { name: 'two' } })).data;
  assert.equal(
    (
      await call(
        `/nodes/${n1.id}`,
        { data: { content: 'stale' }, expectedContent: 'wrong' },
        'PATCH',
      )
    ).code,
    400,
  );
  assert.equal(studio.store.node(n1.id).data.content, 'keep');
  const binder = (await call('/binders', { projectId: p.id, nodeIds: [n1.id, n2.id] })).data;
  assert.equal(studio.store.node(n1.id).binderId, binder.id);
  await call(`/nodes/${binder.id}`, undefined, 'DELETE');
  assert.equal(studio.store.node(n1.id).data.content, 'keep');
  assert.equal(studio.store.node(n1.id).binderId, undefined);
  await call('/roles', { name: 'Reviewer', instructions: 'Review evidence' });
  assert.equal(studio.store.state.roles.length, 1);
  const account = (await call('/accounts', { provider: 'codex', name: 'Work' })).data;
  assert.ok(fs.statSync(account.configDirectory).isDirectory());
  await call(`/nodes/${a.id}`, { data: { sessionId: 'old', accountId: account.id } }, 'PATCH');
  assert.equal(studio.store.node(a.id).data.sessionId, null);
  const backup = await call('/backup/create', {});
  assert.equal(backup.code, 200);
  const exportData = (await call('/export')).data;
  assert.deepEqual(exportData.accounts, []);
  await call('/bookmarks', {
    projectId: p.id,
    slot: 1,
    name: 'Overview',
    view: { x: 30, y: 40, zoom: 0.5 },
  });
  assert.equal(studio.store.state.bookmarks[0].view.zoom, 0.5);
  const folder = (await call('/folders', { name: 'Research' })).data;
  await call(`/projects/${p.id}/folder`, { folderId: folder.id });
  assert.equal(studio.store.project(p.id).folderId, folder.id);
  const file = (
    await call('/attachments', {
      projectId: p.id,
      name: 'facts.txt',
      base64: Buffer.from('facts').toString('base64'),
    })
  ).data;
  assert.equal(fs.readFileSync(file.path, 'utf8'), 'facts');
  const relative = path.relative(p.directory, file.path);
  assert.equal(
    (
      await call(
        '/file',
        { projectId: p.id, path: relative, content: 'overwrite', expectedContent: 'old' },
        'PUT',
      )
    ).code,
    400,
  );
  assert.equal(fs.readFileSync(file.path, 'utf8'), 'facts');
  const schedule = (
    await call('/routines', {
      projectId: p.id,
      prompt: 'planned',
      enabled: false,
      schedule: { kind: 'daily', time: '09:00', offsetMinutes: 480 },
    })
  ).data;
  assert.equal(schedule.schedule.kind, 'daily');
  assert.equal(schedule.enabled, false);
  await call('/canvas/delete', { projectId: p.id, nodeIds: [a.id, b.id] });
  assert.ok(!studio.store.state.nodes.some((n) => n.id === a.id));
});
