// 临时：验证 popup 跟随系统语言的显示
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { resolveBrowser } from './browser-path.mjs';

const EXT_DIR = path.resolve(import.meta.dirname, '..');
const BROWSER = resolveBrowser();
const PORT = 9357;
const ID = 'gjahhlakjemgcdnoeehjjjaddjajhbka';
const LANG = process.argv[2] || 'en-US';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (u) => (await fetch(u)).json();

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
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params, sessionId })); });
  }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-i18n-'));
const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, `--load-extension=${EXT_DIR}`, `--lang=${LANG}`, '--no-first-run', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore' });

try {
  await sleep(4500);
  const v = await getJson(`http://127.0.0.1:${PORT}/json/version`);
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${ID}/src/popup.html` });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await sleep(1800);
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const txt = (sel) => (document.querySelector(sel)?.textContent || '').trim();
      return {
        uiLang: chrome.i18n.getUILanguage(),
        title: txt('h1'),
        sub: txt('.sub'),
        toggle: txt('#toggle'),
        targetLabel: txt('.card .label'),
        mode: [...document.querySelectorAll('#mode button')].map((b) => b.textContent),
        providers: [...document.querySelectorAll('#provider option')].map((o) => o.textContent),
        placeholder: document.querySelector('#quick-input')?.placeholder,
        footer: txt('footer'),
        lang: document.documentElement.lang
      };
    })()`,
    returnByValue: true
  }, sessionId);
  console.log(JSON.stringify(r.result.value, null, 1));
} catch (e) {
  console.error('失败:', e.message);
} finally {
  child.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
