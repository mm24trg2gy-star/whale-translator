// 无头 Chrome 冒烟测试：真的把扩展装进去，翻一个本地页面，检查 DOM。
// 用法：node tests/smoke.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { resolveBrowser } from './browser-path.mjs';

const EXT_DIR = path.resolve(import.meta.dirname, '..');
// Google Chrome 137+ 已禁用 --load-extension，这里自动找 Edge / Chromium（可用 WT_BROWSER 覆盖）
const BROWSER = resolveBrowser();
const PORT_CDP = Number(process.env.WT_CDP_PORT || 9333);

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Whale test page</title></head>
<body>
  <h1 id="h1">The Whale and the Sea</h1>
  <p id="p1">Whales are magnificent creatures that live in the deep ocean.</p>
  <p id="p2">They communicate using complex songs that travel for miles across the water.</p>
  <ul id="list">
    <li>First item about krill and feeding.</li>
    <li>Second item about seasonal migration routes.</li>
  </ul>
  <p id="p3">Press <a href="#" id="link">this link</a> to learn more about <b>blue whales</b>.</p>
  <pre id="code"><code>const x = "do not translate me";</code></pre>
  <div id="p4">A short line.</div>
  <!-- 回归用：<a> 里套 <div>，每行要单独翻，不能被外层合并成一大段 -->
  <div id="rowlist">
    <a href="#"><div class="row">Kenya: architecture schematic design, 3000 square meters.</div></a>
    <a href="#"><div class="row">Nigeria: apartment interior design, 3702 square meters.</div></a>
    <a href="#"><div class="row">Egypt: villa renovation, 600 square meters.</div></a>
  </div>
</body></html>`;

// ---------------------------------------------------------------- 假的模型接口
const hits = [];
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname === '/test.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (pathname.endsWith('/chat/completions')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push(JSON.parse(body));
      const payload = JSON.parse(body);
      const texts = JSON.parse(payload.messages[1].content);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: texts.map((t) => '［译］' + t) }) } }] }));
    });
    return;
  }
  res.writeHead(404).end('nope');
});

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id) return;
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result);
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* 继续等 */ }
    if (Date.now() - t0 > timeout) throw new Error(`超时：${label}`);
    await sleep(250);
  }
}

function fail(msg) {
  console.error('✖ ' + msg);
  process.exitCode = 1;
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const pageUrl = `http://127.0.0.1:${port}/test.html`;
  console.log('· 测试页:', pageUrl);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ct-'));
  const chrome = spawn(
    BROWSER,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT_CDP}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1280,900',
      '--disable-features=Translate',
      'about:blank'
    ],
    { stdio: 'ignore', detached: false }
  );
  chrome.on('error', (e) => fail('Chrome 启动失败：' + e.message));

  const cleanup = async () => {
    try { chrome.kill(); } catch {}
    server.close();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  };

  try {
    const version = await waitFor(() => getJson(`http://127.0.0.1:${PORT_CDP}/json/version`), 15000, 'CDP 端口');
    console.log('· Chrome:', version.Browser);

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('WebSocket 连接失败'));
    });
    const cdp = new CDP(ws);

    // 等扩展的 service worker 起来
    const sw = await waitFor(async () => {
      const targets = await getJson(`http://127.0.0.1:${PORT_CDP}/json/list`);
      return targets.find((t) => t.type === 'service_worker' && String(t.url).endsWith('/src/background.js'));
    }, 20000, '扩展 service worker（扩展可能没加载）');
    console.log('· 扩展 SW:', sw.url);
    const extId = new URL(sw.url).host;

    const { sessionId: swSession } = await cdp.send('Target.attachToTarget', { targetId: sw.id, flatten: true });
    const evalInSw = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, swSession);
      if (r.exceptionDetails) throw new Error('SW 异常：' + JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    // service worker 刚起来时 chrome 绑定可能还没就绪，等一下
    await waitFor(() => evalInSw('!!(globalThis.chrome && chrome.storage && chrome.storage.local)'), 15000, 'service worker 里的 chrome.storage');

    const settings = {
      provider: 'llm',
      target: 'zh-CN',
      mode: 'bilingual',
      auto: true,
      visibleOnly: false,
      selectionBubble: true,
      llm: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-smoke', model: 'mock', jsonMode: true }
    };
    const setOk = await evalInSw(`chrome.storage.local.set({ settings: ${JSON.stringify(settings)} }).then(() => 'ok')`);
    if (setOk !== 'ok') throw new Error('写入设置失败：' + setOk);
    const readBack = await evalInSw(`chrome.storage.local.get('settings').then((r) => r.settings && r.settings.provider)`);
    if (readBack !== 'llm') throw new Error('设置没写进去：' + readBack);

    const { targetId } = await cdp.send('Target.createTarget', { url: pageUrl });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    const evalInPage = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error('页面脚本异常：' + JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };

    await waitFor(() => evalInPage(`document.readyState === 'complete'`), 15000, '页面加载');

    const count = await waitFor(async () => {
      const n = await evalInPage(`document.querySelectorAll('.ct-tr').length`);
      return n >= 5 ? n : 0;
    }, 30000, '页面出现译文（接口可能没通）');
    console.log('· 译文块数量:', count);

    const state = await evalInPage(`(() => {
      const q = (s) => document.querySelector(s);
      const tr = (s) => { const e = q(s); return e ? (e.querySelector('.ct-tr')?.textContent || '') : ''; };
      return {
        h1: tr('#h1'),
        p1: tr('#p1'),
        p2: tr('#p2'),
        li: Array.from(document.querySelectorAll('#list li')).map(li => li.querySelector('.ct-tr')?.textContent || ''),
        p3: tr('#p3'),
        p3inline: !!q('#p3')?.querySelector('.ct-tr')?.classList.contains('ct-tr-inline'),
        p3Count: q('#p3')?.querySelectorAll('.ct-tr').length || 0,
        code: !!q('#code')?.querySelector('.ct-tr'),
        codeDone: q('#code')?.hasAttribute('data-ct-done'),
        p1StillEnglish: (q('#p1')?.textContent || '').includes('Whales are magnificent'),
        rowTrs: Array.from(document.querySelectorAll('#rowlist .ct-tr')).map((n) => n.textContent.length),
        rowCount: q('#rowlist')?.querySelectorAll('a > .ct-tr').length || 0,
        done: document.querySelectorAll('[data-ct-done]').length,
        hud: !!document.getElementById('whale-translate-host')?.shadowRoot?.querySelector('.hud')
      };
    })()`);
    console.log('· 页面状态:', JSON.stringify(state, null, 2));
    console.log('· 接口调用次数:', hits.length);

    const checks = [
      [state.h1.startsWith('［译］'), '标题被翻译'],
      [state.p1.startsWith('［译］'), '正文段落被翻译'],
      [state.p2.includes('songs'), '第二段被翻译'],
      [state.li.length === 2 && state.li.every((t) => t.startsWith('［译］')), '列表项逐条翻译'],
      [state.p3.includes('Press') && state.p3.includes('blue whales'), '整段（含行内标签）作为一个整体被翻译'],
      [state.p3Count === 1, '一句话没被拆成多段重复翻译'],
      [state.code === false && state.codeDone === false, '代码块没被翻'],
      [state.rowTrs.length === 3 && state.rowTrs.every((n) => n < 200), '<a> 套 <div> 的列表按行翻，没被合并成一大段'],
      [state.p1StillEnglish === true, '双语模式保留原文'],
      [state.hud === true, '页面上有进度条 UI']
    ];
    let ok = true;
    for (const [pass, label] of checks) {
      if (!pass) { fail(label); ok = false; }
    }
    if (ok) console.log('✔ 冒烟测试全部通过');

    // 顺带验证「纯译文模式」能隐藏原文
    await evalInSw(`chrome.storage.local.set({ settings: { ...${JSON.stringify(settings)}, mode: 'only' } }).then(() => 1)`);
    const { targetId: onlyTab } = await cdp.send('Target.createTarget', { url: `${pageUrl}?only=1` });
    await cdp.send('Target.activateTarget', { targetId: onlyTab });
    const { sessionId: s2 } = await cdp.send('Target.attachToTarget', { targetId: onlyTab, flatten: true });
    await cdp.send('Page.bringToFront', {}, s2).catch(() => {});
    const evalOnly = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, s2);
      return r.result.value;
    };
    let onlyCount = 0;
    try {
      onlyCount = await waitFor(async () => {
        const n = await evalOnly(`document.querySelectorAll('.ct-tr').length`);
        return n > 0 ? n : 0;
      }, 30000, '纯译文模式的译文');
    } catch (e) {
      const diag = await evalOnly(`({
        loaded: !!window.__whaleTranslateLoaded,
        host: !!document.getElementById('whale-translate-host'),
        trs: document.querySelectorAll('.ct-tr').length,
        done: document.querySelectorAll('[data-ct-done]').length,
        ready: document.readyState,
        rects: document.querySelector('#p1') ? document.querySelector('#p1').getClientRects().length : -1,
        text: document.body ? document.body.innerText.slice(0, 60) : 'no body'
      })`);
      console.log('· 诊断:', JSON.stringify(diag));
      console.log('· SW 里的设置:', await evalInSw(`chrome.storage.local.get('settings').then((r) => JSON.stringify(r.settings))`));
      throw e;
    }
    console.log('· 纯译文译文数量:', onlyCount);
    const v = await evalOnly(`(() => {
      const p = document.querySelector('#p1');
      const orig = p && p.querySelector('.ct-orig');
      return {
        hasOrig: !!orig,
        origHidden: orig ? getComputedStyle(orig).display === 'none' : false,
        tr: (p && p.querySelector('.ct-tr') && p.querySelector('.ct-tr').textContent) || ''
      };
    })()`);
    console.log('· 纯译文模式:', JSON.stringify(v));
    if (!v.hasOrig || !v.origHidden || !v.tr.startsWith('［译］')) fail('纯译文模式没有正确隐藏原文');

    // 还原：走一遍 popup / 快捷键用的同一条消息
    const toggleRes = await evalInSw(`chrome.tabs.query({}).then(async (tabs) => {
      const t = tabs.find((tab) => String(tab.url || tab.pendingUrl || '').includes('only=1'));
      if (!t) return 'no tab';
      await chrome.tabs.sendMessage(t.id, { type: 'ui:toggle' });
      return 'ok';
    })`);
    await sleep(800);
    const restored = await evalOnly(`({
      trs: document.querySelectorAll('.ct-tr').length,
      origs: document.querySelectorAll('.ct-orig').length,
      p1: document.querySelector('#p1') ? document.querySelector('#p1').textContent : ''
    })`);
    console.log('· 还原后:', JSON.stringify(restored), toggleRes);
    if (restored.trs !== 0 || restored.origs !== 0 || !restored.p1.includes('Whales are magnificent') || restored.p1.includes('［译］')) {
      fail('还原没有把原文恢复干净');
    }

    // 划词：选中 → 出现「译」泡泡 → 点开卡片
    await cdp.send('Target.activateTarget', { targetId });
    const sel = await evalInPage(`(() => {
      const p = document.querySelector('#p2');
      const range = document.createRange();
      range.selectNodeContents(p);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return s.toString().slice(0, 20);
    })()`);
    await sleep(400);
    const bubble = await evalInPage(`(() => {
      const host = document.getElementById('whale-translate-host');
      const b = host && host.shadowRoot && host.shadowRoot.querySelector('.bubble');
      return b ? b.style.display : 'no-bubble';
    })()`);
    if (bubble !== 'block') fail('划词后没弹出翻译泡泡（' + bubble + '）');
    await evalInPage(`document.getElementById('whale-translate-host').shadowRoot.querySelector('.bubble').click()`);
    await sleep(1500);
    const card = await evalInPage(`(() => {
      const s = document.getElementById('whale-translate-host').shadowRoot;
      return { shown: s.querySelector('.card').style.display, text: s.querySelector('.card-body').textContent };
    })()`);
    console.log('· 划词结果:', JSON.stringify({ sel, bubble, card }));
    if (card.shown !== 'block' || !String(card.text).startsWith('［译］')) fail('划词翻译卡片没有正确显示译文');
    if (String(card.text).split('［译］').length - 1 !== 1) fail('选区把已插入的译文又翻了一遍（应剔除 .ct-tr）');

    // 卡片自动收起：页面一滚就消失
    await evalInPage(`window.dispatchEvent(new Event('scroll'))`);
    await sleep(300);
    const afterScroll = await evalInPage(`document.getElementById('whale-translate-host').shadowRoot.querySelector('.card').style.display`);
    if (afterScroll !== 'none') fail('页面滚动后卡片没有自动收起（' + afterScroll + '）');

    // 卡片自动收起：点页面别处就消失
    await evalInPage(`(() => {
      const p = document.querySelector('#p2');
      const range = document.createRange();
      range.selectNodeContents(p);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    })()`);
    await sleep(400);
    await evalInPage(`document.getElementById('whale-translate-host').shadowRoot.querySelector('.bubble').click()`);
    await sleep(1200);
    const reopened = await evalInPage(`document.getElementById('whale-translate-host').shadowRoot.querySelector('.card').style.display`);
    await evalInPage(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    await sleep(200);
    const afterClick = await evalInPage(`document.getElementById('whale-translate-host').shadowRoot.querySelector('.card').style.display`);
    if (reopened !== 'block') fail('重新划词后卡片没打开（' + reopened + '）');
    if (afterClick !== 'none') fail('点页面别处后卡片没有自动收起（' + afterClick + '）');

    // 点卡片内部不该关掉
    await evalInPage(`document.getElementById('whale-translate-host').shadowRoot.querySelector('.bubble').click()`);
    await sleep(1000);
    await evalInPage(`document.getElementById('whale-translate-host').shadowRoot.querySelector('.card-body').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }))`);
    await sleep(200);
    const afterInside = await evalInPage(`document.getElementById('whale-translate-host').shadowRoot.querySelector('.card').style.display`);
    if (afterInside !== 'block') fail('点卡片内部把卡片关掉了（' + afterInside + '）');
    console.log('· 自动收起：滚动 ✓ 点外面 ✓ 点里面不关 ✓');

    // 快捷键兜底：页面里直接按 Alt+T 应该能还原
    const pressAltT = async () => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 1, key: 't', code: 'KeyT', windowsVirtualKeyCode: 84 }, sessionId);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: 't', code: 'KeyT', windowsVirtualKeyCode: 84 }, sessionId);
    };
    await pressAltT();
    await sleep(1200);
    const afterHotkey1 = await evalInPage(`document.querySelectorAll('.ct-tr').length`);
    await sleep(600);
    await pressAltT();
    await sleep(4000);
    const afterHotkey2 = await evalInPage(`document.querySelectorAll('.ct-tr').length`);
    console.log('· Alt+T：还原后译文数', afterHotkey1, '→ 再按一次', afterHotkey2);
    if (afterHotkey1 !== 0) fail('Alt+T 没有还原页面（剩 ' + afterHotkey1 + ' 段）');
    if (afterHotkey2 <= 0) fail('Alt+T 没有重新开始翻译');

    // 备用键 Alt+Q 也要能用
    await sleep(600);
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 1, key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81 }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81 }, sessionId);
    await sleep(1200);
    const afterHotkeyQ = await evalInPage(`document.querySelectorAll('.ct-tr').length`);
    console.log('· Alt+Q：', afterHotkeyQ);
    if (afterHotkeyQ !== 0) fail('Alt+Q 没有还原页面（剩 ' + afterHotkeyQ + ' 段）');

    if (extId) console.log('· 扩展 ID:', extId);
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  } finally {
    await cleanup();
  }
}

main();
