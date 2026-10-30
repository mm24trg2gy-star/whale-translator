// 备份/迁移的端到端验证：导出下载的 JSON 能被自己重新导入
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { resolveBrowser } from './browser-path.mjs';

const EXT_DIR = path.resolve(import.meta.dirname, '..');
const BROWSER = resolveBrowser();
const PORT = 9345;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (u) => (await fetch(u)).json();
const fail = (m) => { console.error('✖ ' + m); process.exitCode = 1; };

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

const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-dl-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-io-'));
const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, `--load-extension=${EXT_DIR}`, '--no-first-run', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore' });

try {
  await sleep(4500);
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js'));
  const extId = new URL(sw.url).host;
  const v = await getJson(`http://127.0.0.1:${PORT}/json/version`);
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const cdp = new CDP(ws);

  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

  // 先写一份已知设置（页面初始化时读它）
  const { sessionId: swSession } = await cdp.send('Target.attachToTarget', { targetId: sw.id, flatten: true });
  await cdp.send('Runtime.evaluate', {
    expression: `chrome.storage.local.set({ settings: { provider: 'llm', target: 'ja', mode: 'bilingual', auto: false, visibleOnly: true, selectionBubble: true, autoFallback: true, llm: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-e2e-export', model: 'deepseek-chat', jsonMode: true } } }).then(() => 1)`,
    awaitPromise: true
  }, swSession);

  const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options.html` });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const evalIn = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result.value;
  };
  await sleep(1200);

  // ---- 导出 ----
  await evalIn(`document.querySelector('#export-settings').click()`);
  let file = null;
  for (let i = 0; i < 20; i++) {
    const files = fs.readdirSync(dlDir).filter((f) => f.endsWith('.json'));
    if (files.length) { file = path.join(dlDir, files[0]); break; }
    await sleep(300);
  }
  if (!file) throw new Error('没等到导出的 JSON 文件');
  const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log('导出文件:', path.basename(file));
  const exportedKey = exported.settings.llm.keys && exported.settings.llm.keys['api.deepseek.com'];
  console.log('导出内容:', exported.app, 'provider=' + exported.settings.provider, 'key=' + exportedKey);
  if (exported.settings.provider !== 'llm' || exportedKey !== 'sk-e2e-export') fail('导出的设置不对');

  // ---- 清空，再导入 ----
  await cdp.send('Runtime.evaluate', { expression: `chrome.storage.local.set({ settings: {} }).then(() => 1)`, awaitPromise: true }, swSession);
  const inputObj = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('#import-file')` }, sessionId);
  await cdp.send('DOM.setFileInputFiles', { files: [file], objectId: inputObj.result.objectId }, sessionId);
  await evalIn(`document.querySelector('#import-file').dispatchEvent(new Event('change'))`);
  await sleep(900);

  const after = await evalIn(`chrome.storage.local.get('settings').then((r) => r.settings)`);
  const out = await evalIn(`document.querySelector('#io-out').textContent`);
  const afterKey = after.llm.keys && after.llm.keys['api.deepseek.com'];
  console.log('导入后 provider:', after.provider, '| key:', afterKey, '| 提示:', out);
  if (after.provider !== 'llm' || afterKey !== 'sk-e2e-export' || after.target !== 'ja') fail('导入没有还原设置');
  if (!String(out).includes('导入成功')) fail('导入成功后没有提示');

  // 坏文件要报错而不是崩
  const badFile = path.join(dlDir, 'bad.json');
  fs.writeFileSync(badFile, '{ this is not json');
  const inputObj2 = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('#import-file')` }, sessionId);
  await cdp.send('DOM.setFileInputFiles', { files: [badFile], objectId: inputObj2.result.objectId }, sessionId);
  await evalIn(`document.querySelector('#import-file').dispatchEvent(new Event('change'))`);
  await sleep(600);
  const badOut = await evalIn(`document.querySelector('#io-out').textContent`);
  console.log('坏文件的提示:', badOut);
  if (!String(badOut).includes('导入失败')) fail('坏文件没有给出错误提示');

  if (!process.exitCode) console.log('✔ 导出 / 导入全部通过');
} catch (e) {
  fail(e && e.message ? e.message : String(e));
} finally {
  child.kill();
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch {}
}
