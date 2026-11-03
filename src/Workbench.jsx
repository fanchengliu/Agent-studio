import React, { useState, useEffect } from 'react';
import {
  Users,
  BookOpen,
  Bookmark,
  Archive,
  Folder,
  Plus,
  Trash2,
  LogIn,
  Download,
} from 'lucide-react';
import { useReactFlow } from '@xyflow/react';
import { Modal } from './dialogs.jsx';
import { useStudio } from './context.jsx';
import { download } from './api.js';

export default function Workbench({ onClose, initial = 'roles' }) {
  const { state, project, request, toast, openTerminal, changeProject } = useStudio();
  const flow = useReactFlow();
  const [tab, setTab] = useState(initial),
    [name, setName] = useState(''),
    [text, setText] = useState(''),
    [provider, setProvider] = useState('codex'),
    [directory, setDirectory] = useState(''),
    [slot, setSlot] = useState(1),
    [backups, setBackups] = useState([]),
    [history, setHistory] = useState('');
  useEffect(() => {
    setName('');
    setText('');
    if (tab === 'backups') request('/backup/list').then((r) => r && setBackups(r));
    if (tab === 'git')
      request(`/git/history?projectId=${project.id}`).then((r) => r && setHistory(r.text));
  }, [tab]);
  const tabs = [
    ['roles', BookOpen, '角色库'],
    ['accounts', Users, '独立账号'],
    ['views', Bookmark, '视图书签'],
    ['projects', Folder, '项目分组'],
    ['layers', Archive, '图层管理'],
    ['backups', Archive, '本地备份'],
    ['git', BookOpen, 'Git 历史'],
  ];
  return (
    <Modal
      title="工作台工具箱"
      description="管理团队、组织项目与保存常用布局。"
      onClose={onClose}
      className="connections-modal"
    >
      <div className="connections-layout">
        <nav className="connection-nav">
          {tabs.map(([id, Icon, title]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              <Icon size={16} />
              {title}
            </button>
          ))}
        </nav>
        <div className="connection-form workbench-content">
          {tab === 'roles' && (
            <>
              <h3 className="section-title">可复用的角色</h3>
              {(state.roles || []).map((r) => (
                <div className="library-item" key={r.id}>
                  <div>
                    <strong>{r.name}</strong>
                    <p>{r.instructions}</p>
                  </div>
                  <button
                    title="删除角色"
                    className="icon-button danger"
                    onClick={() => request(`/roles/${r.id}`, undefined, 'DELETE')}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <label>
                角色名称
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：声学文献审查员"
                />
              </label>
              <label>
                职责与工作要求
                <textarea
                  rows={7}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="写明输入、约束、工作方法与交付要求。"
                />
              </label>
              <button
                className="primary-button"
                disabled={!name.trim()}
                onClick={async () => {
                  if (await request('/roles', { name, instructions: text })) {
                    setName('');
                    setText('');
                  }
                }}
              >
                <Plus size={14} />
                保存角色
              </button>
              <p className="field-caption">在 Agent 节点设置中选择角色即可应用。</p>
            </>
          )}
          {tab === 'accounts' && (
            <>
              <h3 className="section-title">独立登录配置</h3>
              <p className="muted">
                每个账号使用自己的配置目录。创建后从原工具的登录流程授权，再分配给节点。
              </p>
              {(state.accounts || []).map((a) => (
                <div className="library-item" key={a.id}>
                  <div>
                    <strong>{a.name}</strong>
                    <small>
                      {a.provider} · {a.configDirectory}
                    </small>
                  </div>
                  <button
                    className="subtle-button"
                    onClick={async () => {
                      const r = await openTerminal(a.provider, a.id);
                      if (r) onClose();
                    }}
                  >
                    <LogIn size={13} />
                    登录
                  </button>
                  <button
                    className="icon-button danger"
                    title="移除账号记录"
                    onClick={() => request(`/accounts/${a.id}`, undefined, 'DELETE')}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <label>
                AI 工具
                <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="codex">Codex</option>
                  <option value="claude">Claude Code</option>
                </select>
              </label>
              <label>
                账号名称
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="个人 / 工作"
                />
              </label>
              <label>
                已有配置目录（可选）
                <input
                  value={directory}
                  onChange={(e) => setDirectory(e.target.value)}
                  placeholder="留空创建独立目录"
                />
              </label>
              <button
                className="primary-button"
                onClick={async () => {
                  if (await request('/accounts', { provider, name, configDirectory: directory })) {
                    setName('');
                    setDirectory('');
                  }
                }}
              >
                创建账号配置
              </button>
            </>
          )}
          {tab === 'views' && (
            <>
              <h3 className="section-title">画布视图书签</h3>
              <p className="muted">Alt + 数字跳转，Ctrl + Alt + 数字保存当前视图。</p>
              {(state.bookmarks || [])
                .filter((b) => b.projectId === project.id)
                .sort((a, b) => a.slot - b.slot)
                .map((b) => (
                  <div className="library-item" key={b.slot}>
                    <span className="slot-badge">{b.slot}</span>
                    <div>
                      <strong>{b.name}</strong>
                      <small>{Math.round(b.view.zoom * 100)}%</small>
                    </div>
                    <button
                      className="subtle-button"
                      onClick={() => {
                        flow.setViewport(b.view, { duration: 300 });
                        onClose();
                      }}
                    >
                      跳转
                    </button>
                    <button
                      className="icon-button"
                      title="删除书签"
                      onClick={() =>
                        request(`/bookmarks/${project.id}/${b.slot}`, undefined, 'DELETE')
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              <div className="form-two-col">
                <label>
                  位置
                  <select value={slot} onChange={(e) => setSlot(Number(e.target.value))}>
                    {Array.from({ length: 9 }, (_, i) => (
                      <option key={i} value={i + 1}>
                        {i + 1}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  视图名称
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：研究团队"
                  />
                </label>
              </div>
              <button
                className="primary-button"
                onClick={() =>
                  request('/bookmarks', {
                    projectId: project.id,
                    slot,
                    name,
                    view: flow.getViewport(),
                  })
                }
              >
                保存当前视图
              </button>
            </>
          )}
          {tab === 'projects' && (
            <>
              <h3 className="section-title">虚拟项目分组</h3>
              <p className="muted">分组只整理导航列表，不移动磁盘目录。</p>
              {(state.folders || []).map((f) => (
                <div className="library-item" key={f.id}>
                  <Folder size={16} />
                  <div>
                    <strong>{f.name}</strong>
                  </div>
                  <button
                    className="icon-button"
                    title="移除空分组"
                    onClick={() => request(`/folders/${f.id}`, undefined, 'DELETE')}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <div className="input-with-button">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="新分组名称"
                />
                <button
                  className="primary-button"
                  disabled={!name.trim()}
                  onClick={async () => {
                    if (await request('/folders', { name })) setName('');
                  }}
                >
                  创建
                </button>
              </div>
              {state.projects
                .filter((p) => !p.parentId)
                .map((p) => (
                  <label key={p.id}>
                    {p.name}
                    <select
                      value={p.folderId || ''}
                      onChange={(e) =>
                        request(`/projects/${p.id}/folder`, { folderId: e.target.value })
                      }
                    >
                      <option value="">未分组</option>
                      {(state.folders || []).map((f) => (
                        <option value={f.id} key={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
            </>
          )}
          {tab === 'layers' && (
            <>
              <h3 className="section-title">工作树图层</h3>
              {!state.projects.some((p) => p.parentId) && (
                <p className="muted">
                  从顶部 Git 分支按钮创建独立工作树，完成后可以在这里合并与归档。
                </p>
              )}
              {state.projects
                .filter((p) => p.parentId)
                .map((p) => (
                  <div className="layer-record" key={p.id}>
                    <strong>{p.name}</strong>
                    <small>
                      {p.branch} · {p.archived ? '已归档' : '可用'}
                    </small>
                    <div className="button-row">
                      <button
                        className="subtle-button"
                        onClick={() => {
                          changeProject(p.id);
                          onClose();
                        }}
                      >
                        打开
                      </button>
                      <button
                        className="subtle-button"
                        onClick={() => request(`/worktrees/${p.id}/land`, {})}
                      >
                        合并回主目录
                      </button>
                      <button
                        className="subtle-button"
                        onClick={() =>
                          request(`/layers/${p.id}/${p.archived ? 'restore' : 'archive'}`, {})
                        }
                      >
                        {p.archived ? '恢复' : '归档'}
                      </button>
                    </div>
                  </div>
                ))}
            </>
          )}
          {tab === 'backups' && (
            <>
              <h3 className="section-title">工作台备份</h3>
              <p className="muted">
                备份画布、便签、模板和任务记录。项目文件本体与原服务商登录资料由各自的位置保存。
              </p>
              <button
                className="primary-button"
                onClick={async () => {
                  if (await request('/backup/create', {})) {
                    setBackups((await request('/backup/list')) || []);
                    toast('本地备份已保存');
                  }
                }}
              >
                立即备份
              </button>
              {backups.map((b) => (
                <div className="library-item" key={b.name}>
                  <div>
                    <strong>{b.name}</strong>
                    <small>{Math.round(b.size / 1024)} KB</small>
                  </div>
                  <button
                    className="icon-button"
                    title="下载备份"
                    onClick={() => download(`/backup/${b.name}`)}
                  >
                    <Download size={15} />
                  </button>
                </div>
              ))}
            </>
          )}
          {tab === 'git' && (
            <>
              <h3 className="section-title">最近 25 次提交</h3>
              <pre className="git-history">{history || '没有可显示的提交历史'}</pre>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
