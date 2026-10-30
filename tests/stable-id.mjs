// 验证「换文件夹重装，扩展 ID 不变」——这样 chrome.storage 里的 API Key 才不会丢
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { resolveBrowser } from './browser-path.mjs';

const SRC = path.resolve(import.meta.dirname, '..');
const BROWSER = resolveBrowser();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (u) => (await fetch(u)).json();

function copyExtension(dest) {
  fs.mkdirSync(path.join(dest, 'src'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'manifest.json'), path.join(dest, 'manifest.json'));
  fs.cpSync(path.join(SRC, 'src'), path.join(dest, 'src'), { recursive: true });
  return dest;
}

async function extensionIdFor(dir, port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-id-'));
  const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, `--load-extension=${dir}`, '--no-first-run', '--disable-gpu', 'about:blank'],
    { stdio: 'ignore' });
  try {
    const t0 = Date.now();
    for (;;) {
      try {
        const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
        const sw = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js'));
        if (sw) return new URL(sw.url).host;
      } catch { /* 还没起来 */ }
      if (Date.now() - t0 > 25000) throw new Error('等不到扩展 service worker');
      await sleep(400);
    }
  } finally {
    child.kill();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-two-'));
const dirA = copyExtension(path.join(base, 'install-a'));
const dirB = copyExtension(path.join(base, 'another-folder-b'));

const idA = await extensionIdFor(dirA, 9360);
const idB = await extensionIdFor(dirB, 9361);

console.log('目录 A 的扩展 ID:', idA);
console.log('目录 B 的扩展 ID:', idB);
if (idA === idB) {
  console.log('✔ 换文件夹重装 ID 不变，chrome.storage 里的设置（含 API Key）会保留');
} else {
  console.error('✖ ID 不一致：更新后设置会丢');
  process.exitCode = 1;
}

fs.rmSync(base, { recursive: true, force: true });
