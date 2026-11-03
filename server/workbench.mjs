import fs from 'node:fs';
import path from 'node:path';
import { uid, stamp, makeNode } from './store.mjs';
import { git, assertDirectory } from './system.mjs';

export function registerWorkbench(app, { store, runtime, terminals, options }) {
  for (const key of ['accounts', 'roles', 'folders', 'bookmarks']) store.state[key] ||= [];
  const done = (res) => {
    store.changed(true);
    res.json({ ok: true });
  };
  app.post('/api/broadcast', (req, res) => {
    const ids = [...new Set(req.body.nodeIds || [])];
    if (
      !ids.length ||
      ids.length > 40 ||
      typeof req.body.prompt !== 'string' ||
      !req.body.prompt.trim()
    )
      throw new Error('请选择成员并填写任务');
    for (const id of ids) if (store.node(id).type !== 'agent') throw new Error('只能向 Agent 广播');
    res.json({ tasks: ids.map((id) => runtime.createTask(id, req.body.prompt)) });
  });
  app.post('/api/attachments', (req, res) => {
    const project = store.project(req.body.projectId),
      filename = String(req.body.name || 'attachment')
        .replace(/[^\p{L}\p{N}._-]/gu, '_')
        .slice(-160);
    if (typeof req.body.base64 !== 'string' || req.body.base64.length > 12_000_000)
      throw new Error('附件不能超过 8 MB');
    const bytes = Buffer.from(req.body.base64, 'base64');
    if (bytes.length > 8_000_000) throw new Error('附件过大');
    const folder = path.join(project.directory, '.agent-studio-attachments');
    if (fs.existsSync(folder) && fs.lstatSync(folder).isSymbolicLink())
      throw new Error('附件目录不能是符号链接');
    fs.mkdirSync(folder, { recursive: true });
    const id = uid('att_');
    const file = path.join(folder, id + '-' + filename);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    res.json({ name: filename, path: file, size: bytes.length });
  });
  app.post('/api/roles', (req, res) => {
    const role = {
      id: uid('role_'),
      name: String(req.body.name || '新角色').slice(0, 80),
      instructions: String(req.body.instructions || '').slice(0, 50000),
    };
    store.state.roles.push(role);
    store.changed(true);
    res.json(role);
  });
  app.delete('/api/roles/:id', (req, res) => {
    store.state.roles = store.state.roles.filter((r) => r.id !== req.params.id);
    done(res);
  });
  app.post('/api/accounts', (req, res) => {
    const provider = req.body.provider;
    if (!['codex', 'claude'].includes(provider))
      throw new Error('独立配置目录目前支持 Codex 与 Claude Code；其他工具使用自己的登录入口');
    const id = uid('account_'),
      configDirectory = req.body.configDirectory
        ? assertDirectory(req.body.configDirectory)
        : path.join(store.directory, 'accounts', id);
    fs.mkdirSync(configDirectory, { recursive: true });
    const account = {
      id,
      provider,
      name: String(req.body.name || '独立账号').slice(0, 80),
      configDirectory,
    };
    store.state.accounts.push(account);
    store.changed(true);
    res.json(account);
  });
  app.delete('/api/accounts/:id', (req, res) => {
    if (
      store.state.tasks.some(
        (t) =>
          ['running', 'waiting_approval'].includes(t.status) &&
          store.state.nodes.find((n) => n.id === t.nodeId)?.data.accountId === req.params.id,
      )
    )
      throw new Error('账号正在使用中');
    store.state.accounts = store.state.accounts.filter((a) => a.id !== req.params.id);
    for (const n of store.state.nodes)
      if (n.data.accountId === req.params.id) {
        n.data.accountId = '';
        n.data.sessionId = null;
      }
    done(res);
  });
  app.post('/api/bookmarks', (req, res) => {
    const project = store.project(req.body.projectId),
      slot = Number(req.body.slot),
      view = req.body.view;
    if (
      !Number.isInteger(slot) ||
      slot < 1 ||
      slot > 9 ||
      !Number.isFinite(view?.x) ||
      !Number.isFinite(view?.y) ||
      !Number.isFinite(view?.zoom)
    )
      throw new Error('无效的视图书签');
    store.state.bookmarks = store.state.bookmarks.filter(
      (b) => !(b.projectId === project.id && b.slot === slot),
    );
    store.state.bookmarks.push({
      projectId: project.id,
      slot,
      name: String(req.body.name || `视图 ${slot}`).slice(0, 60),
      view: { x: view.x, y: view.y, zoom: Math.max(0.25, Math.min(2, view.zoom)) },
    });
    done(res);
  });
  app.delete('/api/bookmarks/:projectId/:slot', (req, res) => {
    store.state.bookmarks = store.state.bookmarks.filter(
      (b) => !(b.projectId === req.params.projectId && b.slot === Number(req.params.slot)),
    );
    done(res);
  });
  app.post('/api/folders', (req, res) => {
    const id = uid('folder_');
    if (req.body.parentId && !store.state.folders.some((f) => f.id === req.body.parentId))
      throw new Error('父文件夹不存在');
    store.state.folders.push({
      id,
      name: String(req.body.name || '新分组').slice(0, 80),
      parentId: req.body.parentId || null,
    });
    store.changed(true);
    res.json({ id });
  });
  app.post('/api/projects/:id/folder', (req, res) => {
    const p = store.project(req.params.id);
    if (req.body.folderId && !store.state.folders.some((f) => f.id === req.body.folderId))
      throw new Error('分组不存在');
    p.folderId = req.body.folderId || null;
    done(res);
  });
  app.delete('/api/folders/:id', (req, res) => {
    if (store.state.folders.some((f) => f.parentId === req.params.id))
      throw new Error('请先移出子分组');
    for (const p of store.state.projects) if (p.folderId === req.params.id) p.folderId = null;
    store.state.folders = store.state.folders.filter((f) => f.id !== req.params.id);
    done(res);
  });
  app.post('/api/layers/:id/archive', async (req, res) => {
    const p = store.project(req.params.id);
    if (!p.parentId) throw new Error('仅用于工作树图层');
    if (
      store.state.tasks.some(
        (t) => t.projectId === p.id && ['running', 'queued', 'waiting_approval'].includes(t.status),
      ) ||
      [...terminals.items.values()].some((t) => t.directory === p.directory && t.alive)
    )
      throw new Error('图层中还有运行进程');
    if ((await git(p.directory, ['status', '--porcelain'])).trim())
      throw new Error('请先处理图层未提交的改动');
    p.archived = true;
    done(res);
  });
  app.post('/api/layers/:id/restore', (req, res) => {
    store.project(req.params.id).archived = false;
    done(res);
  });
  app.post('/api/layers/:id/status', (req, res) => {
    const p = store.project(req.params.id);
    p.layerStatus = {
      state: String(req.body.state || 'working'),
      message: String(req.body.message || '').slice(0, 300),
    };
    done(res);
  });
  app.get('/api/git/history', async (req, res) => {
    const p = store.project(req.query.projectId);
    res.json({
      text: await git(p.directory, ['log', '-25', '--date=short', '--format=%h  %ad  %s']),
    });
  });
  app.post('/api/canvas/group', (req, res) => {
    const project = store.project(req.body.projectId),
      nodes = (req.body.nodeIds || []).map((id) => store.node(id));
    if (!nodes.length || nodes.some((n) => n.projectId !== project.id || n.type === 'frame'))
      throw new Error('请选择同一画布的普通节点');
    const x = Math.min(...nodes.map((n) => n.position.x)) - 35,
      y = Math.min(...nodes.map((n) => n.position.y)) - 60;
    const frame = makeNode(project.id, 'frame', { name: req.body.name || '团队分组' }, { x, y });
    frame.width = Math.max(...nodes.map((n) => n.position.x + (n.width || 270))) - x + 35;
    frame.height =
      Math.max(...nodes.map((n) => n.position.y + (n.type === 'agent' ? 100 : 210))) - y + 35;
    store.state.nodes.push(frame);
    for (const n of nodes) n.groupId = frame.id;
    store.changed(true);
    res.json(frame);
  });
  app.post('/api/canvas/delete', (req, res) => {
    const nodes = (req.body.nodeIds || []).map((id) => store.node(id)),
      ids = new Set(nodes.map((n) => n.id));
    if (nodes.some((n) => n.projectId !== req.body.projectId))
      throw new Error('节点不属于当前画布');
    if (
      store.state.tasks.some(
        (t) => ids.has(t.nodeId) && ['running', 'queued', 'waiting_approval'].includes(t.status),
      )
    )
      throw new Error('请先停止选中节点的任务');
    for (const n of store.state.nodes) {
      if (ids.has(n.binderId)) delete n.binderId;
      if (ids.has(n.groupId)) delete n.groupId;
    }
    for (const n of nodes) options.closePortal?.(n.id);
    store.state.nodes = store.state.nodes.filter((n) => !ids.has(n.id));
    store.state.edges = store.state.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target));
    done(res);
  });
  app.post('/api/canvas/ungroup', (req, res) => {
    const n = store.node(req.body.id);
    if (n.type !== 'frame') throw new Error('请选择分组');
    for (const child of store.state.nodes) if (child.groupId === n.id) delete child.groupId;
    store.state.nodes = store.state.nodes.filter((x) => x.id !== n.id);
    done(res);
  });
  app.post('/api/binders', (req, res) => {
    const p = store.project(req.body.projectId),
      notes = (req.body.nodeIds || []).map((id) => store.node(id));
    if (!notes.length || notes.some((n) => n.projectId !== p.id || n.type !== 'note' || n.binderId))
      throw new Error('请选择同一画布中未收纳的便签');
    const binder = makeNode(
      p.id,
      'binder',
      { name: req.body.name || '团队笔记本', noteIds: notes.map((n) => n.id) },
      { ...notes[0].position },
    );
    store.state.nodes.push(binder);
    for (const n of notes) n.binderId = binder.id;
    store.changed(true);
    res.json(binder);
  });
  app.post('/api/binders/:id/release', (req, res) => {
    const binder = store.node(req.params.id),
      note = store.node(req.body.noteId);
    if (binder.type !== 'binder' || note.binderId !== binder.id)
      throw new Error('便签不在此笔记本');
    delete note.binderId;
    note.position = { x: binder.position.x + 320, y: binder.position.y };
    binder.data.noteIds = binder.data.noteIds.filter((id) => id !== note.id);
    done(res);
  });
  app.post('/api/backup/create', (req, res) => {
    const data = store.snapshot();
    data.settings.providers = {};
    data.accounts = [];
    const folder = path.join(store.directory, 'backups');
    fs.mkdirSync(folder, { recursive: true });
    const name = `workspace-${Date.now()}.json`;
    fs.writeFileSync(path.join(folder, name), JSON.stringify(data), { mode: 0o600 });
    store.event('backup', '已创建本地备份');
    res.json({ name });
  });
  app.get('/api/backup/list', (req, res) => {
    const folder = path.join(store.directory, 'backups');
    res.json(
      fs.existsSync(folder)
        ? fs
            .readdirSync(folder)
            .filter((n) => /^workspace-(?:auto-)?\d+\.json$/.test(n))
            .sort()
            .reverse()
            .map((name) => ({ name, size: fs.statSync(path.join(folder, name)).size }))
        : [],
    );
  });
  app.get('/api/backup/:name', (req, res) => {
    if (!/^workspace-(?:auto-)?\d+\.json$/.test(req.params.name)) throw new Error('无效的备份名称');
    res.download(path.join(store.directory, 'backups', req.params.name));
  });
  const backupTick = setInterval(() => {
    if (!store.state.settings.autoBackup) return;
    const day = new Date().toISOString().slice(0, 10);
    if (store.state.settings.lastAutoBackupDay === day) return;
    const folder = path.join(store.directory, 'backups');
    fs.mkdirSync(folder, { recursive: true });
    const data = store.snapshot();
    data.settings.providers = {};
    data.accounts = [];
    fs.writeFileSync(path.join(folder, `workspace-auto-${Date.now()}.json`), JSON.stringify(data), {
      mode: 0o600,
    });
    store.state.settings.lastAutoBackupDay = day;
    store.changed(true);
    for (const file of fs.readdirSync(folder).filter((f) => /^workspace-auto-\d+\.json$/.test(f)))
      if (Date.now() - Number(file.slice(15, -5)) > 14 * 86400000)
        fs.unlinkSync(path.join(folder, file));
  }, 60000);
  backupTick.unref();
  const originalClose = store.close.bind(store);
  store.close = () => {
    clearInterval(backupTick);
    originalClose();
  };
}
