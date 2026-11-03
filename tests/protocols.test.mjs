import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runCodex, runACP, runClaude, runJsonl } from '../server/adapters.mjs';

const fixture = fileURLToPath(new URL('./mock-provider.mjs', import.meta.url));
function context(protocol, approval = true) {
  const chunks = [],
    sessions = [],
    approvals = [];
  return {
    provider: { executable: process.execPath },
    config: { prefixArgs: [fixture, protocol] },
    project: { directory: process.cwd() },
    node: { data: { mode: 'ask' } },
    signal: new AbortController().signal,
    instructions: '执行测试',
    prompt: '任务',
    bridge: { command: process.execPath, args: ['test'], env: {} },
    chunks,
    sessions,
    approvals,
    onDelta: (d) => chunks.push(d),
    onEvent: () => {},
    onSession: (s) => sessions.push(s),
    requestApproval: async (tool, input) => {
      approvals.push({ tool, input });
      return approval;
    },
  };
}
test('Codex JSON-RPC handles approval, split UTF-8 and final status', async () => {
  const ctx = context('codex');
  const result = await runCodex(ctx);
  assert.equal(result.output, '你好，真实协议测试 ✓');
  assert.equal(ctx.approvals.length, 1);
  assert.equal(ctx.sessions[0], 'thread-test-1');
});
test('Codex reports failed turn instead of claiming success after refusal', async () => {
  await assert.rejects(runCodex(context('codex', false)), /permission declined/);
});
test('ACP carries session and permission decisions', async () => {
  const ctx = context('acp');
  const result = await runACP(ctx);
  assert.equal(result.output, 'ACP 流式结果');
  assert.equal(result.sessionId, 'acp-session');
});
test('Claude stream-json controls allow request and result', async () => {
  const ctx = context('claude');
  const r = await runClaude(ctx);
  assert.equal(r.output, 'Claude 协议输出');
  assert.equal(ctx.approvals.length, 1);
});
test('Claude decline reaches child process without bypass flags', async () => {
  const r = await runClaude(context('claude', false));
  assert.equal(r.output, '写入已拒绝');
});
test('JSONL returns structured text and session', async () => {
  const r = await runJsonl(context('jsonl'));
  assert.equal(r.output, '跨厂商输出正常');
});
