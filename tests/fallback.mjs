// 额度兜底的端到端验证：MyMemory 处于冷却 → 页面自动改用大模型 + 弹提示 + 设置页显示状态
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { resolveBrowser } from './browser-path.mjs';

const EXT_DIR = path.resolve(import.meta.dirname, '..');
const BROWSER = resolveBrowser();
const PORT_CDP = Number(process.env.WT_CDP_PORT || 9344);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (u) => (await fetch(u)).json();

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fallback test</title></head>
<body>
  <h1>Whales of the open sea</h1>
  <p>Whales travel enormous distances every year, following the seasons and the food.</p>
  <p>Their songs carry for miles through the water, and nobody fully knows why.</p>
</body></html>`;

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname === '/page') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (pathname.endsWith('/chat/completions')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      const texts = JSON.parse(payload.messages[1].content);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: texts.map((t) => '［大模型］' + t) }) } }] }));
    });
    return;
  }
  res.writeHead(404).end('nope');
});

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

async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* 继续等 */ }
    if (Date.now() - t0 > timeout) throw new Error('超时：' + label);
    await sleep(250);
  }
}

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-fb-'));
const chrome = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT_CDP}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, `--load-extension=${EXT_DIR}`, '--no-first-run', '--disable-gpu',
  '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

const fail = (m) => { console.error('✖ ' + m); process.exitCode = 1; };

try {
  const v = await waitFor(() => getJson(`http://127.0.0.1:${PORT_CDP}/json/version`), 15000, 'CDP 端口');
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const cdp = new CDP(ws);

  const sw = await waitFor(async () => {
    const ts = await getJson(`http://127.0.0.1:${PORT_CDP}/json/list`);
    return ts.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js'));
  }, 20000, '扩展 SW');
  const extId = new URL(sw.url).host;
  const { sessionId: swSession } = await cdp.send('Target.attachToTarget', { targetId: sw.id, flatten: true });
  const evalSw = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, swSession);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result.value;
  };
  await waitFor(() => evalSw('!!(globalThis.chrome && chrome.storage && chrome.storage.local)'), 15000, 'chrome.storage');

  // 预置：MyMemory 已冷却 + 配好大模型
  const settings = {
    provider: 'mymemory', target: 'zh-CN', mode: 'bilingual', auto: true, visibleOnly: false,
    selectionBubble: true, autoFallback: true,
    llm: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-fb', model: 'mock', jsonMode: true }
  };
  const quota = { mymemory: { until: Date.now() + 3600 * 1000, at: Date.now(), reason: '测试：额度用完' } };
  await evalSw(`chrome.storage.local.set(${JSON.stringify({ settings, quota })}).then(() => 1)`);

  const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${port}/page` });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const evalPage = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    return r.result.value;
  };

  const count = await waitFor(async () => {
    const n = await evalPage(`document.querySelectorAll('.ct-tr').length`);
    return n >= 3 ? n : 0;
  }, 30000, '页面译文');
  const trs = await evalPage(`Array.from(document.querySelectorAll('.ct-tr')).map((n) => n.textContent)`);
  const toast = await evalPage(`(() => {
    const h = document.getElementById('whale-translate-host');
    const t = h && h.shadowRoot && h.shadowRoot.querySelector('.toast');
    return t && t.style.display !== 'none' ? t.textContent : '';
  })()`);
  console.log('译文数量:', count);
  console.log('译文样本:', trs.slice(0, 2).join(' | '));
  console.log('页面提示:', toast || '(无)');

  if (!trs.every((t) => t.startsWith('［大模型］'))) fail('冷却期内没有走大模型');
  if (!toast.includes('自动切到大模型')) fail('没弹出自动切换的提示');

  // 提示条应该在屏幕正中
  const pos = await evalPage(`(() => {
    const t = document.getElementById('whale-translate-host').shadowRoot.querySelector('.toast');
    const r = t.getBoundingClientRect();
    return { dx: Math.abs(r.left + r.width / 2 - innerWidth / 2), dy: Math.abs(r.top + r.height / 2 - innerHeight / 2) };
  })()`);
  console.log('提示条偏移:', JSON.stringify(pos));
  if (pos.dx > 6 || pos.dy > 6) fail('提示条没有居中');

  // 设置页：应显示额度告警，并支持一键切回
  const { targetId: optTab } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options.html` });
  const { sessionId: os2 } = await cdp.send('Target.attachToTarget', { targetId: optTab, flatten: true });
  const evalOpt = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, os2);
    return r.result.value;
  };
  const note = await waitFor(async () => {
    const n = await evalOpt(`(() => { const el = document.querySelector('#quota-note'); return el && el.style.display !== 'none' ? document.querySelector('#quota-text').textContent : ''; })()`);
    return n || 0;
  }, 10000, '设置页的额度告警');
  console.log('设置页告警:', note);
  if (!note.includes('额度')) fail('设置页没显示额度告警');

  await evalOpt(`document.querySelector('#quota-clear').click()`);
  await sleep(800);
  const after = await evalOpt(`document.querySelector('#quota-note').style.display`);
  console.log('切回后告警:', after || '(隐藏)');
  if (after !== 'none') fail('点「立即切回免费」后告警没有消失');

  if (!process.exitCode) console.log('✔ 额度兜底全部通过');
} catch (e) {
  fail(e && e.message ? e.message : String(e));
} finally {
  try { chrome.kill(); } catch {}
  server.close();
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
