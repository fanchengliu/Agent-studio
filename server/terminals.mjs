import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { uid } from './store.mjs';
import { childEnv, resolveLaunch } from './system.mjs';

export class Terminals extends EventEmitter {
  constructor() {
    super();
    this.items = new Map();
  }
  open(directory, launch = null, label = 'PowerShell') {
    let pty;
    try {
      pty = createRequire(import.meta.url)('@lydell/node-pty');
    } catch (e) {
      throw new Error('本机 PTY 模块不可用：' + e.message);
    }
    const shell =
      process.platform === 'win32'
        ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        : '/bin/bash';
    const target = launch
      ? resolveLaunch(launch.executable, launch.args || [])
      : {
          file: shell,
          args: process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : [],
          env: {},
        };
    const processHandle = pty.spawn(target.file, target.args, {
      cwd: directory,
      name: 'xterm-256color',
      cols: 100,
      rows: 26,
      env: childEnv({ ...target.env, ...launch?.env }),
      useConpty: true,
    });
    const id = uid('term_');
    const item = { id, label, directory, process: processHandle, output: '', alive: true };
    this.items.set(id, item);
    processHandle.onData((data) => {
      item.output = (item.output + data).slice(-500000);
      this.emit('data', { id, data });
    });
    processHandle.onExit(({ exitCode }) => {
      item.alive = false;
      this.emit('exit', { id, exitCode });
    });
    return { id, label, alive: true };
  }
  write(id, data) {
    const t = this.items.get(id);
    if (!t?.alive) throw new Error('终端已退出');
    t.process.write(String(data).slice(0, 100000));
  }
  resize(id, cols, rows) {
    const t = this.items.get(id);
    if (t?.alive)
      t.process.resize(Math.max(10, Math.min(500, cols)), Math.max(3, Math.min(200, rows)));
  }
  close(id) {
    const t = this.items.get(id);
    if (t?.alive) t.process.kill();
    this.items.delete(id);
  }
  closeAll() {
    for (const id of this.items.keys()) this.close(id);
  }
}
