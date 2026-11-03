import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rcedit } from 'rcedit';
import { ensureElectron } from './ensure-electron.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
await ensureElectron();
const command = (file, args, cwd = root, env = process.env) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`命令退出码 ${code}`))));
  });
await command(process.execPath, [
  path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  'build',
]);
const outputRoot = path.join(root, 'release');
fs.mkdirSync(outputRoot, { recursive: true });
let output = path.join(outputRoot, `AgentStudio-Windows-v${pkg.version}`);
if (fs.existsSync(output)) output += '-ready';
if (fs.existsSync(output)) output += '-' + Date.now();
const electronPath = path.join(root, 'node_modules', 'electron', 'dist');
if (!fs.existsSync(path.join(electronPath, 'electron.exe')))
  throw new Error('打包需要 Windows x64 Electron 运行时');
fs.cpSync(electronPath, output, { recursive: true });
fs.renameSync(path.join(output, 'electron.exe'), path.join(output, 'Agent Studio.exe'));
await rcedit(path.join(output, 'Agent Studio.exe'), {
  'version-string': {
    FileDescription: 'Agent Studio',
    ProductName: 'Agent Studio',
    CompanyName: 'Agent Studio',
    OriginalFilename: 'Agent Studio.exe',
  },
  'file-version': pkg.version,
  'product-version': pkg.version,
  icon: path.join(root, 'electron', 'icon.ico'),
  'requested-execution-level': 'asInvoker',
});
const app = path.join(output, 'resources', 'app');
fs.mkdirSync(app, { recursive: true });
for (const folder of ['dist', 'server', 'electron'])
  fs.cpSync(path.join(root, folder), path.join(app, folder), { recursive: true });
for (const file of ['package.json', 'package-lock.json', 'LICENSE'])
  fs.copyFileSync(path.join(root, file), path.join(app, file));
const npm =
  process.env.npm_execpath ||
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
if (!fs.existsSync(npm)) throw new Error('未找到 npm-cli.js');
// No lifecycle scripts run during packaging. Drop the parent npm command's
// transient CLI allowlist, which npm 12 rejects in a nested project install.
const installEnv = { ...process.env };
for (const key of Object.keys(installEnv))
  if (/^npm_config_allow[_-]scripts$/i.test(key)) delete installEnv[key];
installEnv.npm_config_ignore_scripts = 'true';
await command(
  process.execPath,
  [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
  app,
  installEnv,
);
fs.copyFileSync(path.join(root, 'README.md'), path.join(output, '使用说明.md'));
fs.cpSync(path.join(root, 'docs'), path.join(output, 'docs'), { recursive: true });
const gitOutput = (args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
};
fs.writeFileSync(
  path.join(output, 'build-info.json'),
  JSON.stringify(
    {
      version: pkg.version,
      sourceCommit: gitOutput(['rev-parse', 'HEAD']),
      sourceDirty: !!gitOutput(['status', '--porcelain']),
      builtAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      electron: JSON.parse(
        fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'),
      ).version,
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(output, '打开应用.cmd'),
  '@echo off\r\ncd /d "%~dp0"\r\nstart "" "Agent Studio.exe"\r\n',
);
fs.writeFileSync(
  path.join(outputRoot, 'latest-build.json'),
  JSON.stringify(
    {
      directory: output,
      executable: path.join(output, 'Agent Studio.exe'),
      version: pkg.version,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log('Portable desktop build: ' + path.join(output, 'Agent Studio.exe'));
