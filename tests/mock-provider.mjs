// Test transport fixture only. This file is excluded from the shipped application.
import { createInterface } from 'node:readline';
const protocol = process.argv[2];
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
if (protocol === 'jsonl') {
  send({ type: 'stream_event', event: { delta: { type: 'text_delta', text: '跨厂商输出正常' } } });
  send({ type: 'result', result: '跨厂商输出正常', session_id: 'test-json-session' });
  process.exit(0);
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (protocol === 'codex') {
    if (m.method === 'initialize') reply(m.id, { platformOs: 'windows' });
    if (m.method === 'thread/start' || m.method === 'thread/resume')
      reply(m.id, { thread: { id: 'thread-test-1' } });
    if (m.method === 'turn/start') {
      reply(m.id, { turn: { id: 'turn-test-1' } });
      send({
        id: 900,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'echo TEST' },
      });
    }
    if (m.id === 900 && m.result) {
      if (m.result.decision !== 'accept') {
        notify('turn/completed', {
          threadId: 'thread-test-1',
          turn: { status: 'failed', error: { message: 'permission declined' } },
        });
        return;
      }
      const encoded = Buffer.from(
        JSON.stringify({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-test-1', delta: '你好，真实协议测试 ✓' },
        }) + '\n',
      );
      const cut = encoded.indexOf(Buffer.from('你好')) + 1;
      process.stdout.write(encoded.subarray(0, cut));
      process.stdout.write(encoded.subarray(cut));
      notify('turn/completed', { threadId: 'thread-test-1', turn: { status: 'completed' } });
    }
  }
  if (protocol === 'acp') {
    if (m.method === 'initialize') reply(m.id, { protocolVersion: 1, agentCapabilities: {} });
    if (m.method === 'session/new') reply(m.id, { sessionId: 'acp-session' });
    if (m.method === 'session/prompt') {
      globalThis.promptId = m.id;
      send({
        jsonrpc: '2.0',
        id: 901,
        method: 'session/request_permission',
        params: {
          toolCall: { title: 'write file' },
          options: [
            { optionId: 'yes', kind: 'allow_once' },
            { optionId: 'no', kind: 'reject_once' },
          ],
        },
      });
    }
    if (m.id === 901 && m.result) {
      notify('session/update', {
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: m.result.outcome.optionId === 'yes' ? 'ACP 流式结果' : '操作被拒绝',
          },
        },
      });
      reply(globalThis.promptId, { stopReason: 'end_turn' });
    }
  }
  if (protocol === 'claude') {
    if (m.type === 'control_request' && m.request?.subtype === 'initialize')
      send({
        type: 'control_response',
        response: { subtype: 'success', request_id: m.request_id, response: {} },
      });
    if (m.type === 'user') {
      send({ type: 'system', subtype: 'init', session_id: 'claude-session' });
      send({
        type: 'control_request',
        request_id: 'permission-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Write',
          input: { file_path: 'test.txt', content: 'ok' },
        },
      });
    }
    if (m.type === 'control_response') {
      const allowed = m.response?.response?.behavior === 'allow';
      send({
        type: 'stream_event',
        event: { delta: { type: 'text_delta', text: allowed ? 'Claude 协议输出' : '写入已拒绝' } },
      });
      send({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-session',
        result: allowed ? 'Claude 协议输出' : '写入已拒绝',
      });
    }
  }
});
