import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (file, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Runtime setup failed (${code})`)),
    );
  });

export async function ensureElectron() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('This baseline packages Windows x64 only.');
  const folder = path.join(root, 'node_modules', 'electron');
  const { version } = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
  const executable = path.join(folder, 'dist', 'electron.exe');
  const versionFile = path.join(folder, 'dist', 'version');
  if (
    fs.existsSync(executable) &&
    fs.existsSync(versionFile) &&
    fs.readFileSync(versionFile, 'utf8').trim().replace(/^v/, '') === version
  ) {
    fs.writeFileSync(path.join(folder, 'path.txt'), 'electron.exe');
    return executable;
  }
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Unexpected Electron version');
  const name = `electron-v${version}-win32-x64.zip`;
  const checksums = JSON.parse(fs.readFileSync(path.join(folder, 'checksums.json'), 'utf8'));
  const expected = checksums[name];
  if (!expected) throw new Error('Electron package does not contain the expected checksum');
  const cache = path.join(root, '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, name);
  const hash = () => createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (!fs.existsSync(archive) || hash() !== expected) {
    console.log(`Downloading official Electron ${version} for Windows x64…`);
    await run('curl.exe', [
      '--fail',
      '--location',
      '--retry',
      '2',
      '--max-time',
      '240',
      '--silent',
      '--show-error',
      '--output',
      archive,
      `https://github.com/electron/electron/releases/download/v${version}/${name}`,
    ]);
  }
  if (hash() !== expected) throw new Error('Electron SHA-256 mismatch; archive was not extracted.');
  const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
  const script = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${literal(archive)} -DestinationPath ${literal(path.join(folder, 'dist'))} -Force`;
  await run(
    path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
  );
  fs.writeFileSync(path.join(folder, 'path.txt'), 'electron.exe');
  console.log('Electron runtime verified and ready.');
  return executable;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureElectron().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
