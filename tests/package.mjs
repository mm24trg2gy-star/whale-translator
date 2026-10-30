// 验证「发出去的 zip」解压后能被浏览器正确加载
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { resolveBrowser } from './browser-path.mjs';

// 自动挑 dist 里最新的那个 zip
const distDir = path.resolve(import.meta.dirname, '..', 'dist');
const newest = fs.readdirSync(distDir)
  .filter((f) => f.endsWith('.zip'))
  .map((f) => ({ f, t: fs.statSync(path.join(distDir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0];
if (!newest) {
  console.error('dist 里没有 zip，先打包再跑这个测试');
  process.exit(1);
}
const ZIP = path.join(distDir, newest.f);
const BROWSER = resolveBrowser();
const PORT = 9342;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (u) => (await fetch(u)).json();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-zip-'));
if (process.platform === 'win32') {
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${tmp}' -Force`]);
} else {
  execFileSync('unzip', ['-q', '-o', ZIP, '-d', tmp]);
}
const extDir = path.join(tmp, 'whale-translator');
console.log('解压后:', fs.existsSync(path.join(extDir, 'manifest.json')) ? '有 manifest.json ✓' : '缺 manifest ✗');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-zip-prof-'));
const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, `--load-extension=${extDir}`, '--no-first-run', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore' });

try {
  await sleep(5000);
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js'));
  console.log(sw ? '✔ 包里的扩展加载成功：' + sw.url : '✖ 没看到扩展的 service worker（包可能有问题）');
  if (!sw) process.exitCode = 1;
} catch (e) {
  console.error('zip test failed:', e.message);
  process.exitCode = 1;
} finally {
  child.kill();
  await sleep(400);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}
