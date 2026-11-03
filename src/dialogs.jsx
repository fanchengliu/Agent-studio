import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  FolderOpen,
  ChevronRight,
  Cable,
  Check,
  CircleAlert,
  LogIn,
  RefreshCw,
  Save,
  Download,
  Upload,
  Trash2,
  Clock3,
  Plus,
  ShieldCheck,
  TerminalSquare,
  ArrowUpRight,
} from 'lucide-react';
import { useStudio } from './context.jsx';
import { api, dateTime, download } from './api.js';
import { ProviderMark } from './nodes.jsx';

export function Modal({ title, description, children, onClose, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const prior = document.activeElement;
    const first = ref.current?.querySelector('input,textarea,select,button');
    first?.focus();
    return () => prior?.focus?.();
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Tab') {
            const all = [
              ...ref.current.querySelectorAll('button,input,select,textarea,a[href]'),
            ].filter((el) => !el.disabled && el.offsetParent !== null);
            const first = all[0],
              last = all.at(-1);
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" onClick={onClose} title="关闭对话框">
            <X size={19} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function ProjectDialog({ onClose, edit = false, worktree = false }) {
  const { project, request, changeProject } = useStudio();
  const [name, setName] = useState(edit ? project.name : ''),
    [directory, setDirectory] = useState(edit ? project.directory : ''),
    [busy, setBusy] = useState(false);
  const title = worktree ? '创建独立 Git 分支' : edit ? '工作台设置' : '新建工作台';
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    const r = await request(
      worktree ? '/worktrees' : edit ? `/projects/${project.id}` : '/projects',
      worktree ? { projectId: project.id, name } : { name: name || '新工作台', directory },
      edit ? 'PATCH' : 'POST',
    );
    setBusy(false);
    if (r) {
      changeProject(r.id);
      onClose();
    }
  };
  return (
    <Modal
      title={title}
      description={
        worktree
          ? '为并行工作创建独立目录和分支，完成后可合并回主工作台。'
          : '一个工作台对应一个项目目录，代码和文档都保留在本机。'
      }
      onClose={onClose}
    >
      <form className="dialog-form" onSubmit={save}>
        <label>
          {worktree ? '英文分支名' : '工作台名称'}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={worktree ? 'feature-search' : '例如：声学模型研究'}
            required
            maxLength={80}
          />
        </label>
        {!worktree && (
          <label>
            项目目录
            <div className="input-with-button">
              <input
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                placeholder="留空创建新的独立目录"
              />
              <button
                type="button"
                className="subtle-button"
                onClick={async () => {
                  const r = await request('/dialog/directory', {});
                  if (r?.directory) setDirectory(r.directory);
                }}
              >
                <FolderOpen size={15} />
                选择
              </button>
            </div>
          </label>
        )}
        <div className="modal-footer">
          <button type="button" className="subtle-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" disabled={busy}>
            {busy ? '处理中…' : worktree ? '创建分支' : edit ? '保存设置' : '创建工作台'}
            <ChevronRight size={15} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function ConnectionsDialog({ onClose }) {
  const { state, request, openTerminal, toast } = useStudio();
  const [selected, setSelected] = useState('codex');
  return (
    <Modal
      title="连接你的 AI 工具"
      description="沿用各家工具的本机登录。设置连接不会自动发起模型任务。"
      onClose={onClose}
      className="connections-modal"
    >
      <div className="connections-layout">
        <nav className="connection-nav" aria-label="AI 工具">
          {state.providers.map((p) => (
            <button
              key={p.id}
              className={selected === p.id ? 'active' : ''}
              onClick={() => setSelected(p.id)}
            >
              <ProviderMark id={p.id} size={26} />
              <span>{p.name}</span>
              <i className={`tiny-dot ${p.configured ? 'available' : ''}`} />
            </button>
          ))}
        </nav>
        <ConnectionForm
          key={selected}
          provider={state.providers.find((p) => p.id === selected)}
          config={state.settings.providers[selected] || {}}
          onClose={onClose}
        />
      </div>
    </Modal>
  );
}
function ConnectionForm({ provider, config, onClose }) {
  const { request, openTerminal, toast, state } = useStudio();
  const [form, setForm] = useState({
    executable: config.executable || provider.executable || '',
    protocol: config.protocol || provider.protocol,
    args: JSON.stringify(config.args || [], null, 2),
    prefixArgs: JSON.stringify(config.prefixArgs || []),
    readOnlyArgs: JSON.stringify(config.readOnlyArgs || []),
    resumeFlag: config.resumeFlag || '',
    apiKey: '',
    baseUrl: config.baseUrl || (provider.id === 'deepseek' ? 'https://api.deepseek.com' : ''),
    model: config.model || '',
  });
  const [check, setCheck] = useState(null),
    [checking, setChecking] = useState(false),
    [saving, setSaving] = useState(false);
  const field = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const save = async (e) => {
    e.preventDefault();
    let args, prefixArgs, readOnlyArgs;
    try {
      args = JSON.parse(form.args);
      prefixArgs = JSON.parse(form.prefixArgs);
      readOnlyArgs = JSON.parse(form.readOnlyArgs);
    } catch {
      return toast('命令参数必须是有效的 JSON 字符串数组');
    }
    setSaving(true);
    const r = await request(
      '/settings',
      { provider: { id: provider.id, ...form, args, prefixArgs, readOnlyArgs } },
      'PATCH',
    );
    setSaving(false);
    if (r) {
      field('apiKey', '');
      toast('连接设置已保存');
    }
  };
  return (
    <form className="connection-form" onSubmit={save}>
      <div className="connection-title">
        <ProviderMark id={provider.id} size={42} />
        <div>
          <h3>{provider.name}</h3>
          <p>{provider.subscription}</p>
        </div>
        <span className={`connection-state ${provider.installed ? 'found' : ''}`}>
          {provider.protocol === 'api'
            ? config.hasKey
              ? '已设置 Key'
              : '待设置 Key'
            : provider.installed
              ? '发现本机工具'
              : '未找到工具'}
        </span>
      </div>
      {form.protocol !== 'api' && (
        <>
          <label>
            工具路径
            <div className="input-with-button">
              <input
                value={form.executable}
                onChange={(e) => field('executable', e.target.value)}
                placeholder="选择 .exe 或官方 CLI 的 .js 文件"
              />
              <button
                type="button"
                className="icon-button"
                title="选择可执行文件"
                onClick={async () => {
                  const r = await request('/dialog/file', {});
                  if (r?.file) field('executable', r.file);
                }}
              >
                <FolderOpen size={17} />
              </button>
            </div>
          </label>
          <label>
            连接协议
            <select value={form.protocol} onChange={(e) => field('protocol', e.target.value)}>
              <option value="codex">Codex app-server</option>
              <option value="claude">Claude Code 结构化会话</option>
              <option value="acp">ACP 标准协议</option>
              <option value="jsonl">通用结构化命令行</option>
              <option value="api">兼容 API</option>
            </select>
          </label>
        </>
      )}
      {form.protocol === 'jsonl' && (
        <>
          <label>
            启动参数（JSON 数组）
            <textarea
              rows={3}
              className="mono"
              value={form.args}
              onChange={(e) => field('args', e.target.value)}
              placeholder={'["-p", "{prompt}", "--output-format", "stream-json"]'}
            />
          </label>
          <p className="field-caption">
            可用 {'{prompt}'} 指定目标的位置；不填写时将使用此协议的默认参数。
          </p>
          <label>
            恢复会话参数
            <input
              value={form.resumeFlag}
              onChange={(e) => field('resumeFlag', e.target.value)}
              placeholder="例如 --resume（可选）"
            />
          </label>
        </>
      )}
      {form.protocol === 'jsonl' && (
        <label>
          只读模式参数（JSON 数组）
          <input
            className="mono"
            value={form.readOnlyArgs}
            onChange={(e) => field('readOnlyArgs', e.target.value)}
            placeholder={'["--mode", "plan"]'}
          />
        </label>
      )}
      {form.protocol === 'acp' && (
        <label>
          ACP 启动参数（JSON 数组）
          <textarea
            rows={2}
            className="mono"
            value={form.args}
            onChange={(e) => field('args', e.target.value)}
            placeholder={'["acp"]'}
          />
        </label>
      )}
      {form.protocol === 'api' && (
        <>
          <label>
            API 地址
            <input
              value={form.baseUrl}
              onChange={(e) => field('baseUrl', e.target.value)}
              placeholder="https://api.deepseek.com"
            />
          </label>
          <label>
            默认模型
            <input
              value={form.model}
              onChange={(e) => field('model', e.target.value)}
              placeholder="填写服务提供商的模型名称"
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              value={form.apiKey}
              autoComplete="off"
              onChange={(e) => field('apiKey', e.target.value)}
              placeholder={config.hasKey ? '已保存，留空保留当前 Key' : '输入你的 API Key'}
            />
          </label>
          <p className="connection-hint">
            <ShieldCheck size={15} />
            {state.desktop
              ? 'Key 使用系统加密，仅保存在这台电脑。'
              : '浏览器模式只在本次进程中保留 Key。'}
          </p>
          <p className="field-caption">API 用量按服务商规则计费，网页登录与 API Key 是不同入口。</p>
        </>
      )}
      {provider.id === 'google' && (
        <p className="connection-hint">
          Google AI 套餐请配置 Antigravity CLI（agy）。旧 Gemini CLI
          与当前登录入口可能不同，请以本机版本为准。
        </p>
      )}
      {check && (
        <div className="check-result">
          <Check size={14} />
          <div>
            <strong>{check.version || check.message}</strong>
            <p>
              {check.auth === 'signed_in'
                ? '已检测到登录状态'
                : check.auth === 'signed_out'
                  ? '尚未登录，请打开登录终端'
                  : check.auth === 'key_configured'
                    ? 'Key 已设置，未调用模型'
                    : '工具检查完成，登录状态尚未验证'}
            </p>
          </div>
        </div>
      )}
      <div className="connection-form-footer">
        <button className="primary-button" disabled={saving}>
          <Save size={14} />
          {saving ? '保存中…' : '保存连接'}
        </button>
        <button
          type="button"
          className="subtle-button"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            const r = await request(`/providers/${provider.id}/check`, {});
            if (r) setCheck(r);
            setChecking(false);
          }}
        >
          <RefreshCw size={14} className={checking ? 'spin' : ''} />
          {checking ? '检查中…' : '检查工具'}
        </button>
        {form.protocol !== 'api' && (
          <button
            type="button"
            className="subtle-button"
            onClick={async () => {
              const r = await openTerminal(provider.id);
              if (r) onClose();
            }}
          >
            <LogIn size={14} />
            登录
          </button>
        )}
      </div>
      <p className="field-caption">
        修改路径后请先保存，再检查连接。工具与套餐的额度仍由原服务商控制。
      </p>
    </form>
  );
}
export function SettingsDialog({ onClose }) {
  const { state, request, toast } = useStudio();
  const [maxConcurrency, setConcurrency] = useState(state.settings.maxConcurrency),
    [maxTaskMinutes, setMinutes] = useState(state.settings.maxTaskMinutes);
  const file = useRef(null);
  return (
    <Modal title="应用设置" description="本机运行，工作台数量不设付费限制。" onClose={onClose}>
      <form
        className="dialog-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await request('/settings', { maxConcurrency, maxTaskMinutes }, 'PATCH');
          if (r) {
            toast('设置已保存');
            onClose();
          }
        }}
      >
        <div className="form-two-col">
          <label>
            最多同时执行
            <input
              type="number"
              min={1}
              max={8}
              value={maxConcurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
            />
          </label>
          <label>
            每个任务时限（分钟）
            <input
              type="number"
              min={1}
              max={240}
              value={maxTaskMinutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            />
          </label>
        </div>
        <p className="field-caption">提高并发会更快消耗各家套餐的可用额度。超时将停止当前任务。</p>
        <div className="section-line" />
        <label>
          界面主题
          <select
            value={state.settings.theme || 'light'}
            onChange={(e) => request('/settings', { theme: e.target.value }, 'PATCH')}
          >
            <option value="light">浅色</option>
            <option value="dark">深色</option>
            <option value="system">跟随系统</option>
          </select>
        </label>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={!!state.settings.reduceMotion}
            onChange={(e) => request('/settings', { reduceMotion: e.target.checked }, 'PATCH')}
          />
          <span>减少动态效果</span>
        </label>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={!!state.settings.notifications}
            onChange={(e) => request('/settings', { notifications: e.target.checked }, 'PATCH')}
          />
          <span>任务完成或失败时通知我</span>
        </label>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={!!state.settings.autoBackup}
            onChange={(e) => request('/settings', { autoBackup: e.target.checked }, 'PATCH')}
          />
          <span>每天自动备份（自动备份保留 14 天）</span>
        </label>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={!!state.settings.keepAlive}
            onChange={(e) => request('/settings', { keepAlive: e.target.checked }, 'PATCH')}
          />
          <span>关闭窗口后在托盘继续工作</span>
        </label>
        <h3 className="section-title">工作台备份</h3>
        <p className="muted">
          导出画布、任务和便签。备份不包含模型 Key、原服务商登录信息和项目文件本体。
        </p>
        <div className="button-row">
          <button type="button" className="subtle-button" onClick={() => download('/export')}>
            <Download size={14} />
            导出备份
          </button>
          <button type="button" className="subtle-button" onClick={() => file.current.click()}>
            <Upload size={14} />
            从备份恢复
          </button>
          <input
            ref={file}
            type="file"
            accept=".json"
            hidden
            onChange={async (e) => {
              const f = e.target.files[0];
              if (!f) return;
              try {
                const data = JSON.parse(await f.text());
                const r = await request('/import', data);
                if (r) {
                  toast('已恢复工作台；定时任务保持关闭');
                  onClose();
                }
              } catch {
                toast('无法读取此备份文件');
              }
            }}
          />
        </div>
        <div className="modal-footer">
          <button type="button" className="subtle-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button">保存设置</button>
        </div>
      </form>
    </Modal>
  );
}
export function RoutinesDialog({ onClose }) {
  const { state, project, request } = useStudio();
  const [name, setName] = useState(''),
    [prompt, setPrompt] = useState(''),
    [minutes, setMinutes] = useState(60),
    [enabled, setEnabled] = useState(false),
    [kind, setKind] = useState('interval'),
    [time, setTime] = useState('09:00'),
    [day, setDay] = useState(1),
    [at, setAt] = useState('');
  return (
    <Modal
      title="定时协作"
      description="应用运行时按设定间隔执行整个团队流程；忙碌时跳过，避免重复启动。"
      onClose={onClose}
      className="routines-modal"
    >
      <div className="dialog-form">
        <div className="routine-list">
          {state.routines
            .filter((r) => r.projectId === project.id)
            .map((r) => (
              <div className="routine-item" key={r.id}>
                <Clock3 size={17} />
                <div>
                  <strong>{r.name}</strong>
                  <small>
                    {r.schedule?.kind === 'daily'
                      ? '每天 ' + r.schedule.time
                      : r.schedule?.kind === 'weekly'
                        ? '每周 ' + r.schedule.time
                        : r.schedule?.kind === 'once'
                          ? '单次任务'
                          : '每 ' + r.minutes + ' 分钟'}{' '}
                    · {r.enabled ? `下次 ${dateTime(r.nextAt)}` : '已暂停'}
                  </small>
                </div>
                <button
                  className="subtle-button"
                  onClick={() => request(`/routines/${r.id}`, { enabled: !r.enabled }, 'PATCH')}
                >
                  {r.enabled ? '暂停' : '启用'}
                </button>
                <button
                  className="icon-button danger"
                  title="删除定时任务"
                  onClick={() => request(`/routines/${r.id}`, undefined, 'DELETE')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
        </div>
        <div className="section-line" />
        <h3 className="section-title">创建新的定时任务</h3>
        <div className="form-two-col">
          <label>
            任务名称
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="每日项目检查"
            />
          </label>
          <label>
            间隔（分钟）
            <input
              type="number"
              min={1}
              max={10080}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            />
          </label>
        </div>
        <label>
          执行方式
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="interval">按间隔</option>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="once">指定时间执行一次</option>
          </select>
        </label>
        {['daily', 'weekly'].includes(kind) && (
          <label>
            执行时间（香港时间）
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        )}
        {kind === 'weekly' && (
          <label>
            星期
            <select value={day} onChange={(e) => setDay(Number(e.target.value))}>
              {['日', '一', '二', '三', '四', '五', '六'].map((d, i) => (
                <option key={i} value={i}>
                  星期{d}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === 'once' && (
          <label>
            执行日期（香港时间）
            <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </label>
        )}
        <label>
          团队目标
          <textarea
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="检查项目进展，并输出简明报告…"
          />
        </label>
        <label className="toggle-label">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>
            创建后启用<small>执行会使用你连接的 AI 工具与套餐额度</small>
          </span>
        </label>
        <div className="modal-footer">
          <button
            className="primary-button"
            disabled={!prompt.trim()}
            onClick={async () => {
              const r = await request('/routines', {
                projectId: project.id,
                name: name || '定时任务',
                prompt,
                minutes,
                enabled,
                schedule: {
                  kind,
                  minutes,
                  time,
                  days: [day],
                  at: at ? at + ':00+08:00' : undefined,
                  offsetMinutes: 480,
                },
              });
              if (r) {
                setPrompt('');
                setName('');
                setEnabled(false);
              }
            }}
          >
            <Plus size={14} />
            创建定时任务
          </button>
        </div>
      </div>
    </Modal>
  );
}
export function ApprovalDialog({ item }) {
  const { request, state } = useStudio();
  const [answers, setAnswers] = useState({});
  const node = state.nodes.find((n) => n.id === item.nodeId);
  return (
    <Modal
      title={item.type === 'input' ? 'Agent 需要补充信息' : '确认这项操作'}
      description={`${node?.data.name || 'Agent'} 正在等待你的决定。`}
      onClose={() => request(`/approvals/${item.id}`, { answer: false })}
      className="approval-modal"
    >
      <div className="dialog-form">
        <div className="approval-agent">
          <ProviderMark id={node?.data.provider || 'custom'} />
          <strong>{node?.data.name}</strong>
          <span>{item.tool}</span>
        </div>
        {item.type === 'input' ? (
          (item.input.questions || []).map((q, i) => {
            const id = q.id || String(i);
            return (
              <label key={id}>
                {q.question || q.header || q.title}
                <input
                  value={answers[id] || ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [id]: e.target.value }))}
                  placeholder={q.options?.map((o) => o.label || o.id).join(' / ') || '输入回复'}
                />
              </label>
            );
          })
        ) : (
          <pre className="approval-code">
            {typeof item.input === 'string' ? item.input : JSON.stringify(item.input, null, 2)}
          </pre>
        )}
        <div className="modal-footer">
          <button
            className="subtle-button danger"
            onClick={() => request(`/approvals/${item.id}`, { answer: false })}
          >
            拒绝
          </button>
          <button
            className="primary-button"
            onClick={() =>
              request(`/approvals/${item.id}`, {
                answer:
                  item.type === 'input'
                    ? Object.fromEntries(
                        Object.entries(answers).map(([k, v]) => [k, { answers: [v] }]),
                      )
                    : true,
              })
            }
          >
            {item.type === 'input' ? '发送回复' : '允许本次操作'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
export function ArrangementsDialog({ onClose }) {
  const { state, project, request, toast } = useStudio();
  const [name, setName] = useState('');
  return (
    <Modal
      title="团队模板"
      description="把角色、模型、便签和连接保存下来，在其他工作台重复使用。"
      onClose={onClose}
    >
      <div className="dialog-form">
        <div className="routine-list">
          {(state.arrangements || []).map((a) => (
            <div className="routine-item" key={a.id}>
              <Cable size={18} />
              <div>
                <strong>{a.name}</strong>
                <small>
                  {a.nodes.filter((n) => n.type === 'agent').length} 个 Agent ·{' '}
                  {dateTime(a.createdAt)}
                </small>
              </div>
              <button
                className="subtle-button"
                onClick={async () => {
                  const r = await request(`/arrangements/${a.id}/apply`, { projectId: project.id });
                  if (r) {
                    toast('已添加团队模板');
                    onClose();
                  }
                }}
              >
                应用
              </button>
              <button
                className="icon-button danger"
                title="删除模板"
                onClick={() => request(`/arrangements/${a.id}`, undefined, 'DELETE')}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {!state.arrangements?.length && (
            <p className="muted">还没有自定义模板。把当前团队保存下来，就可以跨工作台复用。</p>
          )}
        </div>
        <div className="section-line" />
        <label>
          保存当前画布为模板
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：研究与交叉核对团队"
          />
        </label>
        <button
          className="primary-button"
          disabled={!name.trim()}
          onClick={async () => {
            const r = await request('/arrangements', { projectId: project.id, name });
            if (r) {
              setName('');
              toast('团队模板已保存');
            }
          }}
        >
          <Save size={14} />
          保存团队模板
        </button>
        <p className="field-caption">模板不包含任务记录、会话 ID 或账号凭据。</p>
      </div>
    </Modal>
  );
}
