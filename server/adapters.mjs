import { version } from './version.mjs';
import {
  spawnCommand,
  childEnv,
  capture,
  safePath,
  readText,
  listFiles,
  killProcessTree,
} from './system.mjs';
import { JsonRpc, completion } from './rpc.mjs';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';

function connect(ctx, args) {
  const child = spawnCommand(ctx.provider.executable, [...(ctx.config.prefixArgs || []), ...args], {
    cwd: ctx.project.directory,
    env: { ...ctx.config.accountEnv, ...ctx.bridge.env },
  });
  const stop = () => killProcessTree(child);
  ctx.signal.addEventListener('abort', stop, { once: true });
  child.on('close', () => ctx.signal.removeEventListener('abort', stop));
  return child;
}
function bridgeArgs(ctx) {
  return [
    '-c',
    `mcp_servers.studio.command=${JSON.stringify(ctx.bridge.command)}`,
    '-c',
    `mcp_servers.studio.args=${JSON.stringify(ctx.bridge.args)}`,
    '-c',
    'mcp_servers.studio.env_vars=["STUDIO_BRIDGE_URL","STUDIO_BRIDGE_TOKEN"]',
  ];
}

export async function runCodex(ctx) {
  const rpc = new JsonRpc(connect(ctx, [...bridgeArgs(ctx), 'app-server', '--listen', 'stdio://']));
  let output = '';
  let finalText = '';
  rpc.on('stderr', (text) => ctx.onEvent('diagnostic', text.slice(-3000)));
  rpc.on('notification', ({ method, params = {} }) => {
    if (method === 'item/agentMessage/delta') {
      output += params.delta || '';
      ctx.onDelta(params.delta || '');
    }
    if (method === 'item/started')
      ctx.onEvent('tool', {
        name: params.item?.type || '操作',
        detail: params.item?.command || params.item?.text || '',
        status: 'running',
      });
    if (method === 'item/completed') {
      const item = params.item || {};
      if (item.type === 'agentMessage') finalText = item.text || finalText;
      else
        ctx.onEvent('tool', {
          name: item.type || '操作',
          detail: item.command || '',
          status: item.status || 'completed',
        });
    }
    if (method === 'error')
      ctx.onEvent('diagnostic', params.error?.message || params.message || 'Codex 报告错误');
  });
  rpc.on('request', async (m) => {
    try {
      if (
        m.method.endsWith('/requestApproval') &&
        /commandExecution|fileChange|execCommand|applyPatch/.test(m.method)
      ) {
        const accepted = await ctx.requestApproval(m.method, m.params);
        rpc.reply(m.id, { decision: accepted ? 'accept' : 'decline' });
      } else if (m.method === 'item/tool/requestUserInput') {
        const answers = await ctx.requestInput(m.params.questions || []);
        rpc.reply(m.id, { answers });
      } else rpc.reject(m.id, `客户端暂不支持此请求：${m.method}`);
    } catch (error) {
      rpc.reject(m.id, error.message);
    }
  });
  try {
    await rpc.call('initialize', {
      clientInfo: { name: 'lfc_agent_studio', title: 'Agent Studio', version },
    });
    rpc.notify('initialized', {});
    const options = {
      cwd: ctx.project.directory,
      approvalPolicy: 'on-request',
      sandbox: ctx.node.data.mode === 'read' ? 'read-only' : 'workspace-write',
      developerInstructions: ctx.instructions,
      ...(ctx.node.data.model ? { model: ctx.node.data.model } : {}),
    };
    const response = ctx.node.data.sessionId
      ? await rpc.call('thread/resume', {
          ...options,
          threadId: ctx.node.data.sessionId,
          excludeTurns: true,
        })
      : await rpc.call('thread/start', options);
    const threadId = response.thread.id;
    ctx.onSession(threadId);
    const done = completion(
      rpc,
      (m) =>
        m.method === 'turn/completed' && m.params?.threadId === threadId
          ? m.params.turn
          : undefined,
      ctx.signal,
    );
    // Attach a rejection handler before awaiting turn/start: early process errors must not become unhandled rejections.
    done.catch(() => {});
    await rpc.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: ctx.prompt, text_elements: [] }],
    });
    const turn = await done;
    if (turn.status !== 'completed')
      throw new Error(turn.error?.message || `Codex 任务状态：${turn.status}`);
    return { output: output || finalText, sessionId: threadId };
  } finally {
    rpc.close();
  }
}

export async function runACP(ctx) {
  const rpc = new JsonRpc(
    connect(
      ctx,
      ctx.config.args?.length
        ? ctx.config.args
        : ctx.provider.id === 'grok'
          ? ['agent', 'stdio']
          : ctx.provider.id === 'gemini'
            ? ['--experimental-acp']
            : ['acp'],
    ),
  );
  let output = '';
  rpc.on('stderr', (text) => ctx.onEvent('diagnostic', text.slice(-3000)));
  rpc.on('notification', (m) => {
    if (m.method !== 'session/update') return;
    const u = m.params?.update || {};
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      output += u.content.text;
      ctx.onDelta(u.content.text);
    }
    if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update')
      ctx.onEvent('tool', {
        name: u.title || u.toolCallId || '工具',
        detail: u.rawInput || '',
        status: u.status || 'running',
      });
  });
  rpc.on('request', async (m) => {
    try {
      if (m.method === 'session/request_permission') {
        const allowed = await ctx.requestApproval(
          m.params.toolCall?.title || '工具权限',
          m.params.toolCall,
        );
        const options = m.params.options || [];
        const selected =
          options.find((o) => o.kind === (allowed ? 'allow_once' : 'reject_once')) ||
          options.find((o) => o.kind?.startsWith(allowed ? 'allow' : 'reject'));
        rpc.reply(m.id, {
          outcome: selected
            ? { outcome: 'selected', optionId: selected.optionId }
            : { outcome: 'cancelled' },
        });
      } else if (m.method === 'cursor/ask_question') {
        const answers = await ctx.requestInput(m.params.questions || []);
        rpc.reply(m.id, {
          outcome: 'answered',
          answers: Object.entries(answers).map(([questionId, a]) => ({
            questionId,
            selectedOptionIds: a.answers || [],
          })),
        });
      } else if (m.method === 'cursor/create_plan') {
        const accepted = await ctx.requestApproval('执行计划', m.params);
        rpc.reply(m.id, { outcome: accepted ? 'accepted' : 'rejected' });
      } else rpc.reject(m.id, `客户端未启用此能力：${m.method}`);
    } catch (error) {
      rpc.reject(m.id, error.message);
    }
  });
  try {
    const init = await rpc.call('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'agent-studio', version },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const mcp = [
      {
        name: 'studio',
        command: ctx.bridge.command,
        args: ctx.bridge.args,
        env: Object.entries(ctx.bridge.env).map(([name, value]) => ({ name, value })),
      },
    ];
    const caps = init.agentCapabilities || {};
    const session =
      ctx.node.data.sessionId && caps.loadSession
        ? await rpc.call('session/load', {
            sessionId: ctx.node.data.sessionId,
            cwd: ctx.project.directory,
            mcpServers: mcp,
          })
        : await rpc.call('session/new', { cwd: ctx.project.directory, mcpServers: mcp });
    const sessionId = session.sessionId || ctx.node.data.sessionId;
    if (!sessionId) throw new Error('Agent 未返回会话 ID');
    ctx.onSession(sessionId);
    if (
      ctx.node.data.model &&
      session.models?.availableModels?.some((m) => m.modelId === ctx.node.data.model)
    )
      await rpc.call('session/set_model', { sessionId, modelId: ctx.node.data.model });
    const modeIds = session.modes?.availableModes?.map((m) => m.id) || [];
    const desiredMode =
      ctx.node.data.mode === 'read'
        ? modeIds.includes('ask')
          ? 'ask'
          : 'plan'
        : modeIds.includes('agent')
          ? 'agent'
          : 'default';
    if (ctx.node.data.mode === 'read' && !modeIds.includes(desiredMode))
      throw new Error(
        '此 ACP 工具未声明只读模式，无法保证只读任务；请先在节点设置中更改权限或选择支持只读的工具。',
      );
    if (session.modes?.availableModes?.some((m) => m.id === desiredMode))
      await rpc.call('session/set_mode', { sessionId, modeId: desiredMode });
    const result = await rpc.call(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: ctx.instructions + '\n\n' + ctx.prompt }] },
      86_400_000,
    );
    if (['cancelled', 'refusal'].includes(result.stopReason))
      throw new Error(`Agent 停止：${result.stopReason}`);
    return { output, sessionId };
  } finally {
    rpc.close();
  }
}

export async function runClaude(ctx) {
  const mcp = JSON.stringify({
    mcpServers: {
      studio: { command: ctx.bridge.command, args: ctx.bridge.args, env: ctx.bridge.env },
    },
  });
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    ctx.node.data.mode === 'read' ? 'plan' : 'manual',
    '--permission-prompt-tool',
    'stdio',
    '--mcp-config',
    mcp,
    '--append-system-prompt',
    ctx.instructions,
  ];
  if (ctx.node.data.sessionId) args.push('--resume', ctx.node.data.sessionId);
  if (ctx.node.data.model) args.push('--model', ctx.node.data.model);
  const child = connect(ctx, args);
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let buffer = '',
      output = '',
      sessionId = ctx.node.data.sessionId,
      settled = false,
      sawDelta = false,
      diagnostic = '';
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      child.stdin.end();
      child.kill();
      error ? reject(error) : resolve(result);
    };
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (!settled)
        finish(
          new Error(
            ctx.signal.aborted
              ? '任务已停止'
              : `Claude 在返回完成结果前退出 (${code})${diagnostic ? '：' + diagnostic.slice(-1000) : ''}`,
          ),
        );
    });
    child.stderr.on('data', (d) => {
      diagnostic = (diagnostic + d).slice(-5000);
      ctx.onEvent('diagnostic', d.toString().slice(-2500));
    });
    const write = (value) => {
      if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n');
    };
    const sendPrompt = () =>
      write({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: ctx.prompt }] },
        parent_tool_use_id: null,
        session_id: sessionId || '',
      });
    const message = async (m) => {
      if (m.type === 'control_response' && m.response?.request_id === 'studio-init') {
        if (m.response.subtype !== 'success')
          finish(new Error(m.response.error || 'Claude 初始化失败'));
        else sendPrompt();
      }
      if (m.session_id) {
        sessionId = m.session_id;
        ctx.onSession(sessionId);
      }
      if (m.type === 'stream_event' && m.event?.delta?.type === 'text_delta') {
        sawDelta = true;
        output += m.event.delta.text;
        ctx.onDelta(m.event.delta.text);
      }
      if (m.type === 'assistant' && !sawDelta)
        for (const c of m.message?.content || [])
          if (c.type === 'text') {
            output += c.text;
            ctx.onDelta(c.text);
          }
      if (m.type === 'assistant')
        for (const c of m.message?.content || [])
          if (c.type === 'tool_use')
            ctx.onEvent('tool', { name: c.name, detail: c.input, status: 'running' });
      if (m.type === 'control_request') {
        const request = m.request || {};
        if (request.subtype === 'can_use_tool') {
          const allowed = await ctx.requestApproval(request.tool_name, request.input);
          write({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: m.request_id,
              response: allowed
                ? { behavior: 'allow', updatedInput: request.input }
                : { behavior: 'deny', message: '用户拒绝了此操作', interrupt: false },
            },
          });
        } else
          write({
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: m.request_id,
              error: '当前客户端未启用此控制请求',
            },
          });
      }
      if (m.type === 'result') {
        if (m.is_error || (m.subtype && m.subtype !== 'success'))
          finish(new Error(m.errors?.join('\n') || m.result || `Claude 执行失败：${m.subtype}`));
        else finish(null, { output: m.result || output, sessionId, usage: m.usage || null });
      }
    };
    child.stdout.on('data', (d) => {
      buffer += decoder.write(d);
      if (buffer.length > 8_000_000) return finish(new Error('Claude 协议消息过大'));
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          message(JSON.parse(line)).catch((e) => finish(e));
        } catch {
          ctx.onEvent('diagnostic', line.slice(0, 2000));
        }
      }
    });
    write({
      type: 'control_request',
      request_id: 'studio-init',
      request: { subtype: 'initialize', hooks: {} },
    });
  });
}

export async function runJsonl(ctx) {
  let args = ctx.config.args?.length
    ? [...ctx.config.args]
    : ['--output-format', 'stream-json', '-p', '{prompt}'];
  if (ctx.node.data.mode === 'read') {
    if (!ctx.config.readOnlyArgs?.length)
      throw new Error(
        '此通用 CLI 尚未配置只读参数。请在连接设置中按该工具文档填写只读参数，或选择支持原生只读模式的连接。',
      );
    args.push(...ctx.config.readOnlyArgs);
  }
  if (args.some((a) => a.includes('{prompt}')))
    args = args.map((a) => a.replaceAll('{prompt}', ctx.instructions + '\n\n' + ctx.prompt));
  else args.push(ctx.instructions + '\n\n' + ctx.prompt);
  if (ctx.node.data.model) args.push('--model', ctx.node.data.model);
  if (ctx.node.data.sessionId && ctx.config.resumeFlag)
    args.push(ctx.config.resumeFlag, ctx.node.data.sessionId);
  const child = connect(ctx, args);
  return new Promise((resolve, reject) => {
    let buffer = '',
      output = '',
      final = '',
      stderr = '',
      sessionId = ctx.node.data.sessionId,
      resultSeen = false,
      failure = '';
    const decoder = new StringDecoder('utf8');
    child.on('error', reject);
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-5000);
      ctx.onEvent('diagnostic', d.toString().slice(-2000));
    });
    const parse = (line) => {
      if (!line.trim()) return;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        ctx.onEvent('diagnostic', line.slice(0, 1000));
        return;
      }
      const id = m.session_id || m.sessionId;
      if (id) {
        sessionId = id;
        ctx.onSession(id);
      }
      const text =
        m.type === 'message' && m.role === 'assistant'
          ? m.content
          : m.type === 'stream_event'
            ? m.event?.delta?.text
            : m.type === 'text'
              ? m.text
              : m.type === 'content_block_delta'
                ? m.delta?.text
                : '';
      if (typeof text === 'string') {
        output += text;
        ctx.onDelta(text);
      }
      if (m.type === 'tool_use' || m.type === 'tool_result')
        ctx.onEvent('tool', {
          name: m.tool_name || m.name || '工具',
          detail: m.parameters || m.output || '',
          status: m.type === 'tool_result' ? 'completed' : 'running',
        });
      if (m.type === 'result') {
        resultSeen = true;
        final = m.result || m.response || '';
        if (m.is_error || m.status === 'error' || m.subtype?.startsWith('error'))
          failure = m.error?.message || m.error || final || 'Agent 报告失败';
      }
      if (m.type === 'error') failure = m.message || m.error?.message || 'Agent 报告错误';
    };
    child.stdout.on('data', (d) => {
      buffer += decoder.write(d);
      if (buffer.length > 8_000_000) {
        child.kill();
        failure = '消息过大';
        return;
      }
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    });
    child.on('close', (code) => {
      if (buffer.trim()) parse(buffer);
      if (ctx.signal.aborted) reject(new Error('任务已停止'));
      else if (code !== 0 || failure)
        reject(new Error(String(failure || stderr || `Agent 退出码 ${code}`).slice(-4000)));
      else if (!resultSeen && !output)
        reject(new Error('工具未返回可识别的结构化输出。请在连接设置中核对协议和参数。'));
      else resolve({ output: final || output, sessionId });
    });
  });
}

const apiTools = [
  ['list_files', '列出项目中的文件', { path: { type: 'string' } }],
  ['read_file', '读取项目文本文件', { path: { type: 'string' } }],
  [
    'write_file',
    '写入项目文本文件，需要用户批准',
    { path: { type: 'string' }, content: { type: 'string' } },
  ],
  ['run_command', '在项目中运行 PowerShell 命令，需要用户批准', { command: { type: 'string' } }],
  ['team_peers', '列出当前节点连接的队友', {}],
  [
    'team_send',
    '给连接的队友派发异步任务',
    { target: { type: 'string' }, prompt: { type: 'string' } },
  ],
  ['team_task', '检查团队任务结果', { taskId: { type: 'string' } }],
  ['team_note_read', '读取连接的共享便签', { noteId: { type: 'string' } }],
  [
    'team_note_write',
    '写入连接的共享便签',
    { noteId: { type: 'string' }, content: { type: 'string' } },
  ],
].map(([name, description, properties]) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  },
}));

export async function runAPI(ctx) {
  if (!ctx.apiKey)
    throw new Error('请先设置 DeepSeek / 兼容服务的 API Key；网页登录不能作为 API Key 使用。');
  const base = ctx.config.baseUrl || 'https://api.deepseek.com';
  const endpoint = new URL(base.replace(/\/$/, '') + '/chat/completions');
  if (
    endpoint.protocol !== 'https:' &&
    !['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname)
  )
    throw new Error('远程 API 必须使用 HTTPS');
  const model = ctx.node.data.model || ctx.config.model;
  if (!model) throw new Error('请在节点设置中填写 API 模型名称');
  const messages = [
    { role: 'system', content: ctx.instructions },
    { role: 'user', content: ctx.prompt },
  ];
  let fullOutput = '';
  for (let step = 0; step < 24; step++) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ctx.apiKey },
      body: JSON.stringify({ model, messages, tools: apiTools, stream: false }),
      signal: ctx.signal,
    });
    if (!response.ok)
      throw new Error(
        `API 请求失败 (${response.status})：${(await response.text()).slice(0, 1200)}`,
      );
    const data = await response.json();
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('API 返回了无效响应');
    messages.push(message);
    if (message.content) {
      fullOutput += message.content + '\n';
      ctx.onDelta(message.content + '\n');
    }
    if (!message.tool_calls?.length) return { output: fullOutput.trim(), usage: data.usage };
    for (const tool of message.tool_calls) {
      let result;
      try {
        const args = JSON.parse(tool.function.arguments);
        const name = tool.function.name;
        ctx.onEvent('tool', { name, detail: args, status: 'running' });
        if (name.startsWith('team_')) result = await ctx.bridge.call(name, args);
        else if (name === 'list_files') result = listFiles(ctx.project.directory, args.path);
        else if (name === 'read_file') result = readText(ctx.project.directory, args.path);
        else if (name === 'write_file') {
          if (ctx.node.data.mode === 'read') throw new Error('此节点处于只读模式');
          const destination = safePath(ctx.project.directory, args.path, true);
          if (!(await ctx.requestApproval(name, args))) throw new Error('用户拒绝写入');
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, args.content, 'utf8');
          result = '文件已写入：' + args.path;
        } else if (name === 'run_command') {
          if (ctx.node.data.mode === 'read') throw new Error('此节点处于只读模式');
          if (!(await ctx.requestApproval(name, args))) throw new Error('用户拒绝执行');
          const shell =
            process.platform === 'win32'
              ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
              : '/bin/sh';
          result = await capture(
            shell,
            process.platform === 'win32'
              ? ['-NoProfile', '-NonInteractive', '-Command', args.command]
              : ['-c', args.command],
            { cwd: ctx.project.directory, timeout: 60000, signal: ctx.signal },
          );
        } else throw new Error('未知工具');
      } catch (e) {
        result = { error: e.message };
      }
      messages.push({
        role: 'tool',
        tool_call_id: tool.id,
        content: JSON.stringify(result).slice(0, 60000),
      });
    }
  }
  throw new Error('已到达单次任务的工具调用上限（24 轮）。请检查输出后继续。');
}

export const adapters = {
  codex: runCodex,
  claude: runClaude,
  acp: runACP,
  jsonl: runJsonl,
  api: runAPI,
};
