import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from './store.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export function assertDirectory(directory) {
  if (
    typeof directory !== 'string' ||
    !fs.existsSync(directory) ||
    !fs.statSync(directory).isDirectory()
  )
    throw new Error('请选择存在的项目文件夹');
  return fs.realpathSync(directory);
}
export function inside(root, target) {
  const r = path.relative(root, target);
  return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r));
}
export function safePath(root, input, write = false) {
  const base = fs.realpathSync(root);
  const result = path.resolve(base, String(input || '.'));
  if (!inside(base, result)) throw new Error('路径超出项目范围');
  let parent = result;
  while (!fs.existsSync(parent)) {
    const up = path.dirname(parent);
    if (up === parent) throw new Error('无效路径');
    parent = up;
  }
  if (!inside(base, fs.realpathSync(parent))) throw new Error('符号链接指向项目以外的路径');
  if (
    write &&
    path
      .relative(base, result)
      .split(path.sep)
      .some(
        (p) =>
          ['.git', '.codex', '.claude', '.cursor', '.env'].includes(p) || p.startsWith('.env.'),
      )
  )
    throw new Error('应用内文件工具不允许改写凭据、Git 或 agent 配置；请手动操作');
  return result;
}
function locations(name) {
  const names =
    process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((p) => names.map((n) => path.join(p.replace(/^"|"$/g, ''), n)));
}
let discoveryCache;
export function discover(settings = {}, force = false) {
  const cacheKey = JSON.stringify(
    Object.entries(settings.providers || {}).map(([id, p]) => [
      id,
      p.executable,
      p.protocol,
      p.hasKey,
    ]),
  );
  if (!force && discoveryCache?.key === cacheKey && Date.now() - discoveryCache.at < 5000)
    return discoveryCache.value;
  const home = os.homedir();
  const nodeDir = path.dirname(
    process.env.STUDIO_NODE ||
      (process.versions.electron
        ? locations('node').find((p) => fs.existsSync(p)) || process.execPath
        : process.execPath),
  );
  const npmRoots = [
    ...new Set([
      path.join(nodeDir, 'node_modules'),
      path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules'),
      '/usr/local/lib/node_modules',
    ]),
  ];
  const result = PROVIDERS.map((provider) => {
    const config = settings.providers?.[provider.id] || {};
    let choices = [];
    if (provider.id === 'claude')
      choices.push(
        ...npmRoots.map((r) =>
          path.join(
            r,
            '@anthropic-ai',
            'claude-code',
            'bin',
            process.platform === 'win32' ? 'claude.exe' : 'claude',
          ),
        ),
        path.join(home, '.local', 'bin', 'claude.exe'),
      );
    if (provider.id === 'codex')
      choices.push(
        ...npmRoots.map((r) =>
          path.join(
            r,
            '@openai',
            'codex',
            'node_modules',
            '@openai',
            `codex-${process.platform}-${process.arch}`,
            'vendor',
            process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-musl',
            'codex',
            process.platform === 'win32' ? 'codex.exe' : 'codex',
          ),
        ),
        ...npmRoots.map((r) => path.join(r, '@openai', 'codex', 'bin', 'codex.js')),
      );
    if (provider.id === 'gemini')
      choices.push(
        ...npmRoots.map((r) => path.join(r, '@google', 'gemini-cli', 'bundle', 'gemini.js')),
      );
    if (provider.id === 'google') choices.push(...locations('agy'), ...locations('antigravity'));
    if (provider.id === 'grok') choices.push(path.join(home, '.grok', 'bin', 'grok.exe'));
    if (provider.id === 'cursor')
      choices.push(
        path.join(home, '.local', 'bin', 'cursor-agent.exe'),
        path.join(home, '.cursor', 'bin', 'agent.exe'),
        ...locations('cursor-agent'),
      );
    // A Grok executable named "agent" must never be silently treated as Cursor.
    if (provider.id === 'cursor')
      choices.push(
        ...locations('agent').filter(
          (p) => !p.toLowerCase().includes(`${path.sep}.grok${path.sep}`),
        ),
      );
    else if (provider.command) choices.push(...locations(provider.command));
    if (config.executable) choices = [config.executable];
    const executable = choices.find((p) => fs.existsSync(p) && fs.statSync(p).isFile()) || null;
    const protocol = config.protocol || provider.protocol;
    return {
      ...provider,
      executable,
      installed: protocol === 'api' ? true : !!executable,
      protocol,
      configured:
        protocol === 'api'
          ? !!(config.hasKey || (provider.id === 'deepseek' && process.env.DEEPSEEK_API_KEY))
          : !!executable,
      authStatus: 'not_checked',
    };
  });
  discoveryCache = { key: cacheKey, at: Date.now(), value: result };
  return result;
}
export function resolveLaunch(executable, args = []) {
  if (!executable) throw new Error('未找到此工具。请在连接设置中指定安装路径。');
  if (/\.(cmd|bat)$/i.test(executable))
    throw new Error(
      '请指定工具的 .exe 或 .js 文件。为避免 shell 转义问题，不自动运行批处理包装器。',
    );
  if (/\.(mjs|cjs|js)$/i.test(executable)) {
    const node = process.env.STUDIO_NODE || process.execPath;
    return {
      file: node,
      args: [executable, ...args],
      env:
        process.versions.electron && node === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    };
  }
  return { file: executable, args, env: {} };
}
export function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    'CODEX_THREAD_ID',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
    'CODEX_SANDBOX_NETWORK_DISABLED',
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'STUDIO_TEST_MODE',
  ])
    delete env[key];
  return { ...env, ...extra };
}
export function spawnCommand(executable, args, opts = {}) {
  const launch = resolveLaunch(executable, args);
  return spawn(launch.file, launch.args, {
    cwd: opts.cwd,
    env: childEnv({ ...launch.env, ...opts.env }),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
}
export function killProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore', shell: false },
    );
    killer.on('error', () => child.kill());
  } else child.kill('SIGTERM');
}
export async function capture(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(executable, args, options);
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => {
      killProcessTree(child);
      reject(new Error('命令超时'));
    }, options.timeout || 10000);
    const abort = () => {
      killProcessTree(child);
      clearTimeout(timer);
      reject(new Error('操作已停止'));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.length > 8_000_000) child.kill();
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ code, stdout, stderr });
    });
    if (options.signal?.aborted) abort();
  });
}
export async function git(directory, args) {
  const r = await capture(
    process.platform === 'win32' ? locations('git').find(fs.existsSync) || 'git' : 'git',
    ['-C', directory, ...args],
    { timeout: 30000 },
  );
  if (r.code) throw new Error(r.stderr.trim() || 'Git 操作失败');
  return r.stdout;
}
export const readText = (directory, file) => {
  const f = safePath(directory, file);
  const s = fs.statSync(f);
  if (!s.isFile() || s.size > 2_000_000) throw new Error('仅支持 2 MB 以内的文本文件');
  return fs.readFileSync(f, 'utf8');
};
export const listFiles = (directory, relative = '.') =>
  fs
    .readdirSync(safePath(directory, relative), { withFileTypes: true })
    .filter((d) => !['node_modules', '.git', '.studio-data'].includes(d.name))
    .slice(0, 300)
    .map((d) => ({
      name: d.name,
      path: path.join(relative, d.name),
      directory: d.isDirectory(),
      symlink: d.isSymbolicLink(),
    }));
