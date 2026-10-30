// 截图：真实译文页面 + 设置页（给 README 用）
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { resolveBrowser } from './browser-path.mjs';

const EXT_DIR = path.resolve(import.meta.dirname, '..');
const OUT = path.join(EXT_DIR, 'docs');
const BROWSER = resolveBrowser();
const PORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (u) => (await fetch(u)).json();

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Why Whales Matter</title>
<style>
  body{font:16px/1.75 Georgia,"Times New Roman",serif;color:#1f2933;background:#fff;max-width:760px;margin:48px auto;padding:0 24px}
  h1{font-size:32px;line-height:1.3;margin:0 0 8px}
  .meta{color:#8a97a8;font-size:13px;margin-bottom:28px;font-family:system-ui}
  h2{font-size:20px;margin:32px 0 8px}
  p{margin:0 0 16px}
  ul{padding-left:22px}
  li{margin-bottom:8px}
  blockquote{border-left:3px solid #dde3ea;margin:24px 0;padding-left:16px;color:#5b6b7c;font-style:italic}
</style></head>
<body>
  <h1>Why Whales Matter</h1>
  <div class="meta">By Ocean Desk · 6 min read</div>
  <p>Whales are the largest animals that have ever lived on Earth, and they play a vital role in keeping the ocean healthy. A single blue whale can weigh as much as thirty elephants.</p>
  <h2>A long journey every year</h2>
  <p>Every year, humpback whales travel thousands of miles between their feeding grounds and their breeding grounds. They navigate by listening to the shape of the seafloor and by following the sun.</p>
  <ul>
    <li>They help cycle nutrients through the water column.</li>
    <li>Their songs can travel for hundreds of miles.</li>
    <li>Their bodies store enormous amounts of carbon.</li>
  </ul>
  <blockquote>If you want to understand the ocean, start by listening to the whales.</blockquote>
  <h2>What we can do</h2>
  <p>Shipping lanes can be moved, fishing gear can be redesigned, and quiet zones can protect the places where whales raise their young. None of this is expensive, but all of it requires attention.</p>
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
fs.mkdirSync(OUT, { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-shot-'));
const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, `--load-extension=${EXT_DIR}`, '--no-first-run', '--disable-gpu',
  '--window-size=1100,1000', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });

try {
  await sleep(4500);
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js'));
  const extId = new URL(sw.url).host;
  const v = await getJson(`http://127.0.0.1:${PORT}/json/version`);
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const cdp = new CDP(ws);
  const { sessionId: swSession } = await cdp.send('Target.attachToTarget', { targetId: sw.id, flatten: true });
  await sleep(1200);
  await cdp.send('Runtime.evaluate', {
    expression: `chrome.storage.local.set({ settings: { provider: 'mymemory', target: 'zh-CN', mode: 'bilingual', auto: true, visibleOnly: false, selectionBubble: true } }).then(() => 1)`,
    awaitPromise: true
  }, swSession);

  const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${port}/` });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1180, deviceScaleFactor: 1, mobile: false }, sessionId);

  for (let i = 0; i < 40; i++) {
    const n = await cdp.send('Runtime.evaluate', { expression: `document.querySelectorAll('.ct-tr').length`, returnByValue: true }, sessionId);
    if ((n.result.value || 0) >= 8) break;
    await sleep(1000);
  }
  await sleep(600);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(OUT, 'screenshot-page.png'), Buffer.from(shot.data, 'base64'));
  console.log('saved docs/screenshot-page.png');

  // 设置页截图（用默认状态，别把 auto 打开的样子拍进去）
  await cdp.send('Runtime.evaluate', {
    expression: `chrome.storage.local.set({ settings: { provider: 'mymemory', target: 'zh-CN', mode: 'bilingual', auto: false, visibleOnly: true, selectionBubble: true } }).then(() => 1)`,
    awaitPromise: true
  }, swSession);
  await sleep(300);
  const { targetId: optTab } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options.html` });
  const { sessionId: os2 } = await cdp.send('Target.attachToTarget', { targetId: optTab, flatten: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 860, height: 1320, deviceScaleFactor: 1, mobile: false }, os2);
  await sleep(1500);
  const presetInfo = await cdp.send('Runtime.evaluate', {
    expression: `({ count: document.querySelectorAll('#preset option').length, value: document.querySelector('#preset').value })`,
    returnByValue: true
  }, os2);
  console.log('服务商下拉:', JSON.stringify(presetInfo.result.value));
  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' }, os2);
  fs.writeFileSync(path.join(OUT, 'screenshot-options.png'), Buffer.from(shot2.data, 'base64'));
  console.log('saved docs/screenshot-options.png');

  // 再截一张「选了大模型」的状态，展示服务商下拉
  await cdp.send('Runtime.evaluate', {
    expression: `document.querySelectorAll('.provider input')[2].click()`,
    returnByValue: true
  }, os2);
  await sleep(600);
  const presetOn = await cdp.send('Runtime.evaluate', {
    expression: `({ open: document.querySelector('#llm-box').className, value: document.querySelector('#preset').value })`,
    returnByValue: true
  }, os2);
  console.log('大模型面板:', JSON.stringify(presetOn.result.value));
  const shotLlm = await cdp.send('Page.captureScreenshot', { format: 'png' }, os2);
  fs.writeFileSync(path.join(OUT, 'screenshot-options-llm.png'), Buffer.from(shotLlm.data, 'base64'));
  console.log('saved docs/screenshot-options-llm.png');

  // 弹出面板截图（在标签页里打开，方便检查渲染和报错）
  const { targetId: popTab } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/src/popup.html` });
  const { sessionId: ps } = await cdp.send('Target.attachToTarget', { targetId: popTab, flatten: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 340, height: 400, deviceScaleFactor: 2, mobile: false }, ps);
  await sleep(1200);
  const measured = await cdp.send('Runtime.evaluate', {
    expression: `document.documentElement.scrollHeight`,
    returnByValue: true
  }, ps);
  console.log('弹窗内容高度:', measured.result.value, 'px（Chrome 弹窗上限约 600）');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 340, height: 720, deviceScaleFactor: 2, mobile: false }, ps);
  await sleep(600);
  const popState = await cdp.send('Runtime.evaluate', {
    expression: `({ status: document.querySelector('#status')?.textContent || '', langs: document.querySelectorAll('#target option').length, providers: document.querySelectorAll('#provider option').length, providerValue: document.querySelector('#provider')?.value, button: document.querySelector('#toggle')?.textContent })`,
    returnByValue: true
  }, ps);
  console.log('popup:', JSON.stringify(popState.result.value));
  const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' }, ps);
  fs.writeFileSync(path.join(OUT, 'screenshot-popup.png'), Buffer.from(shot3.data, 'base64'));
  console.log('saved docs/screenshot-popup.png');

  // 顺便验证「在弹窗里切接口」是真的写进设置
  const switched = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const sel = document.querySelector('#provider');
      sel.value = 'llm';
      sel.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 600));
      const s = await chrome.storage.local.get('settings');
      return { stored: s.settings.provider, status: document.querySelector('#status').textContent };
    })()`,
    awaitPromise: true,
    returnByValue: true
  }, ps);
  console.log('切换接口:', JSON.stringify(switched.result.value));
  if (switched.result.value.stored !== 'llm') console.error('✖ 弹窗里切接口没有写进设置');
} catch (e) {
  console.error('screenshot failed:', e.message);
  process.exitCode = 1;
} finally {
  child.kill();
  server.close();
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
