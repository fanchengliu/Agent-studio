const copy = (value) => (value === undefined ? undefined : structuredClone(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function difference(a, b, path = [], out = []) {
  if (same(a, b)) return out;
  if (
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (!['__proto__', 'constructor', 'prototype'].includes(key))
        difference(a[key], b[key], [...path, key], out);
  } else out.push({ path, before: copy(a), after: copy(b) });
  return out;
}
const get = (object, path) => path.reduce((o, k) => o?.[k], object);
function set(object, path, value) {
  let parent = object;
  for (const key of path.slice(0, -1)) {
    parent[key] ??= {};
    parent = parent[key];
  }
  if (value === undefined) delete parent[path.at(-1)];
  else parent[path.at(-1)] = copy(value);
}
export function canvasHistory(store) {
  const histories = new Map();
  const snapshot = (projectId) => {
    const nodes = store.state.nodes.filter((n) => n.projectId === projectId),
      ids = new Set(nodes.map((n) => n.id));
    return {
      nodes: Object.fromEntries(nodes.map((n) => [n.id, copy(n)])),
      edges: Object.fromEntries(
        store.state.edges
          .filter((e) => ids.has(e.source) || ids.has(e.target))
          .map((e) => [e.id, copy(e)]),
      ),
    };
  };
  const stats = () =>
    Object.fromEntries(
      [...histories].map(([id, h]) => [id, { undo: h.undo.length, redo: h.redo.length }]),
    );
  const middleware = (req, res, next) => {
    if (
      !['POST', 'PATCH', 'DELETE'].includes(req.method) ||
      !/^\/(nodes|edges|template|binders|canvas\/(positions|group|ungroup|delete))($|\/)/.test(
        req.path,
      )
    )
      return next();
    let projectId = req.body?.projectId;
    if (!projectId) {
      const id = req.path.split('/')[2];
      projectId = store.state.nodes.find((n) => n.id === (req.body?.source || id))?.projectId;
      if (!projectId) {
        const edge = store.state.edges.find((e) => e.id === id);
        projectId = store.state.nodes.find((n) => n.id === edge?.source)?.projectId;
      }
    }
    if (!projectId && req.body?.id)
      projectId = store.state.nodes.find((n) => n.id === req.body.id)?.projectId;
    if (!projectId) return next();
    const before = snapshot(projectId);
    res.once('finish', () => {
      if (res.statusCode >= 400) return;
      const delta = difference(before, snapshot(projectId));
      if (!delta.length) return;
      const h = histories.get(projectId) || { undo: [], redo: [] };
      h.undo.push(delta);
      h.undo = h.undo.slice(-40);
      h.redo = [];
      histories.set(projectId, h);
      store.emit('change');
    });
    next();
  };
  const apply = (projectId, redo = false) => {
    const h = histories.get(projectId);
    const from = redo ? h?.redo : h?.undo,
      to = redo ? h?.undo : h?.redo;
    const delta = from?.at(-1);
    if (!delta) throw new Error(redo ? '没有可重做的操作' : '没有可撤销的操作');
    if (
      store.state.tasks.some(
        (t) =>
          t.projectId === projectId && ['running', 'queued', 'waiting_approval'].includes(t.status),
      )
    )
      throw new Error('请先停止当前工作台的任务，再撤销结构变更');
    const graph = snapshot(projectId);
    for (const d of delta)
      if (!same(get(graph, d.path), redo ? d.before : d.after))
        throw new Error('相关内容已被其他操作修改，无法直接撤销');
    for (const d of delta) set(graph, d.path, redo ? d.after : d.before);
    const oldIds = new Set(
      store.state.nodes.filter((n) => n.projectId === projectId).map((n) => n.id),
    );
    const restoredNodes = Object.values(graph.nodes);
    const finalIds = new Set([
      ...store.state.nodes.filter((n) => n.projectId !== projectId).map((n) => n.id),
      ...restoredNodes.map((n) => n.id),
    ]);
    if (Object.values(graph.edges).some((e) => !finalIds.has(e.source) || !finalIds.has(e.target)))
      throw new Error('连接的其他节点已经移除');
    store.state.nodes = [...store.state.nodes.filter((n) => !oldIds.has(n.id)), ...restoredNodes];
    store.state.edges = [
      ...store.state.edges.filter((e) => !oldIds.has(e.source) && !oldIds.has(e.target)),
      ...Object.values(graph.edges),
    ];
    from.pop();
    to.push(delta);
    store.changed(true);
    return stats();
  };
  return { middleware, apply, stats };
}
