// 真实链路：默认接口（MyMemory，免 Key）翻一个本地英文页面，看真中文译文
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { resolveBrowser } from './browser-path.mjs';

const EXT_DIR = path.resolve(import.meta.dirname, '..');
const BROWSER = resolveBrowser();
const PORT = 9340;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (u) => (await fetch(u)).json();

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Whales</title></head>
<body style="font:16px/1.7 Georgia,serif;max-width:720px;margin:40px auto">
  <h1>Why Whales Matter</h1>
  <p>Whales are the largest animals that have ever lived on Earth, and they play a vital role in keeping the ocean healthy.</p>
  <p>Every year, humpback whales travel thousands of miles between their feeding grounds and their breeding grounds.</p>
  <ul><li>They help cycle nutrients through the water column.</li><li>Their songs can travel for hundreds of miles.</li></ul>
</body></html>`;

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (!m.id || !this.pending.has(m.id)) return;
      const s = this.pending.get(m.id); this.pending.delete(m.id);
      m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result);
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-real-'));
const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, `--load-extension=${EXT_DIR}`, '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'],
  { stdio: 'ignore' });

try {
  await sleep(4500);
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js'));
  const v = await getJson(`http://127.0.0.1:${PORT}/json/version`);
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const cdp = new CDP(ws);
  const { sessionId: swSession } = await cdp.send('Target.attachToTarget', { targetId: sw.id, flatten: true });
  const evalSw = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, swSession);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await sleep(1200);
  await evalSw(`chrome.storage.local.set({ settings: { provider: 'mymemory', target: 'zh-CN', mode: 'bilingual', auto: true, visibleOnly: false, selectionBubble: true } }).then(() => 1)`);

  const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${port}/` });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const evalPage = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    return r.result.value;
  };

  let count = 0;
  for (let i = 0; i < 60; i++) {
    count = await evalPage(`document.querySelectorAll('.ct-tr').length`).catch(() => 0);
    if (count >= 5) break;
    await sleep(1000);
  }
  const result = await evalPage(`Array.from(document.querySelectorAll('.ct-tr')).map((n) => n.textContent)`);
  const errors = await evalPage(`(() => {
    const h = document.getElementById('whale-translate-host');
    const t = h && h.shadowRoot && h.shadowRoot.querySelector('.toast');
    return t && t.style.display === 'block' ? t.textContent : '';
  })()`);
  console.log('译文数量:', count);
  console.log(JSON.stringify(result, null, 2));
  if (errors) console.log('页面提示:', errors);
} catch (e) {
  console.error('real test failed:', e.message);
  process.exitCode = 1;
} finally {
  child.kill();
  server.close();
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
