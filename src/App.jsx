import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  applyNodeChanges,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Plus,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  ArrowUp,
  Settings2,
  Settings,
  LayoutGrid,
  ListTodo,
  Files,
  TerminalSquare,
  FileText,
  Globe,
  Layers,
  GitBranch,
  FolderOpen,
  Workflow,
  Cable,
  Check,
  X,
  Square,
  CircleHelp,
  MoreHorizontal,
  Sparkles,
  Clock3,
  PanelRightClose,
  ArrowRight,
  Search,
  LocateFixed,
  WandSparkles,
  ShieldCheck,
  Bell,
  Command,
  RotateCcw,
  RefreshCw,
  Paperclip,
} from 'lucide-react';
import { StudioContext } from './context.jsx';
import { api, initSession, statusLabels, dateTime } from './api.js';
import { nodeTypes, ProviderMark } from './nodes.jsx';
import { Inspector, TaskTable, FilesView, TerminalPanel } from './panels.jsx';
import {
  ConnectionsDialog,
  ProjectDialog,
  SettingsDialog,
  RoutinesDialog,
  ApprovalDialog,
  ArrangementsDialog,
  Modal,
} from './dialogs.jsx';
import Workbench from './Workbench.jsx';
import Canvas from './Canvas.jsx';
import './styles.css';

export default function App() {
  return (
    <ReactFlowProvider>
      <Workspace />
    </ReactFlowProvider>
  );
}
function Workspace() {
  const [state, setState] = useState(null),
    [error, setError] = useState(null),
    [projectId, setProjectId] = useState(localStorage.getItem('studio-project') || ''),
    [selectedNode, setSelectedNode] = useState(null),
    [taskSelection, setTaskSelection] = useState(null),
    [inspectorTab, setInspectorTab] = useState('conversation'),
    [tab, setTab] = useState('canvas'),
    [modal, setModal] = useState(null),
    [target, setTarget] = useState('team'),
    [prompt, setPrompt] = useState(''),
    [menu, setMenu] = useState(false),
    [nodes, setNodes] = useState([]),
    [notification, setNotification] = useState(''),
    [online, setOnline] = useState(false),
    [busy, setBusy] = useState(false),
    [terminalItems, setTerminals] = useState([]),
    [activeTerminal, setActiveTerminal] = useState(null),
    [command, setCommand] = useState(false),
    [query, setQuery] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false),
    [canvasExpanded, setCanvasExpanded] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const attachmentInput = useRef(null);
  const selectionRef = useRef(new Set());
  const socket = useRef(null),
    dragIds = useRef(new Set()),
    pendingPositions = useRef({}),
    reconnect = useRef(null),
    disposed = useRef(false),
    notifyTimer = useRef(null);
  const flow = useReactFlow();
  const toast = useCallback((text) => {
    setNotification(text);
    clearTimeout(notifyTimer.current);
    notifyTimer.current = setTimeout(() => setNotification(''), 4800);
  }, []);
  const request = useCallback(
    async (route, data, method) => {
      try {
        return await api(route, data, method);
      } catch (e) {
        toast(e.message);
        return null;
      }
    },
    [toast],
  );
  const project =
    state?.projects.find((p) => p.id === (projectId || state.settings.lastProjectId)) ||
    state?.projects[0];
  const changeProject = (id) => {
    setProjectId(id);
    localStorage.setItem('studio-project', id);
    request('/settings', { lastProjectId: id }, 'PATCH');
    setSelectedNode(null);
    setTaskSelection(null);
    setTarget('team');
    setTab('canvas');
  };
  const selectNode = (id) => {
    selectionRef.current = new Set(id ? [id] : []);
    setSelectedNode(id);
    setTaskSelection(null);
    setInspectorTab('conversation');
  };
  useEffect(() => {
    disposed.current = false;
    const connect = () => {
      if (disposed.current) return;
      const ws = new WebSocket(location.origin.replace(/^http/, 'ws'));
      socket.current = ws;
      ws.onopen = () => setOnline(true);
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'state') setState(m.state);
        if (m.type === 'terminal' || m.type === 'terminal_exit')
          window.dispatchEvent(new CustomEvent('studio-terminal', { detail: m }));
        if (m.type === 'error') toast(m.error);
      };
      ws.onclose = () => {
        setOnline(false);
        if (!disposed.current) reconnect.current = setTimeout(connect, 1800);
      };
    };
    initSession()
      .then(async () => {
        setState(await api('/state'));
        connect();
      })
      .catch((e) => setError(e.message));
    return () => {
      disposed.current = true;
      clearTimeout(reconnect.current);
      socket.current?.close();
    };
  }, []);
  useEffect(() => {
    if (!state || !project) return;
    const current = state.nodes
      .filter((n) => n.projectId === project.id && !n.binderId)
      .map((n) => ({
        ...n,
        position: pendingPositions.current[n.id] || n.position,
        selected: selectionRef.current.has(n.id),
        draggable: !n.locked,
        style:
          n.type === 'frame'
            ? { width: n.width || 740, height: n.height || 400, zIndex: -1 }
            : undefined,
      }));
    setNodes(current);
  }, [state, project?.id, selectedNode]);
  useEffect(() => {
    if (project) {
      setTimeout(
        () =>
          project.view
            ? flow.setViewport(project.view, { duration: 200 })
            : flow.fitView({ padding: 0.2, maxZoom: 1, duration: 300 }),
        100,
      );
    }
  }, [project?.id]);
  useEffect(() => {
    const key = (e) => {
      const input =
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) ||
        document.activeElement?.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommand((c) => !c);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't' && !input && project) {
        e.preventDefault();
        addNode('agent');
      }
      if (e.key === 'Escape' && !modal) {
        setMenu(false);
        setCommand(false);
        selectNode(null);
      }
      if (e.key === 'Delete' && selectionRef.current.size && !input && !modal)
        request('/canvas/delete', {
          projectId: project.id,
          nodeIds: [...selectionRef.current],
        }).then((r) => {
          if (r) selectNode(null);
        });
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [selectedNode, modal, request, project?.id]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      document.documentElement.dataset.theme =
        state?.settings.theme === 'system'
          ? media.matches
            ? 'dark'
            : 'light'
          : state?.settings.theme || 'light';
      document.documentElement.dataset.motion = state?.settings.reduceMotion ? 'reduce' : 'normal';
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [state?.settings.theme, state?.settings.reduceMotion]);
  const sendSocket = (value) => {
    if (socket.current?.readyState === 1) socket.current.send(JSON.stringify(value));
  };
  const openTerminal = async (provider, accountId) => {
    const r = await request('/terminals', {
      projectId: project.id,
      ...(provider ? { provider, accountId } : {}),
    });
    if (r) {
      setTerminals((t) => [...t, r]);
      setActiveTerminal(r.id);
    }
    return r;
  };
  const addNode = async (type, at) => {
    setMenu(false);
    setTab('canvas');
    const position =
      at ||
      flow.screenToFlowPosition({ x: window.innerWidth * 0.47, y: window.innerHeight * 0.38 });
    const r = await request('/nodes', { projectId: project.id, type, position });
    if (r) {
      selectNode(r.id);
      if (type === 'agent') setInspectorTab('settings');
    }
  };
  const template = async (kind) => {
    const r = await request('/template', { projectId: project.id, kind });
    if (r) setTimeout(() => flow.fitView({ padding: 0.38, maxZoom: 1, duration: 400 }), 160);
  };
  const submit = async () => {
    if (!prompt.trim() || busy) return;
    const submittedPrompt =
      prompt +
      (attachments.length
        ? '\n\n用户附加的本地文件（按需读取）：\n' + attachments.map((a) => a.path).join('\n')
        : '');
    setBusy(true);
    const r = await request(
      target === 'team' ? '/runs' : target === 'selection' ? '/broadcast' : '/tasks',
      target === 'team'
        ? { projectId: project.id, prompt: submittedPrompt }
        : target === 'selection'
          ? {
              nodeIds: [...selectionRef.current].filter((id) =>
                state.nodes.some((n) => n.id === id && n.type === 'agent'),
              ),
              prompt: submittedPrompt,
            }
          : { nodeId: target, prompt: submittedPrompt },
    );
    setBusy(false);
    if (r) {
      setPrompt('');
      setAttachments([]);
      if (!['team', 'selection'].includes(target)) selectNode(target);
      toast(target === 'team' ? '团队流程已启动，上游结果会沿箭头传递' : '任务已派发');
    }
  };
  if (error)
    return (
      <div className="boot-screen">
        <div className="studio-logo">
          a<span>•</span>
        </div>
        <h1>无法连接本地工作台</h1>
        <p>{error}</p>
        <button className="primary-button" onClick={() => location.reload()}>
          重新连接
        </button>
      </div>
    );
  if (!state)
    return (
      <div className="boot-screen">
        <div className="studio-logo">
          a<span>•</span>
        </div>
        <p>正在打开你的工作台…</p>
      </div>
    );
  const currentNodes = state.nodes.filter((n) => n.projectId === project?.id),
    agents = currentNodes.filter((n) => n.type === 'agent'),
    projectTasks = state.tasks.filter((t) => t.projectId === project?.id),
    activeTasks = projectTasks.filter((t) =>
      ['running', 'queued', 'waiting_approval'].includes(t.status),
    ),
    approval = state.approvals[0];
  const layoutNodes = async () => {
    let i = 0;
    for (const n of currentNodes) {
      const position = { x: 80 + (i % 3) * 410, y: 100 + Math.floor(i / 3) * 350 };
      i++;
      await request(`/nodes/${n.id}`, { position }, 'PATCH');
    }
    setTimeout(() => flow.fitView({ padding: 0.2, duration: 400, maxZoom: 1 }), 140);
  };
  const context = {
    state,
    project,
    selectedNode,
    selectNode,
    taskSelection,
    setTaskSelection,
    inspectorTab,
    setInspectorTab,
    target,
    setTarget,
    request,
    toast,
    openTerminal,
    terminals: terminalItems,
    activeTerminal,
    setActiveTerminal,
    closeTerminalPanel: () => setActiveTerminal(null),
    sendSocket,
    changeProject,
    canvasExpanded,
    setCanvasExpanded,
    selectionRef,
    pendingPositions,
  };
  return (
    <StudioContext.Provider value={context}>
      <div className={`studio-app ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <aside className="sidebar">
          <div className="brand">
            <div className="studio-logo">
              a<span>•</span>
            </div>
            <div>
              <strong>Agent Studio</strong>
              <span>让 AI 组成团队</span>
            </div>
            <span className="local-badge">LOCAL</span>
          </div>
          <button
            className="sidebar-command"
            onClick={() => {
              setCommand(true);
              setQuery('');
            }}
          >
            <Search size={15} />
            <span>搜索与操作</span>
            <kbd>Ctrl K</kbd>
          </button>
          <div className="sidebar-section-heading">
            <span>工作台</span>
            <button className="icon-button" title="新建工作台" onClick={() => setModal('project')}>
              <Plus size={15} />
            </button>
          </div>
          <nav className="project-list" aria-label="工作台">
            {[null, ...(state.folders || [])].map((folder) => (
              <div className="project-folder" key={folder?.id || 'root'}>
                {folder && (
                  <div className="project-folder-title">
                    <FolderOpen size={12} />
                    {folder.name}
                  </div>
                )}
                {state.projects
                  .filter(
                    (p) =>
                      !p.parentId &&
                      (folder
                        ? p.folderId === folder.id
                        : !p.folderId || !state.folders?.some((f) => f.id === p.folderId)),
                  )
                  .map((p) => (
                    <React.Fragment key={p.id}>
                      <button
                        className={'project-item ' + (project?.id === p.id ? 'active' : '')}
                        onClick={() => changeProject(p.id)}
                      >
                        <LayoutGrid size={16} />
                        <span>{p.name}</span>
                      </button>
                      {state.projects
                        .filter((l) => l.parentId === p.id && !l.archived)
                        .map((l) => (
                          <button
                            key={l.id}
                            className={
                              'project-item layer-item ' + (project?.id === l.id ? 'active' : '')
                            }
                            onClick={() => changeProject(l.id)}
                          >
                            <GitBranch size={14} />
                            <span>{l.name.split(' / ').at(-1)}</span>
                          </button>
                        ))}
                    </React.Fragment>
                  ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-provider-section">
            <div className="sidebar-section-heading">
              <span>我的 AI 工具</span>
              <button
                className="icon-button"
                title="管理 AI 连接"
                onClick={() => setModal('connections')}
              >
                <Settings2 size={14} />
              </button>
            </div>
            <div className="provider-list">
              {state.providers
                .filter((p) => !['custom', 'gemini', 'opencode'].includes(p.id))
                .map((p) => (
                  <button key={p.id} onClick={() => setModal('connections')}>
                    <ProviderMark id={p.id} size={25} />
                    <span>{p.name}</span>
                    <i
                      className={`tiny-dot ${p.configured ? 'available' : ''}`}
                      title={p.configured ? '工具已配置，登录未自动验证' : '需要配置'}
                    />
                  </button>
                ))}
            </div>
            <button className="connect-button" onClick={() => setModal('connections')}>
              <Cable size={14} />
              连接与套餐入口
              <ChevronRight size={13} />
            </button>
          </div>
          <div className="sidebar-footer">
            <div className="local-storage">
              <ShieldCheck size={16} />
              <span>
                数据保存在本机<small>你的工具 · 你的工作空间</small>
              </span>
            </div>
            <div className="sidebar-footer-actions">
              <button onClick={() => setModal('settings')}>
                <Settings size={15} />
                设置
              </button>
              <button onClick={() => setModal('help')}>
                <CircleHelp size={15} />
                使用指南
              </button>
              <span>v{state.version}</span>
            </div>
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <div className="breadcrumbs">
              <button
                className="sidebar-toggle"
                title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
                onClick={() => setSidebarCollapsed((v) => !v)}
              >
                <PanelRightClose size={17} />
              </button>
              <span>我的空间</span>
              <ChevronRight size={13} />
              <button onClick={() => project && setModal('edit-project')}>
                {project?.name || '选择工作台'}
                <ChevronDown size={13} />
              </button>
            </div>
            <div className="topbar-actions">
              <span className={`connection-indicator ${online ? 'online' : ''}`}>
                <i />
                {online ? '本地运行' : '正在恢复'}
              </span>
              {!!state.approvals.length && (
                <button className="attention-count" onClick={() => {}}>
                  <Bell size={13} />
                  {state.approvals.length} 项等待
                </button>
              )}
              <button className="icon-button" title="定时协作" onClick={() => setModal('routines')}>
                <Clock3 size={17} />
              </button>
              <div className="avatar">L</div>
            </div>
          </header>
          {project ? (
            <>
              <div className="workspace-toolbar">
                <div className="view-tabs">
                  <button
                    className={tab === 'canvas' ? 'active' : ''}
                    onClick={() => setTab('canvas')}
                  >
                    <LayoutGrid size={15} />
                    协作画布
                  </button>
                  <button
                    className={tab === 'tasks' ? 'active' : ''}
                    onClick={() => setTab('tasks')}
                  >
                    <ListTodo size={16} />
                    任务{projectTasks.length > 0 && <span>{projectTasks.length}</span>}
                  </button>
                  <button
                    className={tab === 'files' ? 'active' : ''}
                    onClick={() => setTab('files')}
                  >
                    <Files size={15} />
                    文件
                  </button>
                </div>
                <div className="toolbar-actions">
                  <button
                    className="workbench-button"
                    title="工作台工具箱"
                    onClick={() => setModal('workbench')}
                  >
                    <Layers size={15} />
                    工具箱
                  </button>
                  <button
                    className="toolbar-icon"
                    title="团队模板"
                    onClick={() => setModal('arrangements')}
                  >
                    <Layers size={16} />
                  </button>
                  <button
                    className="toolbar-icon"
                    title="打开项目文件夹"
                    onClick={() => request('/open-folder', { projectId: project.id })}
                  >
                    <FolderOpen size={16} />
                  </button>
                  <button
                    className="toolbar-icon"
                    title="创建独立 Git 分支"
                    onClick={() => setModal('worktree')}
                  >
                    <GitBranch size={16} />
                  </button>
                  <button
                    className="toolbar-icon"
                    title="打开本机终端"
                    onClick={() => openTerminal()}
                  >
                    <TerminalSquare size={16} />
                  </button>
                  <span className="toolbar-separator" />
                  <div className="add-menu-wrap">
                    <button className="add-node-button" onClick={() => setMenu(!menu)}>
                      <Plus size={15} />
                      添加节点
                      <ChevronDown size={12} />
                    </button>
                    {menu && (
                      <div className="dropdown-menu">
                        {[
                          ['agent', Workflow, 'AI Agent', '分配角色与模型'],
                          ['note', FileText, '共享便签', '给团队一份共同上下文'],
                          ['terminal', TerminalSquare, '终端', '运行本机命令'],
                          ['portal', Globe, '浏览器', '让 Agent 检查页面'],
                          ['frame', Layers, '区域标注', '整理工作区域'],
                        ].map(([type, Icon, name, hint]) => (
                          <button key={type} onClick={() => addNode(type)}>
                            <Icon size={17} />
                            <span>
                              <strong>{name}</strong>
                              <small>{hint}</small>
                            </span>
                            <Plus size={12} />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="work-content">
                <div className={`work-main view-${tab} ${activeTerminal ? 'has-terminal' : ''}`}>
                  <Canvas
                    nodes={nodes}
                    setNodes={setNodes}
                    tab={tab}
                    addNode={addNode}
                    template={template}
                  />
                  {tab === 'tasks' && <TaskTable />}
                  {tab === 'files' && <FilesView key={project.id} />}
                  <TerminalPanel />
                  <div className="composer-wrap">
                    <div className={`composer ${prompt ? 'has-text' : ''}`}>
                      <div className="composer-target">
                        <span className="composer-label">交给</span>
                        <select
                          aria-label="任务执行者"
                          value={target}
                          onChange={(e) => setTarget(e.target.value)}
                        >
                          <option value="team">整个团队 · 沿箭头执行</option>
                          {selectionRef.current.size > 1 && (
                            <option value="selection">广播给选中成员</option>
                          )}
                          {agents.map((n) => (
                            <option key={n.id} value={n.id}>
                              {n.data.name}
                            </option>
                          ))}
                        </select>
                        <span className="composer-context">
                          <FolderOpen size={12} />
                          {project.name}
                        </span>
                        {!!activeTasks.length && (
                          <span className="running-count">
                            <span className="pulse-dot" />
                            {activeTasks.length} 个任务进行中
                          </span>
                        )}
                      </div>
                      <div className="attachment-chips">
                        {attachments.map((a, i) => (
                          <span key={a.path}>
                            <Paperclip size={11} />
                            {a.name}
                            <button
                              title="移除附件"
                              onClick={() => setAttachments((xs) => xs.filter((_, j) => j !== i))}
                            >
                              <X size={11} />
                            </button>
                          </span>
                        ))}
                      </div>
                      <textarea
                        className="goal-input"
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        rows={2}
                        placeholder="给团队一个目标，或选一位成员开始对话…"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            submit();
                          }
                        }}
                      />
                      <div className="composer-bottom">
                        <span>
                          <button
                            className="attach-button"
                            title="添加文件或图片"
                            onClick={() => attachmentInput.current.click()}
                          >
                            <Paperclip size={14} />
                          </button>
                          <input
                            ref={attachmentInput}
                            type="file"
                            hidden
                            multiple
                            onChange={async (e) => {
                              for (const f of e.target.files) {
                                if (f.size > 8000000) {
                                  toast('附件不能超过 8 MB');
                                  continue;
                                }
                                const encoded = await new Promise((resolve, reject) => {
                                  const reader = new FileReader();
                                  reader.onload = () =>
                                    resolve(String(reader.result).split(',')[1]);
                                  reader.onerror = reject;
                                  reader.readAsDataURL(f);
                                });
                                const r = await request('/attachments', {
                                  projectId: project.id,
                                  name: f.name,
                                  base64: encoded,
                                });
                                if (r) setAttachments((xs) => [...xs, r]);
                              }
                              e.target.value = '';
                            }}
                          />
                          <Command size={12} />
                          Enter 派发<span>·</span>Shift + Enter 换行
                        </span>
                        <div>
                          {activeTasks.length > 0 && (
                            <button
                              className="stop-button"
                              onClick={async () => {
                                for (const r of state.runs.filter(
                                  (r) => r.projectId === project.id && r.status === 'running',
                                ))
                                  await request(`/runs/${r.id}/stop`, {});
                                for (const t of activeTasks)
                                  await request(`/tasks/${t.id}/stop`, {});
                              }}
                            >
                              <Square size={11} />
                              停止
                            </button>
                          )}
                          <button
                            className="send-button"
                            title="派发任务"
                            disabled={!prompt.trim() || !agents.length || busy}
                            onClick={submit}
                          >
                            {busy ? (
                              <RefreshCw size={17} className="spin" />
                            ) : (
                              <ArrowUp size={19} />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="composer-footnote"></div>
                  </div>
                </div>
                <Inspector />
              </div>
              <footer className="statusbar">
                <span>
                  <i className={`tiny-dot ${online ? 'available' : ''}`} />
                  {online ? '工作台就绪' : '连接中断'}
                </span>
                <span>
                  {currentNodes.length} 个节点<span className="status-divider">/</span>
                  {
                    state.edges.filter((e) => currentNodes.some((n) => n.id === e.source)).length
                  }{' '}
                  条连线
                </span>
                <span className="statusbar-path" title={project.directory}>
                  {project.directory}
                </span>
                <button onClick={() => setModal('connections')}>
                  管理连接
                  <ArrowUpRight size={11} />
                </button>
              </footer>
            </>
          ) : (
            <div className="large-empty">
              <h2>创建你的第一个工作台</h2>
              <button className="primary-button" onClick={() => setModal('project')}>
                新建工作台
              </button>
            </div>
          )}
        </div>
        {notification && (
          <div className="toast" role="status">
            <span>{notification}</span>
            <button className="icon-button" onClick={() => setNotification('')} title="关闭消息">
              <X size={14} />
            </button>
          </div>
        )}
        {modal?.startsWith('workbench') && (
          <Workbench initial={modal.split(':')[1] || 'roles'} onClose={() => setModal(null)} />
        )}
        {modal === 'arrangements' && <ArrangementsDialog onClose={() => setModal(null)} />}
        {modal === 'connections' && <ConnectionsDialog onClose={() => setModal(null)} />}{' '}
        {['project', 'edit-project', 'worktree'].includes(modal) && (
          <ProjectDialog
            onClose={() => setModal(null)}
            edit={modal === 'edit-project'}
            worktree={modal === 'worktree'}
          />
        )}{' '}
        {modal === 'settings' && <SettingsDialog onClose={() => setModal(null)} />}{' '}
        {modal === 'routines' && <RoutinesDialog onClose={() => setModal(null)} />}
        {modal === 'help' && (
          <Modal
            title="从一个目标开始协作"
            description="Agent Studio 使用本机真实 AI 工具；软件没有激活或工作台付费限制。"
            onClose={() => setModal(null)}
          >
            <div className="help-content">
              {[
                [
                  '01',
                  '连接你的工具',
                  '在「连接与套餐入口」确认工具路径，检查安装与登录。未安装的工具需要单独安装。',
                ],
                [
                  '02',
                  '建立团队',
                  '选择开发或研究模板，或者添加 Agent。为每个节点设置模型、职责和权限。',
                ],
                [
                  '03',
                  '画出协作关系',
                  '从一个节点右侧端口拖到另一个节点左侧。运行整个团队时，输出会沿箭头传递；双击连线移除。',
                ],
                [
                  '04',
                  '交付与接力',
                  '描述总目标并派发。点击节点查看真实输出、工具记录和等待请求，在文件页检查结果。',
                ],
              ].map(([number, title, text]) => (
                <div className="help-step" key={number}>
                  <span>{number}</span>
                  <div>
                    <h3>{title}</h3>
                    <p>{text}</p>
                  </div>
                </div>
              ))}
              <div className="help-note">
                Ctrl + K 搜索操作。Delete 移除选中节点。画布右键或中键拖动平移，滚轮缩放。每个 Agent
                的操作权限由它的工具与当前节点设置共同决定。
              </div>
            </div>
          </Modal>
        )}
        {command && (
          <Modal title="搜索与操作" onClose={() => setCommand(false)} className="command-modal">
            <div className="command-search">
              <Search size={17} />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索节点、工作台或操作…"
              />
            </div>
            <div className="command-results">
              {[
                ['角色库', () => setModal('workbench:roles'), Layers],
                ['独立账号', () => setModal('workbench:accounts'), Settings2],
                ['视图书签', () => setModal('workbench:views'), LocateFixed],
                ['项目分组', () => setModal('workbench:projects'), FolderOpen],
                ['定时任务', () => setModal('routines'), Clock3],
                ['团队模板', () => setModal('arrangements'), Workflow],
                [
                  '合为笔记本',
                  () =>
                    request('/binders', {
                      projectId: project.id,
                      nodeIds: [...selectionRef.current],
                    }),
                  FileText,
                ],
                ['连接 AI 工具', () => setModal('connections'), Cable],
                ['添加 Agent', () => addNode('agent'), Workflow],
                ['新建工作台', () => setModal('project'), Plus],
                ['打开本机终端', () => openTerminal(), TerminalSquare],
                ['整理画布', layoutNodes, WandSparkles],
                ['应用设置', () => setModal('settings'), Settings],
                ...state.projects.map((p) => [p.name, () => changeProject(p.id), LayoutGrid]),
                ...currentNodes.map((n) => [
                  n.data.name,
                  () => {
                    selectNode(n.id);
                    flow.fitView({ nodes: [{ id: n.id }], duration: 300, maxZoom: 1 });
                  },
                  Workflow,
                ]),
              ]
                .filter(([name]) => !query || name.toLowerCase().includes(query.toLowerCase()))
                .map(([name, action, Icon], i) => (
                  <button
                    key={i}
                    onClick={() => {
                      action();
                      setCommand(false);
                    }}
                  >
                    <Icon size={16} />
                    <span>{name}</span>
                    <ArrowUpRight size={13} />
                  </button>
                ))}
            </div>
          </Modal>
        )}
        {approval && <ApprovalDialog key={approval.id} item={approval} />}
      </div>
    </StudioContext.Provider>
  );
}
