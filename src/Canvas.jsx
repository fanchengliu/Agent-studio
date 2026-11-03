import React, { useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  applyNodeChanges,
  MarkerType,
  ConnectionMode,
  useReactFlow,
  useViewport,
} from '@xyflow/react';
import {
  MousePointer2,
  Hand,
  Plus,
  Minus,
  Maximize,
  Map as MapIcon,
  FileText,
  Globe,
  TerminalSquare,
  Workflow,
  SquareDashed,
  Undo2,
  Redo2,
  Copy,
  Trash2,
  SlidersHorizontal,
  Scan,
  Expand,
  ArrowUpRight,
  PenLine,
  Type,
  LockKeyhole,
  Layers,
  BookOpen,
} from 'lucide-react';
import { nodeTypes } from './nodes.jsx';
import { useStudio } from './context.jsx';
export default function Canvas({ nodes, setNodes, tab, addNode, template }) {
  const {
    state,
    project,
    selectNode,
    request,
    canvasExpanded,
    setCanvasExpanded,
    selectionRef,
    pendingPositions,
  } = useStudio();
  const flow = useReactFlow(),
    { zoom } = useViewport();
  const [tool, setTool] = useState('select'),
    [minimap, setMinimap] = useState(false),
    [context, setContext] = useState(null),
    [space, setSpace] = useState(false),
    [, setRevision] = useState(0),
    [snap, setSnap] = useState(false);
  const [selectedCount, setSelectedCount] = useState(0),
    [drawPoints, setDrawPoints] = useState([]);
  const drawRef = useRef([]);
  const history = useRef({ undo: [], redo: [] }),
    dragging = useRef(null),
    selectedIds = useRef([]);
  const current = state.nodes.filter((n) => n.projectId === project.id && !n.binderId),
    byId = new Map(current.map((n) => [n.id, n]));
  const edges = state.edges
    .filter((e) => byId.has(e.source) && byId.has(e.target))
    .map((e) => {
      const a = byId.get(e.source),
        b = byId.get(e.target),
        dx = b.position.x - a.position.x,
        dy = b.position.y - a.position.y,
        vertical = Math.abs(dy) > Math.abs(dx) * 0.7;
      const running = state.tasks.some((t) => t.nodeId === e.source && t.status === 'running');
      return {
        ...e,
        sourceHandle: vertical ? (dy > 0 ? 'bottom' : 'top') : dx > 0 ? 'right' : 'left',
        targetHandle: vertical ? (dy > 0 ? 'top' : 'bottom') : dx > 0 ? 'left' : 'right',
        type: 'default',
        animated: running,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: running ? '#53886f' : '#aeb1b7',
        },
        className: running ? 'edge-running' : '',
      };
    });
  const savePositions = async (positions, record = true) => {
    const before = positions.map((p) => ({
      id: p.id,
      position: { ...state.nodes.find((n) => n.id === p.id)?.position },
    }));
    const result = await request('/canvas/positions', { projectId: project.id, positions });
    if (result && record) {
      history.current.undo.push({ before, after: positions });
      history.current.undo = history.current.undo.slice(-30);
      history.current.redo = [];
      setRevision((r) => r + 1);
    }
    return result;
  };
  const undo = async (redo) => request('/canvas/undo', { projectId: project.id, redo });
  useEffect(() => {
    history.current = { undo: [], redo: [] };
    setContext(null);
  }, [project.id]);
  useEffect(() => {
    const down = (e) => {
      if (
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) ||
        e.target.isContentEditable ||
        document.querySelector('[role="dialog"]')
      )
        return;
      if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault();
        const slot = Number(e.code.slice(-1));
        if (e.ctrlKey)
          request('/bookmarks', { projectId: project.id, slot, view: flow.getViewport() });
        else {
          const mark = state.bookmarks?.find((b) => b.projectId === project.id && b.slot === slot);
          if (mark) flow.setViewport(mark.view, { duration: 250 });
        }
      }
      if (e.code === 'Space') {
        e.preventDefault();
        setSpace(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo(e.shiftKey);
      }
      if (e.key.toLowerCase() === 'v') setTool('select');
      if (e.key.toLowerCase() === 'h') setTool('hand');
      if (e.code === 'Digit1' && e.shiftKey)
        flow.fitView({ padding: 0.3, duration: 250, maxZoom: 1.2 });
      if (e.key.toLowerCase() === 'f' && selectedIds.current.length)
        flow.fitView({
          nodes: selectedIds.current.map((id) => ({ id })),
          padding: 0.7,
          maxZoom: 1.4,
          duration: 250,
        });
      if (e.key === 'Escape') setContext(null);
      if (
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) &&
        selectedIds.current.length
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 20 : 5;
        const positions = flow
          .getNodes()
          .filter(
            (n) =>
              selectedIds.current.includes(n.id) && !state.nodes.find((s) => s.id === n.id)?.locked,
          )
          .map((n) => ({
            id: n.id,
            position: {
              x: n.position.x + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0),
              y: n.position.y + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0),
            },
          }));
        savePositions(positions);
      }
    };
    const up = (e) => {
        if (e.code === 'Space') setSpace(false);
      },
      blur = () => setSpace(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [state, project.id]);
  const organize = async () => {
    const agents = current.filter((n) => n.type === 'agent' && !n.locked),
      others = current.filter((n) => n.type !== 'agent' && !n.locked),
      positions = [];
    if (agents.length <= 3)
      agents.forEach((n, i) =>
        positions.push({ id: n.id, position: { x: 120 + i * 360, y: 180 } }),
      );
    else {
      const leader = agents.find((n) => n.data.orchestrator) || agents[0];
      positions.push({ id: leader.id, position: { x: 500, y: 320 } });
      const peers = agents.filter((n) => n.id !== leader.id);
      peers.forEach((n, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / peers.length;
        positions.push({
          id: n.id,
          position: {
            x: Math.round(500 + Math.cos(a) * 420),
            y: Math.round(320 + Math.sin(a) * 250),
          },
        });
      });
    }
    others.forEach((n, i) => positions.push({ id: n.id, position: { x: 130 + i * 320, y: 730 } }));
    if (await savePositions(positions))
      setTimeout(() => flow.fitView({ padding: 0.25, maxZoom: 1.05, duration: 350 }), 120);
  };
  const duplicate = async (node) => {
    const r = await request('/nodes', {
      projectId: project.id,
      type: node.type,
      data: { ...node.data, name: node.data.name + ' 副本', sessionId: null },
      position: { x: node.position.x + 45, y: node.position.y + 120 },
    });
    if (r) selectNode(r.id);
  };
  const openContext = (e, node = null) => {
    e.preventDefault();
    setContext({
      x: Math.min(e.clientX, window.innerWidth - 240),
      y: Math.min(e.clientY, window.innerHeight - 320),
      point: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
      node,
    });
  };
  return (
    <div
      className={`canvas-wrapper ${tab !== 'canvas' ? 'hidden' : ''} ${tool === 'hand' || space ? 'hand-tool' : ''}`}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        connectionMode={ConnectionMode.Loose}
        onNodesChange={(changes) => {
          for (const c of changes.filter((c) => c.type === 'select'))
            c.selected ? selectionRef.current.add(c.id) : selectionRef.current.delete(c.id);
          setNodes((ns) => applyNodeChanges(changes, ns));
        }}
        onSelectionChange={({ nodes: selected }) => {
          selectedIds.current = selected.map((n) => n.id);
          setSelectedCount(selected.length);
        }}
        onNodeDragStart={(e, n, selected) => {
          const ids = new Set((selected?.length ? selected : [n]).map((x) => x.id));
          if (n.type === 'frame')
            for (const x of current) if (x.groupId === n.id && !x.locked) ids.add(x.id);
          dragging.current = [...ids].map((id) => ({
            id,
            position: { ...state.nodes.find((s) => s.id === id).position },
          }));
          for (const p of dragging.current) pendingPositions.current[p.id] = p.position;
        }}
        onNodeDrag={(e, n, selected) => {
          for (const x of selected?.length ? selected : [n])
            pendingPositions.current[x.id] = x.position;
          if (n.type === 'frame' && dragging.current) {
            const before = dragging.current.find((p) => p.id === n.id);
            if (before) {
              const dx = n.position.x - before.position.x,
                dy = n.position.y - before.position.y;
              for (const p of dragging.current)
                if (p.id !== n.id)
                  pendingPositions.current[p.id] = { x: p.position.x + dx, y: p.position.y + dy };
              setNodes((ns) =>
                ns.map((x) =>
                  pendingPositions.current[x.id]
                    ? { ...x, position: pendingPositions.current[x.id] }
                    : x,
                ),
              );
            }
          }
        }}
        onNodeDragStop={async (e, n, selected) => {
          const after = (dragging.current || []).map((p) => ({
            id: p.id,
            position: pendingPositions.current[p.id] || p.position,
          }));
          const result = await request('/canvas/positions', {
            projectId: project.id,
            positions: after,
          });
          if (result) {
            history.current.undo.push({ before: dragging.current, after });
            history.current.redo = [];
            setRevision((r) => r + 1);
          }
          for (const p of after) delete pendingPositions.current[p.id];
          dragging.current = null;
        }}
        onNodeClick={(e, n) => {
          if (!e.shiftKey) selectNode(n.id);
        }}
        onNodeDoubleClick={(e, n) =>
          flow.fitView({ nodes: [{ id: n.id }], padding: 0.75, maxZoom: 1.4, duration: 250 })
        }
        onMoveEnd={(event, view) => {
          if (event) request(`/projects/${project.id}`, { view }, 'PATCH');
        }}
        onPaneClick={() => {
          selectNode(null);
          setContext(null);
        }}
        onPaneContextMenu={(e) => openContext(e)}
        onNodeContextMenu={openContext}
        onConnect={(c) => request('/edges', { source: c.source, target: c.target })}
        onEdgeDoubleClick={(e, edge) => request(`/edges/${edge.id}`, undefined, 'DELETE')}
        minZoom={0.25}
        maxZoom={2}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        deleteKeyCode={null}
        colorMode="light"
        fitView
        panOnDrag={tool === 'hand' || space ? true : [1]}
        selectionOnDrag={tool === 'select' && !space}
        multiSelectionKeyCode="Shift"
        snapToGrid={snap}
        snapGrid={[20, 20]}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Lines} gap={28} lineWidth={1} color="#e7e8eb" />
        {minimap && <MiniMap nodeColor="#c6c9d0" maskColor="#f3f4f6b0" pannable zoomable />}
      </ReactFlow>
      {tool === 'pen' && !space && (
        <svg
          className="pen-overlay"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
            drawRef.current = [[p.x, p.y]];
            setDrawPoints(drawRef.current);
          }}
          onPointerMove={(e) => {
            if (!e.buttons || !drawRef.current.length) return;
            const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
            drawRef.current = [...drawRef.current, [p.x, p.y]];
            setDrawPoints(drawRef.current);
          }}
          onPointerUp={async () => {
            const pts = drawRef.current;
            drawRef.current = [];
            setDrawPoints([]);
            if (pts.length < 2) return;
            const x = Math.min(...pts.map((p) => p[0])) - 3,
              y = Math.min(...pts.map((p) => p[1])) - 3;
            await request('/nodes', {
              projectId: project.id,
              type: 'drawing',
              position: { x, y },
              data: {
                name: '自由绘制',
                width: Math.max(...pts.map((p) => p[0])) - x + 4,
                height: Math.max(...pts.map((p) => p[1])) - y + 4,
                points: pts.map((p) => [p[0] - x, p[1] - y]),
              },
            });
          }}
        >
          <g
            transform={
              'translate(' +
              flow.getViewport().x +
              ',' +
              flow.getViewport().y +
              ') scale(' +
              zoom +
              ')'
            }
          >
            <polyline
              points={drawPoints.map((p) => p.join(',')).join(' ')}
              fill="none"
              stroke="#8598bd"
              strokeWidth="2"
            />
          </g>
        </svg>
      )}
      {selectedCount > 1 && (
        <div className="selection-toolbar">
          <span>{selectedCount} 个节点</span>
          <button
            title="建立分组"
            onClick={() =>
              request('/canvas/group', { projectId: project.id, nodeIds: selectedIds.current })
            }
          >
            <Layers size={15} />
          </button>
          <button
            title="便签合为笔记本"
            disabled={
              !selectedIds.current.every(
                (id) => state.nodes.find((n) => n.id === id)?.type === 'note',
              )
            }
            onClick={() =>
              request('/binders', { projectId: project.id, nodeIds: selectedIds.current })
            }
          >
            <BookOpen size={15} />
          </button>
        </div>
      )}
      <div className="canvas-viewbar">
        <span className="canvas-label">
          <i />
          {project.name}
        </span>
        <span className="viewbar-divider" />
        <span>{current.filter((n) => n.type === 'agent').length} 位成员</span>
        <div className="viewbar-actions">
          <button
            title="撤销画布操作（Ctrl+Z）"
            disabled={!state.canvasHistory?.[project.id]?.undo}
            onClick={() => undo(false)}
          >
            <Undo2 size={15} />
          </button>
          <button
            title="重做画布操作（Ctrl+Shift+Z）"
            disabled={!state.canvasHistory?.[project.id]?.redo}
            onClick={() => undo(true)}
          >
            <Redo2 size={15} />
          </button>
        </div>
      </div>
      <div className="canvas-rail" aria-label="画布工具">
        <button
          className={tool === 'select' ? 'active' : ''}
          title="选择与框选（V）"
          onClick={() => setTool('select')}
        >
          <MousePointer2 size={18} />
        </button>
        <button
          className={tool === 'hand' ? 'active' : ''}
          title="平移画布（H / 空格）"
          onClick={() => setTool('hand')}
        >
          <Hand size={18} />
        </button>
        <i />
        {[
          ['agent', Workflow, '添加 Agent'],
          ['terminal', TerminalSquare, '添加终端'],
          ['note', FileText, '添加便签'],
          ['portal', Globe, '添加浏览器'],
          ['frame', SquareDashed, '添加区域标注'],
          ['text', Type, '添加文字'],
        ].map(([type, Icon, label]) => (
          <button key={type} title={label} onClick={() => addNode(type)}>
            <Icon size={18} />
          </button>
        ))}
        <button
          title="自由画笔"
          className={tool === 'pen' ? 'active' : ''}
          onClick={() => setTool('pen')}
        >
          <PenLine size={18} />
        </button>
        <i />
        <button title="自动整理布局" onClick={organize}>
          <Scan size={18} />
        </button>
        <button
          title={canvasExpanded ? '收起节点详情' : '展开节点详情'}
          className={canvasExpanded ? 'active' : ''}
          onClick={() => setCanvasExpanded((v) => !v)}
        >
          <SlidersHorizontal size={18} />
        </button>
      </div>
      <div className="canvas-zoom">
        <button title="切换小地图" aria-pressed={minimap} onClick={() => setMinimap((v) => !v)}>
          <MapIcon size={17} />
        </button>
        <i />
        <button title="缩小" onClick={() => flow.zoomOut({ duration: 150 })}>
          <Minus size={17} />
        </button>
        <button
          className="zoom-percentage"
          title="重置为 100%"
          onClick={() => flow.zoomTo(1, { duration: 200 })}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button title="放大" onClick={() => flow.zoomIn({ duration: 150 })}>
          <Plus size={17} />
        </button>
        <i />
        <button
          title="适应全部节点（Shift+1）"
          onClick={() => flow.fitView({ padding: 0.25, maxZoom: 1.2, duration: 250 })}
        >
          <Maximize size={16} />
        </button>
      </div>
      {!!current.length && (
        <div className="canvas-hint">
          <span>空格拖动画布</span>
          <b>·</b>
          <span>双击节点聚焦</span>
          <b>·</b>
          <button className={snap ? 'enabled' : ''} onClick={() => setSnap((v) => !v)}>
            {snap ? '网格吸附已开' : '网格吸附'}
          </button>
        </div>
      )}
      {!current.length && (
        <div className="canvas-welcome">
          <div className="welcome-symbol">
            <Workflow size={26} strokeWidth={1.5} />
          </div>
          <span className="welcome-eyebrow">YOUR SPACE TO BUILD</span>
          <h1>让你的 AI，协作起来。</h1>
          <p>从一个团队开始，给每位成员安排擅长的工作。</p>
          <div className="welcome-presets">
            {[
              ['team', Workflow, '多专长团队', '主控 · 实现 · 研究 · 审查'],
              ['coding', TerminalSquare, '开发协作', '规划 → 实现 → 审查'],
              ['research', FileText, '研究与写作', '研究 → 核对 → 汇总'],
            ].map(([kind, Icon, title, hint]) => (
              <button key={kind} onClick={() => template(kind)}>
                <Icon size={20} />
                <span>
                  <strong>{title}</strong>
                  <small>{hint}</small>
                </span>
                <ArrowUpRight size={15} />
              </button>
            ))}
          </div>
          <button className="welcome-blank" onClick={() => addNode('agent')}>
            <Plus size={14} />
            从空白开始
          </button>
        </div>
      )}
      {context && (
        <>
          <div className="context-scrim" onClick={() => setContext(null)} />
          <div
            className="canvas-context-menu"
            style={{ left: context.x, top: context.y }}
            role="menu"
          >
            <span>{context.node ? context.node.data.name : '画布操作'}</span>
            {context.node ? (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    selectNode(context.node.id);
                    setContext(null);
                  }}
                >
                  <SlidersHorizontal size={15} />
                  查看节点详情
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    duplicate(context.node);
                    setContext(null);
                  }}
                >
                  <Copy size={15} />
                  复制节点
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    flow.fitView({ nodes: [{ id: context.node.id }], maxZoom: 1.3, padding: 0.75 });
                    setContext(null);
                  }}
                >
                  <Expand size={15} />
                  聚焦此节点
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    request(`/nodes/${context.node.id}`, { locked: !context.node.locked }, 'PATCH');
                    setContext(null);
                  }}
                >
                  <LockKeyhole size={15} />
                  {context.node.locked ? '解除锁定' : '锁定位置'}
                </button>
                {context.node.type === 'frame' && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      request('/canvas/ungroup', { id: context.node.id });
                      setContext(null);
                    }}
                  >
                    <Layers size={15} />
                    解除分组
                  </button>
                )}
                <hr />
                <button
                  role="menuitem"
                  className="danger"
                  onClick={async () => {
                    const r = await request(`/nodes/${context.node.id}`, undefined, 'DELETE');
                    if (r) selectNode(null);
                    setContext(null);
                  }}
                >
                  <Trash2 size={15} />
                  移除节点
                </button>
              </>
            ) : (
              <>
                {[
                  ['agent', Workflow, '添加 Agent'],
                  ['note', FileText, '添加便签'],
                  ['portal', Globe, '添加浏览器'],
                ].map(([type, Icon, title]) => (
                  <button
                    role="menuitem"
                    key={type}
                    onClick={() => {
                      addNode(type, context.point);
                      setContext(null);
                    }}
                  >
                    <Icon size={15} />
                    {title}
                  </button>
                ))}
                <hr />
                <button
                  role="menuitem"
                  onClick={() => {
                    organize();
                    setContext(null);
                  }}
                >
                  <Scan size={15} />
                  整理布局
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
