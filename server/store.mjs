import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const uid = (prefix = '') => prefix + randomUUID();
export const stamp = () => new Date().toISOString();
export const PROVIDERS = [
  {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    color: '#70bd9b',
    protocol: 'codex',
    subscription: 'ChatGPT 套餐',
    command: 'codex',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    vendor: 'Anthropic',
    color: '#d6a282',
    protocol: 'claude',
    subscription: 'Claude 套餐',
    command: 'claude',
  },
  {
    id: 'google',
    name: 'Antigravity',
    vendor: 'Google',
    color: '#8faee4',
    protocol: 'jsonl',
    subscription: 'Google AI 套餐',
    command: 'agy',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    vendor: 'Cursor',
    color: '#b7bdd1',
    protocol: 'acp',
    subscription: 'Cursor 套餐',
    command: 'agent',
  },
  {
    id: 'grok',
    name: 'Grok',
    vendor: 'xAI',
    color: '#c2b4e9',
    protocol: 'acp',
    subscription: 'Grok 套餐',
    command: 'grok',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: 'DeepSeek',
    color: '#7fa3ea',
    protocol: 'api',
    subscription: '自备 API Key',
    command: '',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'OpenCode',
    color: '#9ba3b5',
    protocol: 'acp',
    subscription: '工具当前登录',
    command: 'opencode',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    vendor: 'Google',
    color: '#9baed4',
    protocol: 'acp',
    subscription: '工具当前登录',
    command: 'gemini',
  },
  {
    id: 'custom',
    name: '自定义 CLI',
    vendor: 'Local',
    color: '#c2b591',
    protocol: 'jsonl',
    subscription: '按工具设置',
    command: '',
  },
];

export class Store extends EventEmitter {
  constructor(directory) {
    super();
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'workspace.json');
    if (fs.existsSync(this.file)) {
      try {
        this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (error) {
        throw new Error(`工作区文件读取失败，原文件已保留：${error.message}`);
      }
      if (this.state.schemaVersion !== 1) throw new Error('不支持的工作区版本，拒绝覆盖现有数据');
    } else {
      const workdir = path.join(directory, 'projects', 'first-workspace');
      fs.mkdirSync(workdir, { recursive: true });
      this.state = {
        schemaVersion: 1,
        projects: [
          { id: uid('p_'), name: '我的工作台', directory: workdir, createdAt: stamp(), view: null },
        ],
        nodes: [],
        edges: [],
        tasks: [],
        runs: [],
        routines: [],
        settings: { maxConcurrency: 3, maxTaskMinutes: 30, providers: {} },
        events: [],
      };
    }
    this.state.arrangements ||= [];
    for (const task of this.state.tasks) {
      if (['running', 'waiting_approval', 'queued'].includes(task.status)) {
        task.status = 'interrupted';
        task.error = '上次会话已结束。请查看输出后选择重新执行，避免重复产生副作用。';
        task.endedAt = stamp();
      }
    }
    for (const run of this.state.runs)
      if (run.status === 'running') {
        run.status = 'interrupted';
        run.endedAt = stamp();
      }
    this.flush();
  }
  project(id) {
    const p = this.state.projects.find((p) => p.id === id);
    if (!p) throw new Error('工作区不存在');
    return p;
  }
  node(id) {
    const n = this.state.nodes.find((n) => n.id === id);
    if (!n) throw new Error('节点不存在');
    return n;
  }
  task(id) {
    const t = this.state.tasks.find((t) => t.id === id);
    if (!t) throw new Error('任务不存在');
    return t;
  }
  update(fn, immediate = true) {
    const result = fn(this.state);
    this.changed(immediate);
    return result;
  }
  changed(immediate = false) {
    if (immediate) this.flush();
    else if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, 150);
    this.emit('change');
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  event(type, message, detail = {}) {
    const event = { id: uid('e_'), type, message, at: stamp(), ...detail };
    this.state.events.push(event);
    this.state.events = this.state.events.slice(-400);
    this.changed();
    return event;
  }
  snapshot() {
    const state = structuredClone(this.state);
    for (const p of Object.values(state.settings.providers || {})) {
      delete p.apiKey;
      delete p.encryptedKey;
    }
    return state;
  }
  close() {
    this.flush();
  }
}

export function makeNode(projectId, type, data = {}, position = { x: 80, y: 120 }) {
  return {
    id: uid('n_'),
    projectId,
    type,
    position,
    data:
      type === 'agent'
        ? {
            name: '新 Agent',
            provider: 'codex',
            role: '执行',
            instructions: '',
            model: '',
            mode: 'ask',
            orchestrator: false,
            sessionId: null,
            ...data,
          }
        : type === 'note'
          ? { name: '共享便签', content: '', ...data }
          : type === 'portal'
            ? { name: '浏览器', url: 'https://example.com', ...data }
            : {
                name:
                  {
                    frame: '区域标注',
                    binder: '笔记本',
                    text: '文字标注',
                    drawing: '自由绘制',
                    terminal: '终端',
                  }[type] || '新节点',
                ...data,
              },
  };
}
