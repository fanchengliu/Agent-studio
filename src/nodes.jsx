import React, { memo, useState } from 'react';
import { Handle, Position, NodeResizer, useStore } from '@xyflow/react';
import {
  ArrowUpRight,
  MoreHorizontal,
  Play,
  FileText,
  Globe,
  TerminalSquare,
  Crown,
  GitBranch,
} from 'lucide-react';
import { useStudio } from './context.jsx';
import { statusLabels } from './api.js';
export function ProviderMark({ id, size = 28 }) {
  const icons = {
    claude: '✳',
    codex: '◈',
    google: '✦',
    grok: '𝕏',
    cursor: '↗',
    deepseek: '≈',
    opencode: '▣',
    gemini: '✦',
    custom: '⌘',
  };
  return (
    <span
      className={`provider-mark provider-${id}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {icons[id] || '⌘'}
    </span>
  );
}
function Ports() {
  return Object.entries({
    top: Position.Top,
    right: Position.Right,
    bottom: Position.Bottom,
    left: Position.Left,
  }).map(([id, position]) => <Handle key={id} id={id} type="source" position={position} />);
}
export const AgentNode = memo(function AgentNode({ id, data, selected }) {
  const { state, selectNode, setTarget, setInspectorTab, canvasExpanded } = useStudio();
  const zoom = useStore((s) => s.transform[2]);
  const provider = state.providers.find((p) => p.id === data.provider),
    task = state.tasks.filter((t) => t.nodeId === id).at(-1);
  const status = task?.status || (provider?.configured ? 'idle' : 'unconfigured');
  return (
    <div
      className={`agent-node ${selected ? 'selected' : ''} ${canvasExpanded ? 'expanded' : ''} ${zoom < 0.55 ? 'zoom-far' : ''}`}
    >
      <Ports />
      <div className="agent-node-head">
        <ProviderMark id={data.provider} />
        <strong>{data.name}</strong>
        <span
          className={`node-status-dot status-${status}`}
          title={
            task
              ? statusLabels[status]
              : status === 'idle'
                ? '工具已发现，等待任务'
                : '需要配置连接'
          }
        />
      </div>
      <div className="agent-node-sub">
        <GitBranch size={13} />
        <span>{provider?.name || data.provider}</span>
        <span className="node-meta-divider">·</span>
        <span>{task ? statusLabels[status] : status === 'idle' ? '待命' : '待连接'}</span>
        {data.orchestrator && <Crown size={13} className="node-crown" />}
      </div>
      {canvasExpanded && (
        <div className="node-expanded-content">
          <span className="role-label">{data.role || '协作成员'}</span>
          <p>
            {task?.error ||
              task?.output?.slice(-140) ||
              data.instructions ||
              '双击节点，设置职责与模型。'}
          </p>
        </div>
      )}
      <div className="node-hover-actions nodrag">
        <button
          title="节点设置"
          onClick={(e) => {
            e.stopPropagation();
            selectNode(id);
            setInspectorTab('settings');
          }}
        >
          <MoreHorizontal size={15} />
        </button>
        <button
          title="给这个 Agent 派活"
          onClick={(e) => {
            e.stopPropagation();
            setTarget(id);
            selectNode(id);
            document.querySelector('.goal-input')?.focus();
          }}
        >
          <Play size={12} />
        </button>
      </div>
    </div>
  );
});
export const NoteNode = memo(function NoteNode({ id, data, selected }) {
  const { selectNode } = useStudio();
  return (
    <div className={`note-node ${selected ? 'selected' : ''}`} onDoubleClick={() => selectNode(id)}>
      <Ports />
      <div className="note-heading">
        <FileText size={16} />
        <strong>{data.name}</strong>
        <span>共享便签</span>
      </div>
      <div className="note-body">{data.content || '双击添加上下文、约束和参考资料。'}</div>
    </div>
  );
});
export const PortalNode = memo(function PortalNode({ id, data, selected }) {
  const { request, selectNode } = useStudio();
  let domain = data.url;
  try {
    domain = new URL(data.url).hostname;
  } catch {}
  return (
    <div className={`portal-node ${selected ? 'selected' : ''}`}>
      <Ports />
      <div className="portal-top">
        <Globe size={17} />
        <strong>{data.name}</strong>
        <button
          className="icon-button nodrag"
          title="打开浏览器"
          onClick={() => request(`/portal/${id}`, { action: 'show' })}
        >
          <ArrowUpRight size={15} />
        </button>
      </div>
      <button className="portal-preview nodrag" onClick={() => selectNode(id)}>
        <span className="browser-address">
          <i />
          {domain}
        </span>
        <span className="browser-skeleton">
          <i />
          <i />
          <i />
        </span>
        <span>
          打开页面预览 <ArrowUpRight size={12} />
        </span>
      </button>
    </div>
  );
});
export const TerminalNode = memo(function TerminalNode({ data, selected }) {
  const { openTerminal } = useStudio();
  return (
    <div className={`terminal-node ${selected ? 'selected' : ''}`}>
      <div className="portal-top">
        <TerminalSquare size={17} />
        <strong>{data.name}</strong>
        <button className="icon-button nodrag" title="打开终端" onClick={() => openTerminal()}>
          <ArrowUpRight size={15} />
        </button>
      </div>
      <button className="terminal-preview nodrag" onClick={() => openTerminal()}>
        <code>
          PS &gt; <span className="terminal-cursor" />
        </code>
        <span>本机 PowerShell</span>
      </button>
    </div>
  );
});
export const FrameNode = memo(function FrameNode({ id, data, selected }) {
  const { request } = useStudio();
  return (
    <>
      <NodeResizer
        minWidth={260}
        minHeight={160}
        isVisible={selected}
        onResizeEnd={(e, p) =>
          request(
            `/nodes/${id}`,
            { position: { x: p.x, y: p.y }, width: p.width, height: p.height },
            'PATCH',
          )
        }
      />
      <div className="frame-node">
        <span>{data.name || '区域标注'}</span>
      </div>
    </>
  );
});
export const TextNode = memo(function TextNode({ id, data, selected }) {
  const { request } = useStudio();
  return (
    <div
      className="text-node"
      style={{ color: data.color || '#6e7788', fontSize: data.fontSize || 22 }}
    >
      {selected ? (
        <textarea
          className="nodrag"
          defaultValue={data.content || '文字标注'}
          onBlur={(e) => request(`/nodes/${id}`, { data: { content: e.target.value } }, 'PATCH')}
        />
      ) : (
        <span>{data.content || '文字标注'}</span>
      )}
    </div>
  );
});
export const DrawingNode = memo(function DrawingNode({ data }) {
  return (
    <svg width={data.width || 200} height={data.height || 100} className="drawing-node">
      <polyline
        points={(data.points || []).map((p) => p.join(',')).join(' ')}
        stroke={data.color || '#8598bd'}
        strokeWidth={data.strokeWidth || 2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
});
export const BinderNode = memo(function BinderNode({ id, data, selected }) {
  const { state, request, selectNode } = useStudio();
  const notes = state.nodes.filter((n) => n.binderId === id);
  const note = notes.find((n) => n.id === data.activeNoteId) || notes[0];
  return (
    <div className={`note-node binder-node ${selected ? 'selected' : ''}`}>
      <Ports />
      <div className="note-heading">
        <FileText size={16} />
        <strong>{data.name}</strong>
        <span>{notes.length} 篇</span>
      </div>
      <div className="binder-tabs nodrag">
        {notes.map((n) => (
          <button
            key={n.id}
            className={n.id === note?.id ? 'active' : ''}
            onClick={() => request(`/nodes/${id}`, { data: { activeNoteId: n.id } }, 'PATCH')}
          >
            {n.data.name}
          </button>
        ))}
      </div>
      {note ? (
        <>
          <div className="note-body" onDoubleClick={() => selectNode(note.id)}>
            {note.data.content}
          </div>
          <div className="binder-actions nodrag">
            <button onClick={() => selectNode(note.id)}>编辑</button>
            <button onClick={() => request(`/binders/${id}/release`, { noteId: note.id })}>
              移出笔记本
            </button>
          </div>
        </>
      ) : (
        <div className="note-body">笔记本为空；删除笔记本不会删除便签。</div>
      )}
    </div>
  );
});
export const nodeTypes = {
  agent: AgentNode,
  note: NoteNode,
  portal: PortalNode,
  terminal: TerminalNode,
  frame: FrameNode,
  binder: BinderNode,
  text: TextNode,
  drawing: DrawingNode,
};
