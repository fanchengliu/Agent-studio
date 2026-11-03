import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server/index.mjs';
import { JsonRpc } from '../server/rpc.mjs';
import { spawnCommand, ROOT } from '../server/system.mjs';
test('saved teams clone independently and API keys never enter exported state', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-teams-'));
  const studio = await createStudio({ directory });
  t.after(async () => {
    await studio.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const call = async (route, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(studio.url + '/api' + route, {
      method,
      headers: { 'X-Studio-Token': studio.token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  const project = studio.store.state.projects[0];
  await call('/template', { projectId: project.id, kind: 'coding' });
  const node = studio.store.state.nodes.find((n) => n.type === 'agent');
  await call(`/nodes/${node.id}`, { data: { sessionId: 'do-not-clone-session' } }, 'PATCH');
  const arrangement = await call('/arrangements', { projectId: project.id, name: '团队模板' });
  const second = await call('/projects', { name: '另一个项目' });
  await call(`/arrangements/${arrangement.id}/apply`, { projectId: second.id });
  const copies = studio.store.state.nodes.filter((n) => n.projectId === second.id);
  assert.equal(copies.length, 4);
  assert.ok(copies.every((n) => n.data.sessionId === null));
  assert.ok(copies.every((n) => n.id !== node.id));
  await call(
    '/settings',
    { provider: { id: 'deepseek', apiKey: 'fake-test-key-not-a-real-credential' } },
    'PATCH',
  );
  const exported = await call('/export');
  assert.equal(JSON.stringify(exported).includes('fake-test-key'), false);
  assert.deepEqual(exported.settings.providers, {});
  assert.equal(exported.arrangements.length, 1);
  await call('/import', exported);
  assert.equal(studio.store.state.arrangements.length, 1);
  assert.ok(studio.store.state.routines.every((r) => !r.enabled));
});
test('stdio MCP tools forward scoped calls to the local collaboration bridge', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-'));
  const studio = await createStudio({ directory });
  let rpc;
  t.after(async () => {
    rpc?.close();
    await studio.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const p = studio.store.state.projects[0];
  const node = { id: 'node-a', projectId: p.id, type: 'agent', data: { name: 'a' } },
    peer = {
      id: 'node-b',
      projectId: p.id,
      type: 'agent',
      data: { name: 'b', role: 'review', provider: 'codex' },
    };
  studio.store.state.nodes.push(node, peer);
  studio.store.state.edges.push({ source: node.id, target: peer.id });
  studio.runtime.capabilities.set('test-only-capability', {
    nodeId: node.id,
    taskId: 'test',
    sent: 0,
  });
  rpc = new JsonRpc(
    spawnCommand(process.execPath, [path.join(ROOT, 'server', 'mcp.mjs')], {
      env: { STUDIO_BRIDGE_URL: studio.url, STUDIO_BRIDGE_TOKEN: 'test-only-capability' },
    }),
  );
  const init = await rpc.call('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(init.serverInfo.name, 'agent-studio-team');
  const tools = await rpc.call('tools/list');
  assert.ok(tools.tools.some((t) => t.name === 'browser_snapshot'));
  const response = await rpc.call('tools/call', { name: 'team_peers', arguments: {} });
  assert.equal(JSON.parse(response.content[0].text)[0].id, peer.id);
  studio.runtime.capabilities.clear();
  const denied = await rpc.call('tools/call', { name: 'team_peers', arguments: {} });
  assert.equal(denied.isError, true);
});
