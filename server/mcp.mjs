import { version } from './version.mjs';
import { createInterface } from 'node:readline';
const definitions = [
  ['team_peers', '列出本节点已连接的队友', {}],
  [
    'team_send',
    '异步派任务给已连接的队友，返回 taskId',
    { target: { type: 'string' }, prompt: { type: 'string' } },
  ],
  ['team_task', '查询自己派发或接收的任务结果', { taskId: { type: 'string' } }],
  ['team_note_read', '读取连接的共享便签', { noteId: { type: 'string' } }],
  [
    'team_note_write',
    '写入连接的共享便签',
    { noteId: { type: 'string' }, content: { type: 'string' } },
  ],
  [
    'team_recruit',
    '仅主控节点可以添加已安装的 agent 作为队友',
    { name: { type: 'string' }, provider: { type: 'string' }, role: { type: 'string' } },
  ],
  [
    'browser_snapshot',
    '读取已连接浏览器页面的正文与可交互元素编号',
    { portalId: { type: 'string' } },
  ],
  [
    'browser_navigate',
    '在已连接的浏览器中打开地址',
    { portalId: { type: 'string' }, url: { type: 'string' } },
  ],
  [
    'browser_click',
    '点击页面快照中的元素编号',
    { portalId: { type: 'string' }, ref: { type: 'string' } },
  ],
  [
    'browser_type',
    '在页面元素中输入文本',
    { portalId: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' } },
  ],
].map(([name, description, properties]) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
}));
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
async function handle(m) {
  if (m.id === undefined) return;
  try {
    let result;
    if (m.method === 'initialize')
      result = {
        protocolVersion: m.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-studio-team', version },
      };
    else if (m.method === 'ping') result = {};
    else if (m.method === 'tools/list') result = { tools: definitions };
    else if (m.method === 'tools/call') {
      const url = process.env.STUDIO_BRIDGE_URL;
      const token = process.env.STUDIO_BRIDGE_TOKEN;
      if (!url || !token) throw new Error('请从 Agent Studio 启动此协作工具');
      if (!definitions.some((t) => t.name === m.params?.name)) throw new Error('未知工具');
      const r = await fetch(url + '/api/bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Studio-Bridge': token },
        body: JSON.stringify({ method: m.params.name, args: m.params.arguments || {} }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '协作请求失败');
      result = { content: [{ type: 'text', text: JSON.stringify(data.result) }] };
    } else {
      send({ id: m.id, error: { code: -32601, message: 'Unknown method' } });
      return;
    }
    send({ id: m.id, result });
  } catch (e) {
    send({ id: m.id, result: { content: [{ type: 'text', text: e.message }], isError: true } });
  }
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  try {
    handle(JSON.parse(line));
  } catch {
    /* ignore invalid transport lines */
  }
});
