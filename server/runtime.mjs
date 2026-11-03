import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { uid, stamp, makeNode } from './store.mjs';
import { adapters } from './adapters.mjs';
import { discover, ROOT } from './system.mjs';
import path from 'node:path';

const activeStates = ['running', 'waiting_approval'];
const scrub = (value) =>
  String(value).replace(
    /(Bearer\s+|api[_-]?key["'\s:=]+|token["'\s:=]+)[A-Za-z0-9._~+/=-]{12,}/gi,
    '$1[已隐藏]',
  );
export class Runtime extends EventEmitter {
  constructor(store, options = {}) {
    super();
    this.store = store;
    this.active = new Map();
    this.approvals = new Map();
    this.capabilities = new Map();
    this.url = options.url || '';
    this.readKey = options.readKey || (() => null);
    this.drivers = options.drivers || adapters;
    this.closed = false;
  }
  createTask(nodeId, prompt, extra = {}) {
    const node = this.store.node(nodeId);
    if (node.type !== 'agent') throw new Error('请选择一个 Agent 节点');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000)
      throw new Error('请输入 1–200000 字符的任务内容');
    if (this.store.state.tasks.filter((t) => t.status === 'queued').length >= 80)
      throw new Error('等待任务过多，请先完成或停止现有任务');
    const task = {
      id: uid('t_'),
      nodeId,
      projectId: node.projectId,
      prompt: prompt.trim(),
      status: 'queued',
      output: '',
      error: null,
      createdAt: stamp(),
      steps: [],
      ...extra,
    };
    this.store.state.tasks.push(task);
    this.store.changed(true);
    this.store.event('task', `已派给 ${node.data.name}`, {
      projectId: node.projectId,
      taskId: task.id,
    });
    queueMicrotask(() => this.drain());
    return task;
  }
  workflow(projectId, prompt, nodeIds) {
    this.store.project(projectId);
    const nodes = this.store.state.nodes.filter(
      (n) =>
        n.projectId === projectId &&
        n.type === 'agent' &&
        (!nodeIds?.length || nodeIds.includes(n.id)),
    );
    if (!nodes.length) throw new Error('请先添加 Agent');
    const ids = new Set(nodes.map((n) => n.id));
    const edges = this.store.state.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    const indegree = new Map(nodes.map((n) => [n.id, 0]));
    for (const e of edges) indegree.set(e.target, indegree.get(e.target) + 1);
    const q = [...indegree].filter(([, d]) => d === 0).map(([id]) => id);
    let visited = 0;
    for (let i = 0; i < q.length; i++) {
      visited++;
      for (const e of edges.filter((e) => e.source === q[i])) {
        indegree.set(e.target, indegree.get(e.target) - 1);
        if (!indegree.get(e.target)) q.push(e.target);
      }
    }
    if (visited !== nodes.length)
      throw new Error(
        '流程箭头形成了循环。请调整为从规划到执行、审查、汇总的方向；普通队友互相派活仍可使用连线。',
      );
    const run = {
      id: uid('r_'),
      projectId,
      prompt: prompt.trim(),
      nodeIds: [...ids],
      edges: structuredClone(edges),
      taskIds: [],
      status: 'running',
      createdAt: stamp(),
    };
    this.store.state.runs.push(run);
    this.store.changed(true);
    this.advance(run);
    return run;
  }
  advance(run) {
    if (run.status !== 'running') return;
    const tasks = this.store.state.tasks.filter((t) => t.runId === run.id);
    const byNode = new Map(tasks.map((t) => [t.nodeId, t]));
    for (const nodeId of run.nodeIds) {
      if (byNode.has(nodeId)) continue;
      const dependencyIds = run.edges.filter((e) => e.target === nodeId).map((e) => e.source);
      const dependencies = dependencyIds.map((id) => byNode.get(id));
      if (
        dependencies.some(
          (t) => t && ['failed', 'cancelled', 'blocked', 'interrupted'].includes(t.status),
        )
      ) {
        const blocked = {
          id: uid('t_'),
          nodeId,
          projectId: run.projectId,
          runId: run.id,
          prompt: run.prompt,
          status: 'blocked',
          output: '',
          error: '上游任务未成功完成',
          createdAt: stamp(),
          endedAt: stamp(),
          steps: [],
        };
        this.store.state.tasks.push(blocked);
        run.taskIds.push(blocked.id);
        byNode.set(nodeId, blocked);
        continue;
      }
      if (dependencies.some((t) => !t || t.status !== 'completed')) continue;
      const sourceContext = dependencies
        .map((t) => {
          const name = this.store.state.nodes.find((n) => n.id === t.nodeId)?.data.name || t.nodeId;
          return `\n--- 上游结果：${name}（任务 ${t.id}）---\n${t.output.slice(-70000)}`;
        })
        .join('\n');
      const task = this.createTask(
        nodeId,
        `总目标：\n${run.prompt}\n${sourceContext}\n\n请结合你的角色完成本阶段，交付实际产物，并明确已验证与未验证的内容。`,
        { runId: run.id, dependsOn: dependencies.map((t) => t.id) },
      );
      run.taskIds.push(task.id);
      byNode.set(nodeId, task);
    }
    const current = this.store.state.tasks.filter((t) => t.runId === run.id);
    if (
      current.length === run.nodeIds.length &&
      current.every((t) => !['queued', ...activeStates].includes(t.status))
    ) {
      run.status = current.every((t) => t.status === 'completed') ? 'completed' : 'failed';
      run.endedAt = stamp();
      this.store.event(
        'workflow',
        run.status === 'completed' ? '团队流程已完成' : '团队流程存在失败任务，请检查',
        { projectId: run.projectId, runId: run.id },
      );
    }
    this.store.changed(true);
  }
  drain() {
    if (this.closed) return;
    const max = Math.max(1, Math.min(8, Number(this.store.state.settings.maxConcurrency) || 3));
    const busyNodes = new Set([...this.active.values()].map((a) => a.nodeId));
    for (const task of this.store.state.tasks.filter((t) => t.status === 'queued')) {
      if (this.active.size >= max) break;
      if (busyNodes.has(task.nodeId)) continue;
      busyNodes.add(task.nodeId);
      this.run(task);
    }
  }
  async run(task) {
    const controller = new AbortController();
    this.active.set(task.id, { controller, nodeId: task.nodeId });
    task.status = 'running';
    task.startedAt = stamp();
    this.store.changed(true);
    const token = randomBytes(32).toString('hex');
    this.capabilities.set(token, { nodeId: task.nodeId, taskId: task.id, sent: 0 });
    const timer = setTimeout(
      () => controller.abort(new Error('已到达任务运行时限')),
      Math.max(1, Math.min(240, Number(this.store.state.settings.maxTaskMinutes) || 30)) * 60000,
    );
    try {
      const node = this.store.node(task.nodeId);
      const project = this.store.project(task.projectId);
      const provider = discover(this.store.state.settings).find((p) => p.id === node.data.provider);
      if (!provider) throw new Error('未知 Provider');
      const config = { ...(this.store.state.settings.providers[provider.id] || {}) };
      if (node.data.accountId) {
        const account = this.store.state.accounts?.find(
          (a) => a.id === node.data.accountId && a.provider === provider.id,
        );
        if (!account) throw new Error('请重新关联节点的账号配置');
        config.accountEnv = {
          [provider.id === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: account.configDirectory,
        };
      }
      if (!provider.installed && provider.protocol !== 'api')
        throw new Error(`未找到 ${provider.name}。请先在连接设置中配置工具路径。`);
      const nodePath = process.env.STUDIO_NODE || process.execPath;
      const bridge = {
        command: nodePath,
        args: [path.join(ROOT, 'server', 'mcp.mjs')],
        env: {
          STUDIO_BRIDGE_URL: this.url,
          STUDIO_BRIDGE_TOKEN: token,
          ...(process.versions.electron && nodePath === process.execPath
            ? { ELECTRON_RUN_AS_NODE: '1' }
            : {}),
        },
        call: (method, args) =>
          this.externalToolCall
            ? this.externalToolCall(token, method, args)
            : this.bridgeCall(token, method, args),
      };
      const peers = this.peers(node.id)
        .map((n) => `${n.data.name} [${n.id}] / ${n.data.role}`)
        .join('\n');
      const notes = this.connected(node.id)
        .filter((n) => n.type === 'note')
        .map((n) => `共享便签 ${n.id}：${n.data.name}\n${n.data.content}`)
        .join('\n\n');
      const instructions = `你正在 Agent Studio 本地工作台中执行真实任务。你的名字：${node.data.name}；职责：${node.data.role}。\n${node.data.instructions || ''}\n项目目录：${project.directory}\n只读模式：${node.data.mode === 'read' ? '是，不得改写文件或运行修改命令' : '否，遵守权限请求'}。\n只有观察到的操作才能报告为已完成，不得编造文件、测试或执行结果。\n队友及连接权限：\n${peers || '暂无连接的队友'}\n可以使用 studio MCP 工具给已连接队友派异步任务并查看结果；不要循环等待，不得无限自我派活。\n${notes ? '连接的便签：\n' + notes : ''}`;
      const driver = this.drivers[provider.protocol];
      if (!driver) throw new Error('尚未实现的连接协议');
      const result = await driver({
        node,
        project,
        provider,
        config,
        prompt: task.prompt,
        instructions,
        signal: controller.signal,
        apiKey: this.readKey(provider.id),
        bridge,
        onDelta: (text) => {
          task.output = (task.output + text).slice(-2_000_000);
          this.emit('delta', { taskId: task.id, nodeId: node.id, text });
          this.store.changed();
        },
        onEvent: (type, detail) => {
          if (task.steps.length >= 500) task.steps.shift();
          task.steps.push({
            type,
            detail: typeof detail === 'string' ? scrub(detail) : detail,
            at: stamp(),
          });
          this.store.changed();
        },
        onSession: (id) => {
          node.data.sessionId = id;
          task.sessionId = id;
          this.store.changed();
        },
        requestApproval: (tool, input) => this.approve(task, tool, input, controller.signal),
        requestInput: (questions) =>
          this.approve(task, '需要补充信息', { questions }, controller.signal, 'input'),
      });
      if (controller.signal.aborted) throw new Error('任务已停止');
      if (result.output) task.output = result.output.slice(-2_000_000);
      task.usage = result.usage || null;
      task.status = 'completed';
      task.error = null;
    } catch (error) {
      if (task.status !== 'cancelled' && task.status !== 'interrupted')
        task.status = controller.signal.aborted ? 'cancelled' : 'failed';
      task.error = scrub(error.message || error);
    } finally {
      clearTimeout(timer);
      this.capabilities.delete(token);
      task.endedAt = stamp();
      this.active.delete(task.id);
      for (const [id, a] of this.approvals)
        if (a.taskId === task.id) {
          a.resolve(false);
          this.approvals.delete(id);
        }
      this.store.changed(true);
      this.store.event(
        'task',
        `${task.status === 'completed' ? '完成' : '停止或失败'} · ${this.store.state.nodes.find((n) => n.id === task.nodeId)?.data.name || ''}`,
        { projectId: task.projectId, taskId: task.id },
      );
      if (task.runId) {
        const run = this.store.state.runs.find((r) => r.id === task.runId);
        if (run) this.advance(run);
      }
      this.drain();
    }
  }
  approve(task, tool, input, signal, type = 'permission') {
    if (signal.aborted) return Promise.reject(new Error('任务已停止'));
    return new Promise((resolve) => {
      const id = uid('a_');
      const prior = task.status;
      task.status = 'waiting_approval';
      const onAbort = () => this.respond(id, false);
      this.approvals.set(id, {
        id,
        taskId: task.id,
        nodeId: task.nodeId,
        tool,
        input,
        type,
        at: stamp(),
        resolve: (result) => {
          signal.removeEventListener('abort', onAbort);
          if (task.status === 'waiting_approval') task.status = prior;
          resolve(result);
        },
      });
      signal.addEventListener('abort', onAbort, { once: true });
      this.store.changed(true);
    });
  }
  respond(id, answer) {
    const item = this.approvals.get(id);
    if (!item) throw new Error('此请求已失效');
    this.approvals.delete(id);
    item.resolve(answer);
    this.store.changed(true);
  }
  stop(taskId) {
    const task = this.store.task(taskId);
    if (!['queued', ...activeStates].includes(task.status)) return;
    task.status = 'cancelled';
    task.endedAt = stamp();
    this.active.get(taskId)?.controller.abort();
    this.store.changed(true);
    if (task.runId) {
      const run = this.store.state.runs.find((r) => r.id === task.runId);
      if (run) this.advance(run);
    }
  }
  stopRun(id) {
    const run = this.store.state.runs.find((r) => r.id === id);
    if (!run) throw new Error('流程不存在');
    run.status = 'cancelled';
    for (const t of this.store.state.tasks.filter((t) => t.runId === id)) this.stop(t.id);
    this.store.changed(true);
  }
  connected(nodeId) {
    const ids = new Set(
      this.store.state.edges.flatMap((e) =>
        e.source === nodeId ? [e.target] : e.target === nodeId ? [e.source] : [],
      ),
    );
    const direct = this.store.state.nodes.filter((n) => ids.has(n.id));
    const notes = direct
      .filter((n) => n.type === 'binder')
      .flatMap((b) => this.store.state.nodes.filter((n) => n.binderId === b.id));
    return [...direct, ...notes];
  }
  peers(nodeId) {
    return this.connected(nodeId).filter((n) => n.type === 'agent');
  }
  bridgeCall(token, method, args = {}) {
    const cap = this.capabilities.get(token);
    if (!cap) throw new Error('协作凭据无效或任务已结束');
    const node = this.store.node(cap.nodeId);
    const peers = this.peers(node.id);
    if (method === 'team_peers')
      return peers.map((n) => ({
        id: n.id,
        name: n.data.name,
        role: n.data.role,
        provider: n.data.provider,
      }));
    if (method === 'team_send') {
      if (++cap.sent > 12) throw new Error('本次任务已到达派发上限（12 次）');
      const target = peers.find((n) => n.id === args.target || n.data.name === args.target);
      if (!target) throw new Error('只能给已连接的 Agent 派活');
      const task = this.createTask(target.id, `来自 ${node.data.name} 的任务：\n${args.prompt}`, {
        fromNodeId: node.id,
        parentTaskId: cap.taskId,
      });
      return {
        taskId: task.id,
        status: task.status,
        message: '任务已排队，使用 team_task 检查；不要高频轮询。',
      };
    }
    if (method === 'team_task') {
      const task = this.store.task(args.taskId);
      if (task.fromNodeId !== node.id && task.nodeId !== node.id) throw new Error('无权查看此任务');
      return {
        id: task.id,
        status: task.status,
        output: task.output.slice(-80000),
        error: task.error,
      };
    }
    if (method === 'team_note_read' || method === 'team_note_write') {
      const note = this.connected(node.id).find(
        (n) => n.type === 'note' && (n.id === args.noteId || n.data.name === args.noteId),
      );
      if (!note) throw new Error('只能访问已连接的共享便签');
      if (method === 'team_note_write') {
        if (node.data.mode === 'read') throw new Error('只读节点无法写便签');
        if (String(args.content).length > 200000) throw new Error('便签过长');
        note.data.content = String(args.content);
        this.store.changed(true);
      }
      return { noteId: note.id, name: note.data.name, content: note.data.content };
    }
    if (method === 'team_recruit') {
      if (!node.data.orchestrator) throw new Error('此节点没有创建队友的权限');
      if (++cap.sent > 12) throw new Error('本次任务已到达派发上限');
      if (!discover(this.store.state.settings).some((p) => p.id === args.provider && p.installed))
        throw new Error('只能选已安装的工具');
      const next = makeNode(
        node.projectId,
        'agent',
        {
          name: String(args.name || '新队友').slice(0, 60),
          provider: args.provider,
          role: String(args.role || '协作').slice(0, 200),
          orchestrator: false,
        },
        { x: node.position.x + 420, y: node.position.y + 160 },
      );
      this.store.state.nodes.push(next);
      this.store.state.edges.push({ id: uid('edge_'), source: node.id, target: next.id });
      this.store.changed(true);
      return { nodeId: next.id, name: next.data.name };
    }
    throw new Error('未知协作工具');
  }
  publicApprovals() {
    return [...this.approvals.values()].map(({ resolve, ...a }) => a);
  }
  close() {
    this.closed = true;
    for (const [id, a] of this.active) {
      this.store.task(id).status = 'interrupted';
      a.controller.abort();
    }
    this.store.changed(true);
  }
}
