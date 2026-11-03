import { version } from './version.mjs';
import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { canvasHistory } from './history.mjs';
import { nextScheduled } from './schedules.mjs';
import { registerWorkbench } from './workbench.mjs';
import { Store, uid, stamp, makeNode } from './store.mjs';
import { Runtime } from './runtime.mjs';
import { Terminals } from './terminals.mjs';
import {
  ROOT,
  discover,
  assertDirectory,
  safePath,
  readText,
  listFiles,
  capture,
  git,
  inside,
} from './system.mjs';

export async function createStudio(options = {}) {
  const directory =
    options.directory || process.env.STUDIO_DATA_DIR || path.join(os.homedir(), '.agent-studio');
  const store = new Store(directory);
  const token = randomBytes(32).toString('hex');
  const secrets = new Map();
  const app = express();
  const server = http.createServer(app);
  app.disable('x-powered-by');
  const terminals = new Terminals();
  const readKey = (id) =>
    secrets.get(id) ||
    (store.state.settings.providers[id]?.encryptedKey &&
      options.decrypt?.(store.state.settings.providers[id].encryptedKey)) ||
    (id === 'deepseek' ? process.env.DEEPSEEK_API_KEY : null);
  const runtime = new Runtime(store, { readKey, drivers: options.drivers });
  let url = '';
  const valid = (value) => {
    try {
      return (
        typeof value === 'string' &&
        value.length === token.length &&
        timingSafeEqual(Buffer.from(value), Buffer.from(token))
      );
    } catch {
      return false;
    }
  };
  const cookieToken = (req) => {
    const match = String(req.headers.cookie || '').match(/(?:^|;\s*)studio_session=([^;]+)/);
    return match?.[1];
  };
  const authorized = (req) => valid(req.headers['x-studio-token']) || valid(cookieToken(req));
  const publicPort = Number(process.env.STUDIO_PUBLIC_PORT);
  const publicOrigin =
    publicPort > 0 && publicPort < 65536 ? `http://127.0.0.1:${publicPort}` : null;
  const originOk = (req) =>
    !req.headers.origin ||
    req.headers.origin === url ||
    req.headers.origin === options.devOrigin ||
    req.headers.origin === publicOrigin;
  app.use((req, res, next) => {
    if (!originOk(req)) return res.status(403).json({ error: '不允许来自其他网站的请求' });
    if (
      req.headers.host !== new URL(url || 'http://127.0.0.1').host &&
      req.headers.host !== (publicOrigin ? new URL(publicOrigin).host : null)
    )
      return res.status(403).json({ error: 'Host 不匹配' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.json({ limit: '32mb' }));
  app.post('/api/bridge', async (req, res) => {
    try {
      res.json({
        result: await bridgeCall(req.headers['x-studio-bridge'], req.body.method, req.body.args),
      });
    } catch (e) {
      res.status(403).json({ error: e.message });
    }
  });
  app.get('/health', (req, res) => res.json({ ok: true, name: 'Agent Studio', version }));
  app.get('/api/session', (req, res) => {
    if (!authorized(req)) return res.status(401).json({ error: '请从应用启动入口打开工作台' });
    res.json({ token });
  });
  app.use('/api', (req, res, next) =>
    authorized(req) ? next() : res.status(401).json({ error: '请从应用启动入口打开工作台' }),
  );
  const history = canvasHistory(store);
  app.use('/api', history.middleware);
  app.post('/api/canvas/undo', (req, res) =>
    res.json(history.apply(req.body.projectId, !!req.body.redo)),
  );
  registerWorkbench(app, { store, runtime, terminals, options });
  const snapshot = () => ({
    ...store.snapshot(),
    canvasHistory: history.stats(),
    approvals: runtime.publicApprovals(),
    providers: discover(store.state.settings),
    desktop: !!options.desktop,
    version,
  });
  app.get('/api/state', (req, res) => res.json(snapshot()));
  app.post('/api/projects', (req, res) => {
    const name = String(req.body.name || '新工作台')
      .trim()
      .slice(0, 80);
    const id = uid('p_');
    const dir = req.body.directory
      ? assertDirectory(req.body.directory)
      : path.join(directory, 'projects', id);
    fs.mkdirSync(dir, { recursive: true });
    const project = { id, name, directory: dir, createdAt: stamp(), view: null };
    store.state.projects.push(project);
    store.changed(true);
    res.json(project);
  });
  app.patch('/api/projects/:id', (req, res) => {
    const p = store.project(req.params.id);
    if (req.body.name) p.name = String(req.body.name).slice(0, 80);
    if (req.body.directory) {
      if (
        store.state.tasks.some(
          (t) =>
            t.projectId === p.id && ['running', 'queued', 'waiting_approval'].includes(t.status),
        )
      )
        throw new Error('请先停止当前工作区的任务');
      p.directory = assertDirectory(req.body.directory);
      for (const n of store.state.nodes.filter((n) => n.projectId === p.id))
        n.data.sessionId = null;
    }
    if (req.body.view) p.view = req.body.view;
    store.changed(true);
    res.json(p);
  });
  app.delete('/api/projects/:id', (req, res) => {
    const p = store.project(req.params.id);
    if (
      store.state.tasks.some(
        (t) => t.projectId === p.id && ['running', 'queued', 'waiting_approval'].includes(t.status),
      )
    )
      throw new Error('请先停止该工作台的任务');
    const ids = new Set(store.state.nodes.filter((n) => n.projectId === p.id).map((n) => n.id));
    store.state.projects = store.state.projects.filter((x) => x.id !== p.id);
    store.state.nodes = store.state.nodes.filter((n) => !ids.has(n.id));
    store.state.edges = store.state.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target));
    store.state.routines = store.state.routines.filter((r) => r.projectId !== p.id);
    store.changed(true);
    res.json({ ok: true, note: '已移除工作台记录；项目文件保留' });
  });
  app.post('/api/nodes', (req, res) => {
    store.project(req.body.projectId);
    if (
      !['agent', 'note', 'terminal', 'portal', 'frame', 'binder', 'drawing', 'text'].includes(
        req.body.type,
      )
    )
      throw new Error('未知节点类型');
    const n = makeNode(req.body.projectId, req.body.type, req.body.data, req.body.position);
    store.state.nodes.push(n);
    store.changed(true);
    res.json(n);
  });
  app.post('/api/canvas/positions', (req, res) => {
    store.project(req.body.projectId);
    const list = req.body.positions;
    if (!Array.isArray(list) || list.length > 500) throw new Error('无效的节点位置列表');
    const updates = list.map((p) => {
      const node = store.node(p.id);
      if (node.projectId !== req.body.projectId) throw new Error('节点不属于当前工作台');
      if (node.locked && (node.position.x !== p.position?.x || node.position.y !== p.position?.y))
        throw new Error('请先解除节点位置锁定');
      if (
        !Number.isFinite(p.position?.x) ||
        !Number.isFinite(p.position?.y) ||
        Math.abs(p.position.x) > 1000000 ||
        Math.abs(p.position.y) > 1000000
      )
        throw new Error('无效的位置');
      return { node, position: p.position };
    });
    for (const u of updates) u.node.position = { ...u.position };
    store.changed(true);
    res.json({ ok: true });
  });
  app.patch('/api/nodes/:id', (req, res) => {
    const n = store.node(req.params.id);
    const task = store.state.tasks.find(
      (t) => t.nodeId === n.id && ['running', 'waiting_approval'].includes(t.status),
    );
    const data = req.body.data || {};
    if (
      task &&
      ['provider', 'model', 'mode', 'instructions', 'sessionId', 'accountId'].some((k) => k in data)
    )
      throw new Error('任务运行中，请先停止再更改连接设置');
    const allowed =
      n.type === 'agent'
        ? [
            'name',
            'provider',
            'model',
            'role',
            'instructions',
            'mode',
            'orchestrator',
            'sessionId',
            'accountId',
          ]
        : ['name', 'content', 'url', 'color', 'fontSize', 'activeNoteId'];
    if (
      'content' in data &&
      req.body.expectedContent !== undefined &&
      n.data.content !== req.body.expectedContent
    )
      throw new Error('共享内容已被其他成员更新。草稿已保留，请复制草稿后读取最新内容再合并。');
    const previousProvider = n.data.provider,
      previousAccount = n.data.accountId;
    for (const key of allowed) if (key in data) n.data[key] = data[key];
    if ('accountId' in data && data.accountId !== previousAccount) n.data.sessionId = null;
    if (typeof req.body.locked === 'boolean') n.locked = req.body.locked;
    if (data.provider && data.provider !== previousProvider) {
      n.data.sessionId = null;
      n.data.accountId = '';
    }
    if (req.body.position) {
      const { x, y } = req.body.position;
      if (Number.isFinite(x) && Number.isFinite(y)) n.position = { x, y };
    }
    if (n.type === 'frame')
      for (const key of ['width', 'height'])
        if (Number.isFinite(req.body[key])) n[key] = Math.max(160, Math.min(3000, req.body[key]));
    store.changed(true);
    res.json(n);
  });
  app.delete('/api/nodes/:id', (req, res) => {
    const n = store.node(req.params.id);
    if (
      store.state.tasks.some(
        (t) => t.nodeId === n.id && ['running', 'queued', 'waiting_approval'].includes(t.status),
      )
    )
      throw new Error('请先停止此节点的任务');
    for (const child of store.state.nodes) {
      if (child.binderId === n.id) delete child.binderId;
      if (child.groupId === n.id) delete child.groupId;
    }
    store.state.nodes = store.state.nodes.filter((x) => x.id !== n.id);
    store.state.edges = store.state.edges.filter((e) => e.source !== n.id && e.target !== n.id);
    options.closePortal?.(n.id);
    store.changed(true);
    res.json({ ok: true });
  });
  app.post('/api/edges', (req, res) => {
    const { source, target } = req.body;
    const a = store.node(source),
      b = store.node(target);
    if (a.id === b.id) throw new Error('不能连接自身');
    if (a.type !== 'agent' && b.type !== 'agent') throw new Error('至少有一个端点应为 Agent');
    if (store.state.edges.some((e) => e.source === source && e.target === target))
      throw new Error('此连线已存在');
    const edge = { id: uid('edge_'), source, target };
    store.state.edges.push(edge);
    store.changed(true);
    res.json(edge);
  });
  app.delete('/api/edges/:id', (req, res) => {
    store.state.edges = store.state.edges.filter((e) => e.id !== req.params.id);
    store.changed(true);
    res.json({ ok: true });
  });
  app.post('/api/template', (req, res) => {
    const p = store.project(req.body.projectId);
    const baseX = store.state.nodes.filter((n) => n.projectId === p.id).length ? 400 : 90;
    if (req.body.kind === 'team') {
      const roles = [
        [
          '主控 / orchestrator',
          'claude',
          '规划',
          '分析总目标，给出清晰的分工、接口与验收标准。',
          500,
          320,
        ],
        ['实现 / builder', 'codex', '开发', '根据上游计划实现代码并检查实际产物。', 120, 120],
        [
          '研究 / research',
          'google',
          '研究',
          '查找可靠资料并核实假设，标明来源与不确定性。',
          880,
          120,
        ],
        ['测试 / tests', 'claude', '测试设计', '根据任务要求设计可执行测试和边界用例。', 100, 510],
        [
          '审查 / review',
          'grok',
          '独立审查',
          '从不同角度审查方案中的风险和遗漏，不编造检查结果。',
          900,
          510,
        ],
        [
          '汇总 / delivery',
          'codex',
          '汇总',
          '结合全部上游产物进行最终核对，输出清晰交付说明与待办。',
          500,
          740,
        ],
      ];
      const nodes = roles.map(([name, provider, role, instructions, x, y], i) =>
        makeNode(
          p.id,
          'agent',
          { name, provider, role, instructions, orchestrator: i === 0 },
          { x, y },
        ),
      );
      store.state.nodes.push(...nodes);
      for (let i = 1; i <= 4; i++) {
        store.state.edges.push({ id: uid('edge_'), source: nodes[0].id, target: nodes[i].id });
        store.state.edges.push({ id: uid('edge_'), source: nodes[i].id, target: nodes[5].id });
      }
      store.changed(true);
      return res.json({ nodes });
    }
    const definitions =
      req.body.kind === 'research'
        ? [
            ['Claude', 'claude', '任务规划', '把目标拆成可核实的调研问题，列清证据与交付要求。'],
            ['资料研究', 'google', '研究与核对', '检索来源并比较结论。明确证据、日期和不确定性。'],
            [
              '交付汇总',
              'codex',
              '汇总与制作',
              '读取上游材料，形成中文报告和可编辑文件；验证输出文件存在。',
            ],
          ]
        : [
            [
              '任务规划',
              'claude',
              '规划',
              '阅读现有项目，分析需求并拆成可执行的步骤，明确接口与验收条件。',
            ],
            ['代码实现', 'codex', '开发', '依据上游计划实现代码，运行相关检查并报告真实结果。'],
            ['独立审查', 'claude', '审查', '检查实现与目标是否一致，列出有证据的缺陷和验证限制。'],
          ];
    const nodes = definitions.map(([name, provider, role, instructions], i) =>
      makeNode(
        p.id,
        'agent',
        {
          name,
          provider,
          role,
          instructions,
          orchestrator: i === 0,
          mode: i === 2 ? 'read' : 'ask',
        },
        { x: baseX + i * 410, y: 160 },
      ),
    );
    store.state.nodes.push(...nodes);
    for (let i = 0; i < nodes.length - 1; i++)
      store.state.edges.push({ id: uid('edge_'), source: nodes[i].id, target: nodes[i + 1].id });
    const note = makeNode(
      p.id,
      'note',
      {
        name: '团队约定',
        content:
          '1. 只报告实际完成的文件与验证。\n2. 上游结果会沿箭头传递。\n3. 工具不存在、未登录或执行失败时明确报告。\n4. 在当前项目范围内工作。',
      },
      { x: baseX + 410, y: 560 },
    );
    store.state.nodes.push(note);
    for (const n of nodes)
      store.state.edges.push({ id: uid('edge_'), source: n.id, target: note.id });
    store.changed(true);
    res.json({ nodes });
  });
  app.post('/api/tasks', (req, res) =>
    res.json(runtime.createTask(req.body.nodeId, req.body.prompt)),
  );
  app.post('/api/arrangements', (req, res) => {
    store.project(req.body.projectId);
    const nodes = store.state.nodes.filter((n) => n.projectId === req.body.projectId);
    if (!nodes.length) throw new Error('当前工作台没有可保存的节点');
    const ids = new Set(nodes.map((n) => n.id));
    const arrangement = {
      id: uid('arr_'),
      name: String(req.body.name || '团队模板').slice(0, 80),
      createdAt: stamp(),
      nodes: nodes.map((n) => ({
        ...structuredClone(n),
        data: { ...structuredClone(n.data), sessionId: null },
      })),
      edges: structuredClone(
        store.state.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
      ),
    };
    store.state.arrangements.push(arrangement);
    store.changed(true);
    res.json({ id: arrangement.id });
  });
  app.post('/api/arrangements/:id/apply', (req, res) => {
    const a = store.state.arrangements.find((a) => a.id === req.params.id);
    if (!a) throw new Error('团队模板不存在');
    const p = store.project(req.body.projectId);
    const offset = store.state.nodes.some((n) => n.projectId === p.id) ? 70 : 0;
    const ids = new Map(a.nodes.map((n) => [n.id, uid('n_')]));
    const nodes = a.nodes.map((n) => ({
      ...structuredClone(n),
      id: ids.get(n.id),
      projectId: p.id,
      position: { x: n.position.x + offset, y: n.position.y + offset },
      data: { ...structuredClone(n.data), sessionId: null },
    }));
    store.state.nodes.push(...nodes);
    store.state.edges.push(
      ...a.edges.map((e) => ({
        id: uid('edge_'),
        source: ids.get(e.source),
        target: ids.get(e.target),
      })),
    );
    store.changed(true);
    res.json({ nodes });
  });
  app.delete('/api/arrangements/:id', (req, res) => {
    store.state.arrangements = store.state.arrangements.filter((a) => a.id !== req.params.id);
    store.changed(true);
    res.json({ ok: true });
  });
  app.post('/api/tasks/:id/stop', (req, res) => {
    runtime.stop(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/tasks/:id/retry', (req, res) => {
    const t = store.task(req.params.id);
    if (['queued', 'running', 'waiting_approval'].includes(t.status))
      throw new Error('原任务仍在执行');
    res.json(runtime.createTask(t.nodeId, t.prompt, { retryOf: t.id }));
  });
  app.post('/api/runs', (req, res) => {
    if (!req.body.prompt?.trim()) throw new Error('请输入总目标');
    res.json(runtime.workflow(req.body.projectId, req.body.prompt, req.body.nodeIds));
  });
  app.post('/api/runs/:id/stop', (req, res) => {
    runtime.stopRun(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/approvals/:id', (req, res) => {
    runtime.respond(req.params.id, req.body.answer);
    res.json({ ok: true });
  });
  app.patch('/api/settings', (req, res) => {
    for (const key of ['maxConcurrency', 'maxTaskMinutes'])
      if (key in req.body) {
        const value = Number(req.body[key]);
        if (!Number.isFinite(value) || value < 1 || value > (key === 'maxConcurrency' ? 8 : 240))
          throw new Error('设置数值不在允许范围');
        store.state.settings[key] = value;
      }
    for (const key of ['theme', 'reduceMotion', 'notifications', 'autoBackup', 'keepAlive'])
      if (key in req.body) {
        if (key === 'theme' && !['light', 'dark', 'system'].includes(req.body[key]))
          throw new Error('未知主题');
        store.state.settings[key] = req.body[key];
      }
    if (req.body.lastProjectId) {
      store.project(req.body.lastProjectId);
      store.state.settings.lastProjectId = req.body.lastProjectId;
    }
    if (req.body.provider) {
      const { id, ...input } = req.body.provider;
      if (!discover(store.state.settings).some((p) => p.id === id)) throw new Error('未知连接');
      const config = store.state.settings.providers[id] || {};
      for (const key of [
        'executable',
        'protocol',
        'args',
        'prefixArgs',
        'baseUrl',
        'model',
        'resumeFlag',
        'loginArgs',
        'readOnlyArgs',
      ])
        if (key in input) {
          if (
            ['args', 'prefixArgs', 'loginArgs', 'readOnlyArgs'].includes(key) &&
            (!Array.isArray(input[key]) || input[key].some((a) => typeof a !== 'string'))
          )
            throw new Error('命令参数必须为字符串数组');
          config[key] = input[key];
        }
      if (input.apiKey) {
        if (options.encrypt) config.encryptedKey = options.encrypt(input.apiKey);
        else secrets.set(id, input.apiKey);
        config.hasKey = true;
      }
      if (input.clearKey) {
        delete config.encryptedKey;
        delete config.hasKey;
        secrets.delete(id);
      }
      store.state.settings.providers[id] = config;
    }
    store.changed(true);
    res.json({ ok: true });
  });
  app.post('/api/providers/:id/check', async (req, res) => {
    const provider = discover(store.state.settings, true).find((p) => p.id === req.params.id);
    if (!provider) throw new Error('未知连接');
    if (provider.protocol === 'api')
      return res.json({
        installed: true,
        auth: readKey(provider.id) ? 'key_configured' : 'missing_key',
        message: '仅检查 Key 是否设置，没有调用模型',
      });
    if (!provider.executable) throw new Error('未找到工具可执行文件');
    const version = await capture(provider.executable, ['--version'], { timeout: 12000 });
    let auth = 'not_checked';
    if (provider.id === 'claude') {
      const check = await capture(provider.executable, ['auth', 'status'], { timeout: 10000 });
      try {
        const status = JSON.parse(check.stdout);
        auth =
          status.loggedIn || status.authenticated
            ? 'signed_in'
            : check.code === 0
              ? 'signed_in'
              : 'signed_out';
      } catch {
        auth = check.code === 0 ? 'signed_in' : 'signed_out';
      }
    }
    if (provider.id === 'codex') {
      const check = await capture(provider.executable, ['login', 'status'], { timeout: 10000 });
      auth = check.code === 0 ? 'signed_in' : 'signed_out';
    }
    res.json({
      installed: version.code === 0,
      version: version.stdout.trim().slice(0, 250),
      auth,
      message: '已检查本机工具；没有向模型发送任务',
    });
  });
  app.post('/api/terminals', (req, res) => {
    const p = store.project(req.body.projectId);
    let launch;
    if (req.body.provider) {
      const provider = discover(store.state.settings).find((p) => p.id === req.body.provider);
      if (!provider?.executable) throw new Error('未找到工具');
      const args =
        store.state.settings.providers[provider.id]?.loginArgs ||
        (provider.id === 'claude' ? ['auth', 'login'] : ['login']);
      launch = { executable: provider.executable, args };
    }
    if (req.body.accountId) {
      const a = store.state.accounts.find(
        (a) => a.id === req.body.accountId && a.provider === req.body.provider,
      );
      if (!a) throw new Error('账号配置不存在');
      if (launch)
        launch.env = {
          [a.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: a.configDirectory,
        };
    }
    res.json(
      terminals.open(
        p.directory,
        launch,
        req.body.provider ? `${req.body.provider} 登录` : 'PowerShell',
      ),
    );
  });
  app.get('/api/terminals/:id', (req, res) => {
    const t = terminals.items.get(req.params.id);
    if (!t) throw new Error('终端不存在');
    res.json({ output: t.output, alive: t.alive });
  });
  app.delete('/api/terminals/:id', (req, res) => {
    terminals.close(req.params.id);
    res.json({ ok: true });
  });
  app.get('/api/files', (req, res) =>
    res.json(listFiles(store.project(req.query.projectId).directory, req.query.path || '.')),
  );
  app.get('/api/file', (req, res) =>
    res.json({ content: readText(store.project(req.query.projectId).directory, req.query.path) }),
  );
  app.put('/api/file', (req, res) => {
    const p = store.project(req.body.projectId);
    const destination = safePath(p.directory, req.body.path, true);
    if (typeof req.body.content !== 'string' || req.body.content.length > 2_000_000)
      throw new Error('文件内容无效或过大');
    if (
      req.body.expectedContent !== undefined &&
      fs.existsSync(destination) &&
      fs.readFileSync(destination, 'utf8') !== req.body.expectedContent
    )
      throw new Error('文件已被其他进程修改，未覆盖。请保留草稿并重新读取文件进行合并。');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, req.body.content, 'utf8');
    res.json({ ok: true });
  });
  app.get('/api/git', async (req, res) => {
    const p = store.project(req.query.projectId);
    try {
      const branch = (await git(p.directory, ['branch', '--show-current'])).trim();
      const status = await git(p.directory, ['status', '--porcelain=v1']);
      const diff = await git(p.directory, ['diff', '--stat']);
      res.json({ isRepo: true, branch, status, diff });
    } catch (e) {
      res.json({ isRepo: false, error: e.message });
    }
  });
  app.get('/api/diff', async (req, res) => {
    const p = store.project(req.query.projectId);
    const file = path.relative(p.directory, safePath(p.directory, req.query.path));
    res.json({
      diff: await git(p.directory, [
        'diff',
        req.query.staged === '1' ? '--cached' : '--no-ext-diff',
        '--',
        file,
      ]),
    });
  });
  app.post('/api/git/stage', async (req, res) => {
    const p = store.project(req.body.projectId);
    const file = path.relative(p.directory, safePath(p.directory, req.body.path));
    await git(
      p.directory,
      req.body.unstage ? ['restore', '--staged', '--', file] : ['add', '--', file],
    );
    res.json({ ok: true });
  });
  app.post('/api/git/commit', async (req, res) => {
    const p = store.project(req.body.projectId);
    const message = String(req.body.message || '').trim();
    if (!message) throw new Error('请输入提交说明');
    res.json({ output: await git(p.directory, ['commit', '-m', message]) });
  });
  app.post('/api/worktrees', async (req, res) => {
    const p = store.project(req.body.projectId);
    const branch =
      'studio/' +
      String(req.body.name || '')
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .slice(0, 50);
    if (branch === 'studio/') throw new Error('请输入英文分支名称');
    const root = path.join(directory, 'worktrees');
    fs.mkdirSync(root, { recursive: true });
    const destination = path.join(root, uid('layer_'));
    await git(p.directory, ['worktree', 'add', '-b', branch, destination]);
    const layer = {
      id: uid('p_'),
      name: `${p.name} / ${req.body.name}`,
      directory: destination,
      createdAt: stamp(),
      parentId: p.id,
      branch,
      createdByStudio: true,
    };
    store.state.projects.push(layer);
    store.changed(true);
    res.json(layer);
  });
  app.post('/api/worktrees/:id/land', async (req, res) => {
    const p = store.project(req.params.id);
    if (!p.parentId || !p.createdByStudio) throw new Error('此工作区不是由应用创建的分支');
    const parent = store.project(p.parentId);
    if (
      (await git(parent.directory, ['status', '--porcelain'])).trim() ||
      (await git(p.directory, ['status', '--porcelain'])).trim()
    )
      throw new Error('请先提交或处理主目录与分支目录的未提交改动');
    if (
      store.state.tasks.some(
        (t) =>
          [p.id, parent.id].includes(t.projectId) &&
          ['running', 'waiting_approval'].includes(t.status),
      )
    )
      throw new Error('请先停止相关 Agent');
    try {
      const output = await git(parent.directory, ['merge', '--no-edit', p.branch]);
      store.event('git', '已合并分支 ' + p.branch, { projectId: parent.id });
      res.json({ output });
    } catch (e) {
      try {
        await git(parent.directory, ['merge', '--abort']);
      } catch {}
      throw new Error('合并未完成，已尝试恢复合并前状态。' + e.message);
    }
  });
  app.get('/api/export', (req, res) => {
    const data = store.snapshot();
    data.settings.providers = {};
    data.accounts = [];
    res.setHeader('Content-Disposition', 'attachment; filename="agent-studio-workspace.json"');
    res.json(data);
  });
  app.post('/api/import', (req, res) => {
    const data = req.body;
    if (
      data.schemaVersion !== 1 ||
      !Array.isArray(data.projects) ||
      !Array.isArray(data.nodes) ||
      !Array.isArray(data.edges)
    )
      throw new Error('无效的工作区备份');
    if (runtime.active.size || store.state.tasks.some((t) => t.status === 'queued'))
      throw new Error('请先停止所有运行或排队任务');
    const backup = path.join(directory, `before-import-${Date.now()}.json`);
    fs.copyFileSync(store.file, backup);
    store.state.projects = data.projects.map((p) => ({
      ...p,
      directory: assertDirectory(p.directory),
    }));
    store.state.nodes = data.nodes;
    store.state.edges = data.edges;
    store.state.tasks = (data.tasks || []).map((t) => ({
      ...t,
      status: ['queued', 'running', 'waiting_approval'].includes(t.status)
        ? 'interrupted'
        : t.status,
    }));
    store.state.runs = (data.runs || []).map((r) => ({
      ...r,
      status: r.status === 'running' ? 'interrupted' : r.status,
    }));
    for (const key of ['roles', 'folders', 'bookmarks'])
      if (Array.isArray(data[key])) store.state[key] = data[key];
    store.state.arrangements = Array.isArray(data.arrangements) ? data.arrangements : [];
    store.state.routines = (data.routines || []).map((r) => ({ ...r, enabled: false }));
    store.changed(true);
    res.json({ ok: true });
  });
  app.get('/api/tasks/:id/export', (req, res) => {
    const t = store.task(req.params.id);
    const node = store.state.nodes.find((n) => n.id === t.nodeId);
    res.setHeader('Content-Disposition', `attachment; filename="task-${t.id}.md"`);
    res
      .type('text/markdown')
      .send(
        `# ${node?.data.name || 'Agent'}\n\n状态：${t.status}\n\n## 任务\n\n${t.prompt}\n\n## 结果\n\n${t.output}\n\n${t.error ? '## 错误\n\n' + t.error : ''}`,
      );
  });
  app.post('/api/routines', (req, res) => {
    const p = store.project(req.body.projectId);
    const interval = Math.max(1, Math.min(10080, Number(req.body.minutes) || 60));
    if (!req.body.prompt?.trim()) throw new Error('请输入定时任务内容');
    const routine = {
      id: uid('routine_'),
      projectId: p.id,
      name: String(req.body.name || '定时任务'),
      prompt: req.body.prompt,
      minutes: interval,
      schedule: req.body.schedule || { kind: 'interval', minutes: interval },
      nextAt: nextScheduled(req.body.schedule || { kind: 'interval', minutes: interval }),
      enabled: req.body.enabled === true,
      lastAt: null,
    };
    store.state.routines.push(routine);
    store.changed(true);
    res.json(routine);
  });
  app.patch('/api/routines/:id', (req, res) => {
    const r = store.state.routines.find((r) => r.id === req.params.id);
    if (!r) throw new Error('定时任务不存在');
    r.enabled = !!req.body.enabled;
    r.nextAt = nextScheduled(r.schedule || { kind: 'interval', minutes: r.minutes });
    if (r.nextAt === null) r.enabled = false;
    store.changed(true);
    res.json(r);
  });
  app.delete('/api/routines/:id', (req, res) => {
    store.state.routines = store.state.routines.filter((r) => r.id !== req.params.id);
    store.changed(true);
    res.json({ ok: true });
  });
  app.post('/api/portal/:id', async (req, res) => {
    const n = store.node(req.params.id);
    if (n.type !== 'portal') throw new Error('不是浏览器节点');
    if (!options.portal) throw new Error('浏览器面板需要桌面版本');
    res.json(await options.portal(n, req.body.action || 'snapshot', req.body));
  });
  app.post('/api/dialog/directory', async (req, res) =>
    res.json({ directory: (await options.pickDirectory?.()) || null }),
  );
  app.post('/api/dialog/file', async (req, res) =>
    res.json({ file: (await options.pickFile?.()) || null }),
  );
  app.post('/api/open-folder', async (req, res) => {
    const p = store.project(req.body.projectId);
    await options.openFolder?.(p.directory);
    res.json({ ok: true });
  });
  async function bridgeCall(capability, method, args) {
    if (!method?.startsWith('browser_')) return runtime.bridgeCall(capability, method, args);
    const cap = runtime.capabilities.get(capability);
    if (!cap) throw new Error('协作凭据无效');
    const node = runtime
      .connected(cap.nodeId)
      .find((n) => n.id === args.portalId && n.type === 'portal');
    if (!node) throw new Error('只能操作已连接的浏览器节点');
    if (!options.portal) throw new Error('浏览器功能需要桌面版本');
    return options.portal(node, method.slice(8), args);
  }
  runtime.externalToolCall = bridgeCall;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1000000 });
  server.on('upgrade', (req, socket, head) => {
    if (!originOk(req) || !authorized(req)) return socket.destroy();
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws));
  });
  const broadcast = (value) => {
    const data = JSON.stringify(value);
    for (const ws of sockets.clients)
      if (ws.readyState === 1 && ws.bufferedAmount < 4_000_000) ws.send(data);
  };
  let pendingSnapshot;
  store.on('change', () => {
    if (!pendingSnapshot)
      pendingSnapshot = setTimeout(() => {
        pendingSnapshot = null;
        broadcast({ type: 'state', state: snapshot() });
      }, 100);
  });
  runtime.on('delta', (value) => broadcast({ type: 'delta', ...value }));
  terminals.on('data', (value) => broadcast({ type: 'terminal', ...value }));
  terminals.on('exit', (value) => broadcast({ type: 'terminal_exit', ...value }));
  sockets.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'state', state: snapshot() }));
    ws.on('message', (data) => {
      try {
        const m = JSON.parse(data.toString());
        if (m.type === 'terminal_input') terminals.write(m.id, m.data);
        else if (m.type === 'terminal_resize') terminals.resize(m.id, m.cols, m.rows);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', error: e.message }));
      }
    });
  });
  app.get('/', (req, res, next) => {
    if (valid(req.query.token)) {
      res.cookie('studio_session', token, { httpOnly: true, sameSite: 'strict', path: '/' });
      return res.redirect('/');
    }
    next();
  });
  app.use(express.static(path.join(ROOT, 'dist'), { index: 'index.html' }));
  app.use((error, req, res, next) => {
    if (!res.headersSent) res.status(400).json({ error: scrubError(error.message) });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  url = `http://127.0.0.1:${server.address().port}`;
  runtime.url = url;
  const scheduler = setInterval(() => {
    for (const r of store.state.routines) {
      if (!r.enabled || r.nextAt === null || r.nextAt > Date.now()) continue;
      r.nextAt = nextScheduled(r.schedule || { kind: 'interval', minutes: r.minutes });
      if (r.nextAt === null) r.enabled = false;
      if (
        store.state.tasks.some(
          (t) =>
            t.projectId === r.projectId &&
            ['queued', 'running', 'waiting_approval'].includes(t.status),
        )
      ) {
        store.event('routine', '工作区忙碌，已跳过本次定时任务', { projectId: r.projectId });
        continue;
      }
      try {
        r.lastAt = stamp();
        runtime.workflow(r.projectId, r.prompt);
      } catch (e) {
        store.event('error', '定时任务未启动：' + e.message, { projectId: r.projectId });
      }
      store.changed(true);
    }
  }, 1000);
  scheduler.unref();
  return {
    app,
    server,
    store,
    runtime,
    terminals,
    url,
    launchUrl: `${url}/?token=${token}`,
    token,
    close: async () => {
      clearInterval(scheduler);
      clearTimeout(pendingSnapshot);
      runtime.close();
      terminals.closeAll();
      for (const ws of sockets.clients) ws.close();
      sockets.close();
      store.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
const scrubError = (text) => String(text).replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]');
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createStudio({ port: Number(process.env.STUDIO_PORT) || 7790 })
    .then((studio) => {
      console.log(`Agent Studio: ${studio.launchUrl}`);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
        process.once(signal, async () => {
          await studio.close();
          process.exit(0);
        });
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
