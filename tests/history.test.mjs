import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server/index.mjs';
test('canvas undo/redo restores deletion and keeps unrelated agent/session state', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-history-'));
  const s = await createStudio({ directory: dir });
  t.after(async () => {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = async (url, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(s.url + '/api' + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': s.token },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json() };
  };
  const projectId = s.store.state.projects[0].id;
  const a = (await call('/nodes', { projectId, type: 'agent', position: { x: 10, y: 10 } })).data;
  await call('/canvas/positions', {
    projectId,
    positions: [{ id: a.id, position: { x: 90, y: 80 } }],
  });
  s.store.node(a.id).data.sessionId = 'live-session';
  assert.equal((await call('/canvas/undo', { projectId })).status, 200);
  assert.deepEqual(s.store.node(a.id).position, { x: 10, y: 10 });
  assert.equal(s.store.node(a.id).data.sessionId, 'live-session');
  await call('/canvas/undo', { projectId, redo: true });
  assert.deepEqual(s.store.node(a.id).position, { x: 90, y: 80 });
  await call(`/nodes/${a.id}`, undefined, 'DELETE');
  assert.equal(s.store.state.nodes.length, 0);
  await call('/canvas/undo', { projectId });
  assert.equal(s.store.node(a.id).data.sessionId, 'live-session');
  await call('/canvas/undo', { projectId, redo: true });
  assert.equal(s.store.state.nodes.length, 0);
});
