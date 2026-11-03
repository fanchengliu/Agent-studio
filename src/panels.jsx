import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  X,
  Download,
  RotateCcw,
  Square,
  ChevronDown,
  ChevronRight,
  Save,
  Folder,
  File,
  ArrowLeft,
  GitBranch,
  Plus,
  Check,
  FileDiff,
  RefreshCw,
  ExternalLink,
  Globe,
  Copy,
  Clock3,
  Trash2,
} from 'lucide-react';
import { useStudio } from './context.jsx';
import { api, download, statusLabels, dateTime, duration } from './api.js';
import { splitDiff } from './diff.js';
import { ProviderMark } from './nodes.jsx';

export function Markdown({ text }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text || ''}</ReactMarkdown>
    </div>
  );
}
export function TaskDetails({ task }) {
  const { request, setTarget, toast } = useStudio();
  const [steps, setSteps] = useState(false);
  if (!task)
    return (
      <div className="empty-panel">
        <span className="empty-symbol">↗</span>
        <h3>等待第一个任务</h3>
        <p>在下方输入目标，或沿画布箭头运行整个团队。</p>
      </div>
    );
  return (
    <div className="task-details">
      <div className="task-meta">
        <span className={`status-badge status-${task.status}`}>{statusLabels[task.status]}</span>
        <span>
          {dateTime(task.createdAt)} · {duration(task)}
        </span>
        <button
          className="icon-button"
          title="导出结果"
          onClick={() => download(`/tasks/${task.id}/export`)}
        >
          <Download size={14} />
        </button>
      </div>
      <div className="user-prompt">{task.prompt}</div>
      {!!task.steps?.length && (
        <div className="tool-history">
          <button className="tool-toggle" onClick={() => setSteps(!steps)}>
            {steps ? <ChevronDown size={13} /> : <ChevronRight size={13} />}执行记录{' '}
            <span>{task.steps.length}</span>
          </button>
          {steps && (
            <div className="steps">
              {task.steps.map((s, i) => (
                <div className="step" key={i}>
                  <span className="step-dot" />
                  <div>
                    <strong>{s.type === 'tool' ? s.detail?.name || '工具' : '运行日志'}</strong>
                    <pre>
                      {typeof s.detail === 'string'
                        ? s.detail
                        : typeof s.detail?.detail === 'object'
                          ? JSON.stringify(s.detail.detail, null, 2)
                          : s.detail?.detail || ''}
                    </pre>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {task.output ? (
        <Markdown text={task.output} />
      ) : (
        !task.error && (
          <div className="waiting-output">
            {['queued', 'running', 'waiting_approval'].includes(task.status) ? (
              <>
                <span className="pulse-dot" />
                等待 Agent 返回内容…
              </>
            ) : (
              '任务已结束，工具未返回文本结果。请查看执行记录和项目文件。'
            )}
          </div>
        )
      )}
      {task.error && <div className="task-error">{task.error}</div>}
      <div className="task-actions">
        {['running', 'queued', 'waiting_approval'].includes(task.status) ? (
          <button
            className="subtle-button danger"
            onClick={() => request(`/tasks/${task.id}/stop`, {})}
          >
            <Square size={12} />
            停止任务
          </button>
        ) : (
          <button className="subtle-button" onClick={() => request(`/tasks/${task.id}/retry`, {})}>
            <RotateCcw size={13} />
            重新执行
          </button>
        )}
        <button
          className="subtle-button"
          onClick={() => navigator.clipboard.writeText(task.output || '')}
        >
          <Copy size={13} />
          复制结果
        </button>
        {task.sessionId && (
          <button
            className="subtle-button"
            onClick={async () => {
              if (
                await request(
                  `/nodes/${task.nodeId}`,
                  { data: { sessionId: task.sessionId } },
                  'PATCH',
                )
              ) {
                setTarget(task.nodeId);
                document.querySelector('.goal-input')?.focus();
                toast('已选择原会话，输入下一条消息继续');
              }
            }}
          >
            继续该会话
          </button>
        )}
      </div>
    </div>
  );
}
export function Inspector() {
  const {
    state,
    selectedNode,
    selectNode,
    inspectorTab,
    setInspectorTab,
    request,
    taskSelection,
    setTaskSelection,
  } = useStudio();
  const node = state.nodes.find((n) => n.id === selectedNode);
  if (!node) return null;
  const tasks = state.tasks.filter((t) => t.nodeId === node.id);
  const task = tasks.find((t) => t.id === taskSelection) || tasks.at(-1);
  return (
    <aside className="inspector">
      <div className="inspector-head">
        {node.type === 'agent' ? (
          <ProviderMark id={node.data.provider} size={28} />
        ) : (
          <File size={19} />
        )}
        <strong>{node.data.name}</strong>
        <button className="icon-button" title="关闭面板" onClick={() => selectNode(null)}>
          <X size={17} />
        </button>
      </div>
      {node.type === 'agent' ? (
        <>
          <div className="inspector-tabs">
            <button
              className={inspectorTab === 'conversation' ? 'active' : ''}
              onClick={() => setInspectorTab('conversation')}
            >
              会话记录
            </button>
            <button
              className={inspectorTab === 'settings' ? 'active' : ''}
              onClick={() => setInspectorTab('settings')}
            >
              节点设置
            </button>
          </div>
          <div className="inspector-scroll">
            {inspectorTab === 'settings' ? (
              <AgentSettings key={node.id} node={node} />
            ) : (
              <>
                {tasks.length > 1 && (
                  <div className="history-select">
                    <select
                      value={task?.id || ''}
                      onChange={(e) => setTaskSelection(e.target.value)}
                    >
                      {tasks.toReversed().map((t) => (
                        <option key={t.id} value={t.id}>
                          {dateTime(t.createdAt)} · {statusLabels[t.status]} ·{' '}
                          {t.prompt.slice(0, 28)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <TaskDetails task={task} />
              </>
            )}
          </div>
        </>
      ) : (
        <div className="inspector-scroll">
          {node.type === 'note' ? (
            <NoteSettings key={node.id} node={node} />
          ) : node.type === 'portal' ? (
            <PortalSettings key={node.id} node={node} />
          ) : (
            <div className="form-section">
              <p className="muted">这个节点可以从画布打开。拖动标题移动位置。</p>
            </div>
          )}
          <div className="form-section">
            <button
              className="subtle-button danger"
              onClick={() =>
                request(`/nodes/${node.id}`, undefined, 'DELETE').then(() => selectNode(null))
              }
            >
              <Trash2 size={13} />
              移除节点
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
function AgentSettings({ node }) {
  const { state, request, selectNode } = useStudio();
  const [form, setForm] = useState({ ...node.data });
  const [saving, setSaving] = useState(false);
  const field = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  return (
    <form
      className="node-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        await request(`/nodes/${node.id}`, { data: form }, 'PATCH');
        setSaving(false);
      }}
    >
      <label>
        节点名称
        <input value={form.name} onChange={(e) => field('name', e.target.value)} maxLength={60} />
      </label>
      <label>
        AI 工具
        <select
          value={form.provider}
          onChange={(e) =>
            setForm((f) => ({ ...f, provider: e.target.value, sessionId: null, model: '' }))
          }
        >
          {state.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.installed ? '' : ' · 未找到'}
            </option>
          ))}
        </select>
      </label>
      <label>
        套用角色库
        <select
          defaultValue=""
          onChange={(e) => {
            const r = state.roles?.find((r) => r.id === e.target.value);
            if (r) setForm((f) => ({ ...f, role: r.name, instructions: r.instructions }));
          }}
        >
          <option value="">选择已保存的角色…</option>
          {(state.roles || []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        登录账号
        <select
          value={form.accountId || ''}
          onChange={(e) => setForm((f) => ({ ...f, accountId: e.target.value, sessionId: null }))}
        >
          <option value="">工具默认登录</option>
          {(state.accounts || [])
            .filter((a) => a.provider === form.provider)
            .map((a) => (
              <option value={a.id} key={a.id}>
                {a.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        角色
        <input
          value={form.role}
          onChange={(e) => field('role', e.target.value)}
          placeholder="规划 / 开发 / 研究 / 审查"
        />
      </label>
      <label>
        工作要求
        <textarea
          rows={5}
          value={form.instructions}
          onChange={(e) => field('instructions', e.target.value)}
          placeholder="这个 Agent 应该负责什么，交付什么？"
        />
      </label>
      <label>
        模型
        <input
          value={form.model || ''}
          onChange={(e) => field('model', e.target.value)}
          placeholder="留空使用工具默认模型"
        />
      </label>
      <label>
        执行权限
        <select value={form.mode} onChange={(e) => field('mode', e.target.value)}>
          <option value="ask">操作前按工具权限询问</option>
          <option value="read">只读研究 / 审查</option>
        </select>
      </label>
      <label className="toggle-label">
        <input
          type="checkbox"
          checked={!!form.orchestrator}
          onChange={(e) => field('orchestrator', e.target.checked)}
        />
        <span>
          允许创建新的队友<small>新增队友只获得普通节点权限</small>
        </span>
      </label>
      <button className="primary-button" disabled={saving}>
        <Save size={14} />
        {saving ? '保存中…' : '保存设置'}
      </button>
      <ConnectionsEditor node={node} />
      <div className="section-line" />
      <span className="field-caption">
        会话 {form.sessionId ? form.sessionId.slice(0, 20) + '…' : '尚未开始'}
      </span>
      <button
        type="button"
        className="subtle-button"
        onClick={async () => {
          await request(`/nodes/${node.id}`, { data: { sessionId: null } }, 'PATCH');
          field('sessionId', null);
        }}
      >
        <RotateCcw size={13} />
        下次从新会话开始
      </button>
      <button
        type="button"
        className="subtle-button danger"
        onClick={async () => {
          const r = await request(`/nodes/${node.id}`, undefined, 'DELETE');
          if (r) selectNode(null);
        }}
      >
        <Trash2 size={13} />
        移除节点
      </button>
    </form>
  );
}
function ConnectionsEditor({ node }) {
  const { state, request } = useStudio();
  const [target, setTarget] = useState('');
  const edges = state.edges.filter((e) => e.source === node.id || e.target === node.id);
  const connectedIds = new Set(edges.map((e) => (e.source === node.id ? e.target : e.source)));
  const candidates = state.nodes.filter(
    (n) =>
      n.id !== node.id && !connectedIds.has(n.id) && ['agent', 'note', 'portal'].includes(n.type),
  );
  return (
    <div className="connections-editor">
      <div className="section-line" />
      <h3 className="section-title">协作连接</h3>
      <p className="field-caption">可以连接其他工作台的队友，通过协作工具跨项目派活。</p>
      {edges.map((e) => {
        const peer = state.nodes.find((n) => n.id === (e.source === node.id ? e.target : e.source));
        return (
          <div className="peer-connection" key={e.id}>
            <span>
              {peer?.data.name || '未知节点'}
              <small>{state.projects.find((p) => p.id === peer?.projectId)?.name}</small>
            </span>
            <button
              type="button"
              className="icon-button"
              title="移除此连接"
              onClick={() => request(`/edges/${e.id}`, undefined, 'DELETE')}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
      <select value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">选择其他节点…</option>
        {candidates.map((n) => (
          <option value={n.id} key={n.id}>
            {state.projects.find((p) => p.id === n.projectId)?.name} / {n.data.name}
          </option>
        ))}
      </select>
      <button
        className="subtle-button"
        type="button"
        disabled={!target}
        onClick={async () => {
          const r = await request('/edges', { source: node.id, target });
          if (r) setTarget('');
        }}
      >
        <Plus size={13} />
        添加协作连接
      </button>
    </div>
  );
}
function NoteSettings({ node }) {
  const { request } = useStudio();
  const [name, setName] = useState(node.data.name),
    [content, setContent] = useState(node.data.content),
    [baseContent, setBaseContent] = useState(node.data.content);
  return (
    <div className="node-form">
      <label>
        名称
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        团队便签
        <textarea rows={15} value={content} onChange={(e) => setContent(e.target.value)} />
      </label>
      <button
        className="primary-button"
        onClick={async () => {
          const r = await request(
            `/nodes/${node.id}`,
            { data: { name, content }, expectedContent: baseContent },
            'PATCH',
          );
          if (r) setBaseContent(content);
        }}
      >
        <Save size={14} />
        保存便签
      </button>
      <div className="button-row">
        <button className="subtle-button" onClick={() => navigator.clipboard.writeText(content)}>
          复制草稿
        </button>
        <button
          className="subtle-button"
          onClick={() => {
            setContent(node.data.content);
            setBaseContent(node.data.content);
          }}
        >
          读取最新内容
        </button>
      </div>
      <p className="field-caption">只有连线连接的 Agent 可以通过协作工具访问。</p>
    </div>
  );
}
function PortalSettings({ node }) {
  const { request } = useStudio();
  const [url, setUrl] = useState(node.data.url),
    [snapshot, setSnapshot] = useState(null),
    [image, setImage] = useState(null),
    [busy, setBusy] = useState(false);
  const act = async (action) => {
    setBusy(true);
    const r = await request(`/portal/${node.id}`, { action, url });
    if (action === 'screenshot') setImage(r?.image);
    else if (r?.text) setSnapshot(r);
    setBusy(false);
  };
  return (
    <div className="node-form">
      <label>
        页面地址
        <input value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <button className="primary-button" disabled={busy} onClick={() => act('navigate')}>
        <Globe size={14} />
        加载页面
      </button>
      <div className="button-row">
        <button className="subtle-button" onClick={() => act('show')}>
          <ExternalLink size={13} />
          打开窗口
        </button>
        <button className="subtle-button" onClick={() => act('snapshot')}>
          读取页面
        </button>
        <button className="subtle-button" onClick={() => act('screenshot')}>
          截图
        </button>
      </div>
      {busy && <p className="muted">正在加载…</p>}
      {image && <img className="portal-shot" src={image} alt="页面截图" />}
      {snapshot && (
        <>
          <strong>{snapshot.title}</strong>
          <pre className="portal-text">{snapshot.text}</pre>
        </>
      )}
    </div>
  );
}
export function TaskTable() {
  const { state, project, selectNode, setTaskSelection } = useStudio();
  const tasks = state.tasks.filter((t) => t.projectId === project.id).toReversed();
  return (
    <div className="tasks-view">
      <div className="view-heading">
        <div>
          <h2>任务记录</h2>
          <p>每一次派发、执行与交付，都留在这里。</p>
        </div>
        <span className="count-pill">{tasks.length} 个任务</span>
      </div>
      {!tasks.length ? (
        <div className="large-empty">
          <Clock3 size={32} />
          <h3>还没有执行记录</h3>
          <p>回到画布，描述一个目标开始协作。</p>
        </div>
      ) : (
        <div className="task-table">
          <div className="task-table-head">
            <span>任务与执行者</span>
            <span>状态</span>
            <span>创建时间</span>
            <span>耗时</span>
          </div>
          {tasks.map((t) => {
            const n = state.nodes.find((n) => n.id === t.nodeId);
            return (
              <button
                className="task-table-row"
                key={t.id}
                onClick={() => {
                  selectNode(t.nodeId);
                  setTaskSelection(t.id);
                }}
              >
                <div>
                  <ProviderMark id={n?.data.provider || 'custom'} size={30} />
                  <span>
                    <strong>{t.prompt.replace(/^总目标：\s*/, '').slice(0, 65)}</strong>
                    <small>
                      {n?.data.name || '已移除的节点'} · {t.id.slice(0, 12)}
                    </small>
                  </span>
                </div>
                <span className={`status-badge status-${t.status}`}>{statusLabels[t.status]}</span>
                <span>{dateTime(t.createdAt)}</span>
                <span>{duration(t)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
export function FilesView() {
  const { project, request, toast } = useStudio();
  const [folder, setFolder] = useState('.'),
    [files, setFiles] = useState([]),
    [file, setFile] = useState(null),
    [text, setText] = useState(''),
    [original, setOriginal] = useState(''),
    [git, setGit] = useState(null),
    [diff, setDiff] = useState(null),
    [commit, setCommit] = useState(''),
    [split, setSplit] = useState(false);
  const refresh = async () => {
    const entries = await request(
      `/files?projectId=${project.id}&path=${encodeURIComponent(folder)}`,
    );
    if (entries)
      setFiles(
        entries.sort(
          (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
        ),
      );
    const info = await request(`/git?projectId=${project.id}`);
    if (info) setGit(info);
  };
  useEffect(() => {
    refresh();
  }, [project.id, folder]);
  const open = async (entry) => {
    if (entry.directory) return setFolder(entry.path);
    const r = await request(`/file?projectId=${project.id}&path=${encodeURIComponent(entry.path)}`);
    if (r) {
      setFile(entry.path);
      setText(r.content);
      setOriginal(r.content);
      setDiff(null);
    }
  };
  const save = async () => {
    const r = await request(
      '/file',
      { projectId: project.id, path: file, content: text, expectedContent: original },
      'PUT',
    );
    if (r) {
      setOriginal(text);
      toast('文件已保存');
      refresh();
    }
  };
  return (
    <div className="files-view">
      <div className="files-sidebar">
        <div className="file-sidebar-heading">
          <strong>项目文件</strong>
          <button className="icon-button" title="刷新文件" onClick={refresh}>
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="folder-location">
          <button
            className="icon-button"
            disabled={folder === '.'}
            onClick={() => setFolder(folder.split(/[\\/]/).slice(0, -1).join('/') || '.')}
            title="返回上级"
          >
            <ArrowLeft size={13} />
          </button>
          <span>{folder === '.' ? project.name : folder}</span>
        </div>
        <div className="file-tree">
          {files.map((f) => (
            <button
              key={f.path}
              className={file === f.path ? 'active' : ''}
              onClick={() => open(f)}
            >
              {f.directory ? <Folder size={15} /> : <File size={14} />}
              <span>{f.name}</span>
              {f.directory && <ChevronRight size={12} />}
            </button>
          ))}
          {!files.length && <p className="field-caption">文件夹为空</p>}
        </div>
        <div className="git-section">
          <strong>
            <GitBranch size={14} />
            {git?.isRepo ? git.branch || 'Detached HEAD' : '未检测到 Git 仓库'}
          </strong>
          {git?.isRepo && (
            <>
              <pre className="git-status">{git.status || '工作区干净'}</pre>
              <div className="button-row">
                {file && (
                  <button
                    className="subtle-button"
                    onClick={async () => {
                      await request('/git/stage', { projectId: project.id, path: file });
                      refresh();
                    }}
                  >
                    暂存当前文件
                  </button>
                )}{' '}
                {file && (
                  <button
                    className="subtle-button"
                    onClick={async () => {
                      await request('/git/stage', {
                        projectId: project.id,
                        path: file,
                        unstage: true,
                      });
                      refresh();
                    }}
                  >
                    取消暂存
                  </button>
                )}
              </div>
              <input
                value={commit}
                onChange={(e) => setCommit(e.target.value)}
                placeholder="提交说明"
              />
              <button
                className="subtle-button"
                disabled={!commit.trim()}
                onClick={async () => {
                  const r = await request('/git/commit', {
                    projectId: project.id,
                    message: commit,
                  });
                  if (r) {
                    setCommit('');
                    refresh();
                    toast('已提交暂存的改动');
                  }
                }}
              >
                提交已暂存改动
              </button>
            </>
          )}
        </div>
      </div>
      <div className="file-editor">
        {file ? (
          <>
            <div className="editor-toolbar">
              <span>
                <File size={14} />
                {file}
                {text !== original && <i />}
              </span>
              <div>
                <button
                  className="subtle-button"
                  onClick={async () => {
                    const r = await request(
                      `/diff?projectId=${project.id}&path=${encodeURIComponent(file)}`,
                    );
                    if (r)
                      setDiff(r.diff || '没有已跟踪文件的未暂存差异；新文件可在编辑器中查看。');
                  }}
                >
                  <FileDiff size={14} />
                  差异
                </button>
                <button className="subtle-button" onClick={save} disabled={text === original}>
                  <Save size={14} />
                  保存
                </button>
              </div>
            </div>
            {diff !== null ? (
              <div className="diff-view">
                <button className="subtle-button" onClick={() => setDiff(null)}>
                  返回编辑器
                </button>
                <div className="diff-mode">
                  <button className={!split ? 'active' : ''} onClick={() => setSplit(false)}>
                    统一差异
                  </button>
                  <button className={split ? 'active' : ''} onClick={() => setSplit(true)}>
                    并排对照
                  </button>
                </div>
                {split ? (
                  <div className="split-diff">
                    {splitDiff(diff).map((row, i) =>
                      row.header ? (
                        <div key={i} className="diff-header">
                          {row.header}
                        </div>
                      ) : (
                        <div key={i} className="diff-row">
                          {[row.left, row.right].map((cell, j) => (
                            <div className={cell?.kind || ''} key={j}>
                              <span>{cell?.number || ''}</span>
                              <code>{cell?.text || ' '}</code>
                            </div>
                          ))}
                        </div>
                      ),
                    )}
                  </div>
                ) : (
                  <pre>{diff}</pre>
                )}
              </div>
            ) : (
              <textarea
                className="code-editor"
                value={text}
                spellCheck={false}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    e.preventDefault();
                    save();
                  }
                }}
              />
            )}
          </>
        ) : (
          <div className="large-empty">
            <File size={34} />
            <h3>打开一份项目文件</h3>
            <p>查看 Agent 交付的代码、笔记与报告。</p>
          </div>
        )}
      </div>
    </div>
  );
}
export function TerminalPanel() {
  const { terminals, activeTerminal, setActiveTerminal, closeTerminalPanel, sendSocket } =
    useStudio();
  const host = useRef(null),
    term = useRef(null),
    fit = useRef(null);
  useEffect(() => {
    if (!host.current || !activeTerminal) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#101215',
        foreground: '#d9dede',
        cursor: '#96c9b5',
        selectionBackground: '#38483e',
      },
      scrollback: 5000,
    });
    const addon = new FitAddon();
    terminal.loadAddon(addon);
    terminal.open(host.current);
    addon.fit();
    term.current = terminal;
    fit.current = addon;
    const listener = (e) => {
      if (e.detail.id === activeTerminal) {
        if (e.detail.type === 'terminal') terminal.write(e.detail.data);
        else terminal.write(`\r\n[进程退出 ${e.detail.exitCode}]\r\n`);
      }
    };
    window.addEventListener('studio-terminal', listener);
    api(`/terminals/${activeTerminal}`)
      .then((r) => terminal.write(r.output))
      .catch(() => {});
    const disposable = terminal.onData((data) =>
      sendSocket({ type: 'terminal_input', id: activeTerminal, data }),
    );
    const observer = new ResizeObserver(() => {
      try {
        addon.fit();
        sendSocket({
          type: 'terminal_resize',
          id: activeTerminal,
          cols: terminal.cols,
          rows: terminal.rows,
        });
      } catch {}
    });
    observer.observe(host.current);
    terminal.focus();
    return () => {
      window.removeEventListener('studio-terminal', listener);
      observer.disconnect();
      disposable.dispose();
      terminal.dispose();
    };
  }, [activeTerminal]);
  if (!terminals.length || !activeTerminal) return null;
  return (
    <div className="terminal-panel">
      <div className="terminal-tabs">
        {terminals.map((t) => (
          <button
            className={t.id === activeTerminal ? 'active' : ''}
            key={t.id}
            onClick={() => setActiveTerminal(t.id)}
          >
            {t.label}
          </button>
        ))}
        <button className="icon-button" title="收起终端" onClick={closeTerminalPanel}>
          <X size={16} />
        </button>
      </div>
      <div className="terminal-host" ref={host} />
    </div>
  );
}
