import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, makeNode } from '../server/store.mjs';
import { Runtime } from '../server/runtime.mjs';
const wait = async (f, timeout = 3000) => {
  const start = Date.now();
  while (!f()) {
    if (Date.now() - start > timeout) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};
function setup(t, driver) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-studio-runtime-'));
  const store = new Store(directory);
  store.state.settings.providers.codex = { executable: process.execPath };
  const runtime = new Runtime(store, { drivers: { codex: driver } });
  t.after(() => {
    runtime.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const project = store.state.projects[0];
  return {
    directory,
    store,
    runtime,
    project,
    add: (name) => {
      const n = makeNode(project.id, 'agent', { name });
      store.state.nodes.push(n);
      return n;
    },
  };
}
test('workflow passes actual upstream output and waits for dependencies', async (t) => {
  const calls = [];
  const s = setup(t, async (ctx) => {
    calls.push(ctx.prompt);
    return { output: '产物-' + ctx.node.data.name };
  });
  const a = s.add('planner'),
    b = s.add('builder'),
    c = s.add('reviewer');
  s.store.state.edges.push({ source: a.id, target: b.id }, { source: b.id, target: c.id });
  const run = s.runtime.workflow(s.project.id, '做一个功能');
  await wait(() => run.status !== 'running');
  assert.equal(run.status, 'completed');
  assert.equal(calls.length, 3);
  assert.match(calls[1], /产物-planner/);
  assert.match(calls[2], /产物-builder/);
});
test('failed upstream blocks downstream and never substitutes fake output', async (t) => {
  let count = 0;
  const s = setup(t, async () => {
    count++;
    throw new Error('real failure');
  });
  const a = s.add('a'),
    b = s.add('b');
  s.store.state.edges.push({ source: a.id, target: b.id });
  const run = s.runtime.workflow(s.project.id, 'task');
  await wait(() => run.status !== 'running');
  assert.equal(run.status, 'failed');
  assert.equal(count, 1);
  assert.equal(s.store.state.tasks.find((t) => t.nodeId === b.id).status, 'blocked');
});
test('cycle is rejected before executing any model', (t) => {
  const s = setup(t, async () => ({ output: '' }));
  const a = s.add('a'),
    b = s.add('b');
  s.store.state.edges.push({ source: a.id, target: b.id }, { source: b.id, target: a.id });
  assert.throws(() => s.runtime.workflow(s.project.id, 'cycle'), /循环/);
});
test('same node is serial and global concurrency limit applies', async (t) => {
  let active = 0,
    peak = 0;
  const s = setup(t, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
    return { output: 'ok' };
  });
  s.store.state.settings.maxConcurrency = 1;
  const a = s.add('a'),
    b = s.add('b');
  s.runtime.createTask(a.id, '1');
  s.runtime.createTask(a.id, '2');
  s.runtime.createTask(b.id, '3');
  await wait(() => s.store.state.tasks.every((t) => t.status === 'completed'));
  assert.equal(peak, 1);
});
test('cancel rejects pending approval and leaves no running task', async (t) => {
  const s = setup(t, async (ctx) => {
    await ctx.requestApproval('write', {});
    if (ctx.signal.aborted) throw new Error('stopped');
    return { output: 'ok' };
  });
  const a = s.add('a');
  const task = s.runtime.createTask(a.id, 'approval');
  await wait(() => task.status === 'waiting_approval');
  s.runtime.stop(task.id);
  await wait(() => !s.runtime.active.size);
  assert.equal(task.status, 'cancelled');
  assert.equal(s.runtime.approvals.size, 0);
});
test('pending task and session output survive disk reload as interrupted', (t) => {
  const s = setup(t, async () => ({ output: '' }));
  const a = s.add('a');
  s.store.state.tasks.push({
    id: 'interrupted-task',
    nodeId: a.id,
    status: 'running',
    output: 'partial output',
  });
  s.store.flush();
  const reloaded = new Store(s.directory);
  assert.equal(reloaded.state.tasks[0].status, 'interrupted');
  assert.equal(reloaded.state.tasks[0].output, 'partial output');
  reloaded.close();
});
test('bridge rejects unconnected peers and out-of-scope task reads', (t) => {
  const s = setup(t, async () => ({ output: '' }));
  const a = s.add('a'),
    b = s.add('b');
  s.runtime.capabilities.set('test-token', { nodeId: a.id, taskId: 'parent', sent: 0 });
  assert.throws(
    () => s.runtime.bridgeCall('test-token', 'team_send', { target: b.id, prompt: 'task' }),
    /已连接/,
  );
  assert.throws(() => s.runtime.bridgeCall('other-token', 'team_peers'), /凭据/);
});
