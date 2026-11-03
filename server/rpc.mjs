import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export class JsonRpc extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    this.sequence = 0;
    this.pending = new Map();
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    child.stdout.on('data', (data) => this.feed(this.decoder.write(data)));
    child.stderr.on('data', (data) => this.emit('stderr', data.toString()));
    child.on('error', (error) => this.fail(error));
    child.on('close', (code) => {
      this.fail(new Error(`Agent 进程已退出 (${code})`));
      this.emit('exit', code);
    });
  }
  feed(data) {
    this.buffer += data;
    if (this.buffer.length > 8_000_000) {
      this.fail(new Error('Agent 协议消息过大'));
      this.child.kill();
      return;
    }
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit('log', line);
        continue;
      }
      if (message.method && message.id !== undefined) this.emit('request', message);
      else if (message.method) this.emit('notification', message);
      else if (message.id !== undefined && this.pending.has(message.id)) {
        const p = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error)
          p.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else p.resolve(message.result);
      } else this.emit('message', message);
    }
  }
  write(message) {
    if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method, params = {}, timeout = 60000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 等待超时`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  reply(id, result) {
    this.write({ jsonrpc: '2.0', id, result });
  }
  reject(id, message) {
    this.write({ jsonrpc: '2.0', id, error: { code: -32603, message } });
  }
  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params });
  }
  fail(error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  close() {
    this.fail(new Error('连接已关闭'));
    this.child.stdin.end();
    this.child.kill();
  }
}

export function completion(rpc, predicate, signal) {
  return new Promise((resolve, reject) => {
    const clean = () => {
      rpc.off('notification', onMessage);
      rpc.off('exit', onExit);
      signal?.removeEventListener('abort', onAbort);
    };
    const onMessage = (m) => {
      const value = predicate(m);
      if (value !== undefined) {
        clean();
        resolve(value);
      }
    };
    const onExit = (code) => {
      clean();
      reject(new Error(`Agent 在任务完成前退出 (${code})`));
    };
    const onAbort = () => {
      clean();
      reject(new Error('任务已停止'));
    };
    rpc.on('notification', onMessage);
    rpc.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
