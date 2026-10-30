// content.js —— 页面侧：找段落、批量翻译、双语/纯译文渲染、划词弹窗。
// 注：内容脚本是普通脚本，不能 import，所以默认值在这里复制了一份小的。
(() => {
  if (window.__whaleTranslateLoaded) return;
  window.__whaleTranslateLoaded = true;

  const DEFAULTS = {
    provider: 'mymemory',
    target: 'zh-CN',
    mode: 'bilingual',
    auto: false,
    visibleOnly: true,
    selectionBubble: true
  };

  // 这些标签整棵子树跳过
  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed',
    'textarea', 'input', 'select', 'option', 'pre', 'code', 'kbd', 'samp', 'var', 'math',
    '[translate="no"]', '.notranslate', '.ct-tr', '.ct-orig', '[contenteditable="true"]', '[role="textbox"]'
  ].join(',');

  const MIN_LEN = 2;
  const MAX_BATCH_CHARS = 2400;
  const MAX_BATCH_ITEMS = 24;

  let settings = { ...DEFAULTS };
  let active = false;
  let queue = [];
  const queued = new Set();
  const texts = new WeakMap();
  let pumping = false;
  let pumpTimer = 0;
  let io = null;
  let mo = null;
  let moTimer = 0;
  let fallbackNoticed = false;
  let warnedBatch = false;
  let runToken = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stats = { total: 0, done: 0, failed: 0 };

  // ------------------------------------------------------------------ 文本判断

  const CJK_RE = /[\u4e00-\u9fff]/g;
  const LATIN_RE = /[A-Za-z]/g;
  const KANA_RE = /[\u3040-\u30ff\uac00-\ud7af]/g;

  function looksTranslated(text, target) {
    const s = String(text || '').trim();
    if (!s) return true;
    if (!/[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(s)) return true;
    const cjk = (s.match(CJK_RE) || []).length;
    const latin = (s.match(LATIN_RE) || []).length;
    const kana = (s.match(KANA_RE) || []).length;
    if (target === 'zh-CN' || target === 'zh-TW') {
      if (kana > cjk * 0.5) return false;
      return cjk >= 2 && cjk * 2 >= latin;
    }
    if (target === 'en') return latin >= 4 && latin >= cjk * 3;
    return false;
  }

  function normalize(text) {
    return String(text || '')
      .replace(/[ \t\u00a0\u200b]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ------------------------------------------------------------------ 找段落

  function isVisible(el) {
    if (!el.isConnected) return false;
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    return true;
  }

  /**
   * 真正的「行内」只有 inline / contents。
   * inline-block / inline-flex 是卡片、列表项这类小容器，里面的文字该它自己管，
   * 不然整张列表会被当成一整块，翻出来一大坨。
   */
  function isInlineDisplay(display) {
    return display === 'inline' || display === 'contents';
  }

  /** 里面有没有带文字的块级子元素（<a> 包一排 div 这种要当块看） */
  function hasBlockChild(el) {
    for (const c of el.children) {
      if (c.classList.contains('ct-tr') || c.classList.contains('ct-orig')) continue;
      const d = getComputedStyle(c).display;
      if (!isInlineDisplay(d) && c.textContent.trim().length >= MIN_LEN) return true;
    }
    return false;
  }

  /** 元素是不是「最内层的文字块」：没有带文字的块级子元素 */
  function isLeafTextBlock(el) {
    if (!el.firstChild) return false;
    if (el.childElementCount === 0) return el.textContent.trim().length >= MIN_LEN;

    let sawInlineText = false;
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        if (node.nodeValue.trim()) sawInlineText = true;
        continue;
      }
      if (node.nodeType !== 1) continue;
      const child = node;
      if (child.classList.contains('ct-tr') || child.classList.contains('ct-orig')) continue;
      const display = getComputedStyle(child).display;
      // display:inline 但里面装着块级内容的（常见于 <a> 包整行），按块处理
      const inlineish = isInlineDisplay(display) && !hasBlockChild(child);
      if (inlineish) {
        if (child.textContent.trim()) sawInlineText = true;
      } else if (child.textContent.trim().length >= MIN_LEN) {
        return false; // 有块级（或 inline-block）子元素且自带文字 → 交给子元素翻
      }
    }
    return sawInlineText;
  }

  function extractText(el) {
    const raw = el.innerText != null ? el.innerText : el.textContent;
    return normalize(raw);
  }

  function collectBlocks(root) {
    const base = root && root.nodeType === 1 ? root : document.body;
    if (!base) return [];
    const list = [];
    if (base.matches && base.matches('body, main, article, section, div')) {
      // 根节点自身也可能是文字块
      if (!base.closest(SKIP_SELECTOR) && !base.hasAttribute('data-ct-done') && isLeafTextBlock(base)) {
        const t = extractText(base);
        if (t.length >= MIN_LEN && !looksTranslated(t, settings.target)) list.push({ el: base, text: t });
      }
    }
    const all = base.querySelectorAll('*');
    for (const el of all) {
      if (el.hasAttribute('data-ct-done')) continue;
      if (el.closest(SKIP_SELECTOR)) continue;
      // 纯行内元素（a/span/b…）不单独翻；但 <a> 包着一整行块级内容的要放过
      if (isInlineDisplay(getComputedStyle(el).display) && !hasBlockChild(el)) continue;
      if (!isLeafTextBlock(el)) continue;
      if (!isVisible(el)) continue;
      const text = extractText(el);
      if (text.length < MIN_LEN) continue;
      if (text.length > 12000) continue; // 诡异节点，别把接口打爆
      if (looksTranslated(text, settings.target)) continue;
      list.push({ el, text });
    }
    return list;
  }

  // ------------------------------------------------------------------ 渲染译文

  function isInlineBox(el) {
    const d = getComputedStyle(el).display;
    return d.startsWith('inline');
  }

  function applyTranslation(el, text) {
    if (!el.isConnected || el.hasAttribute('data-ct-done')) return;
    const inline = isInlineBox(el);
    const tr = document.createElement('span');
    tr.className = 'ct-tr' + (inline ? ' ct-tr-inline' : '');
    tr.setAttribute('data-ct', 'tr');
    tr.lang = settings.target;
    tr.textContent = text;

    if (settings.mode === 'only') {
      const orig = document.createElement('span');
      orig.className = 'ct-orig';
      while (el.firstChild) orig.appendChild(el.firstChild);
      el.appendChild(orig);
      el.classList.add('ct-only-mode');
    }
    el.appendChild(tr);
    el.setAttribute('data-ct-done', '1');
    stats.done++;
  }

  function restorePage() {
    document.querySelectorAll('[data-ct-done]').forEach((el) => {
      for (const orig of el.querySelectorAll(':scope > .ct-orig')) {
        while (orig.firstChild) el.insertBefore(orig.firstChild, orig);
        orig.remove();
      }
      for (const tr of el.querySelectorAll(':scope > .ct-tr')) tr.remove();
      el.classList.remove('ct-only-mode');
      el.removeAttribute('data-ct-done');
    });
    document.querySelectorAll('.ct-tr').forEach((n) => n.remove());
    stats.total = 0;
    stats.done = 0;
    stats.failed = 0;
  }

  // ------------------------------------------------------------------ 队列

  function enqueue(el, text) {
    if (!active) return;
    if (el.hasAttribute('data-ct-done') || queued.has(el)) return;
    queued.add(el);
    queue.push({ el, text });
    stats.total++;
    renderHud();
    schedulePump();
  }

  function schedulePump() {
    if (pumpTimer) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = 0;
      pump();
    }, 50);
  }

  async function pump() {
    if (pumping || !active) return;
    pumping = true;
    try {
      while (active && queue.length) {
        const batch = takeBatch();
        if (!batch.length) continue;
        const token = runToken;
        let r = await translateBatch(batch, token);
        if (!r.ok) {
          if (r.fatal) {
            showErrorToast(r.msg);
            stopTranslation();
            break;
          }
          // 偶发失败（限流、格式不对）：等一会重试一次，别把后面整页都卡死
          await sleep(1200);
          if (!active || token !== runToken) break;
          r = await translateBatch(batch, token);
          if (!r.ok) {
            stats.failed += batch.length;
            stats.total = Math.max(stats.total, stats.done + stats.failed);
            if (!warnedBatch) {
              warnedBatch = true;
              toast(`有 ${batch.length} 段没翻成（${r.msg}），先跳过继续翻剩下的`, 6000);
            }
          }
        }
        renderHud();
      }
    } finally {
      pumping = false;
      // 有些段落可能在翻的过程中被页面移除/替换，永远轮不到；
      // 这里把总数对齐成“已翻 + 失败”，免得进度条卡在 105/129 下不去
      if (!queue.length) stats.total = stats.done + stats.failed;
      renderHud();
    }
  }

  function showErrorToast(msg) {
    if (!msg) return; // 已经用更具体的提示（比如“刷新页面”）说过了
    if (/API Key/i.test(msg)) {
      toast(msg, 9000, {
        label: '去设置',
        onClick: () => chrome.runtime.sendMessage({ type: 'open-options' })
      });
    } else {
      toast(msg, 6000);
    }
  }

  function takeBatch() {
    const items = [];
    let chars = 0;
    while (queue.length && items.length < MAX_BATCH_ITEMS) {
      const item = queue.shift();
      queued.delete(item.el);
      if (!item.el.isConnected || item.el.hasAttribute('data-ct-done')) continue;
      if (items.length && chars + item.text.length > MAX_BATCH_CHARS) {
        queued.add(item.el);
        queue.unshift(item);
        break;
      }
      items.push(item);
      chars += item.text.length;
    }
    return items;
  }

  /** 扩展被重载/更新后，老页面里的脚本会失联（chrome.runtime.id 消失） */
  function extensionGone() {
    try {
      return !(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch {
      return true;
    }
  }

  function promptReload() {
    toast('扩展刚更新过，这个页面里的脚本已经失效，刷新一下就好', 12000, {
      label: '刷新页面',
      onClick: () => location.reload()
    });
  }

  async function translateBatch(items, token) {
    const unique = [...new Set(items.map((i) => i.text))];
    if (extensionGone()) {
      promptReload();
      return { ok: false, fatal: true, msg: '' };
    }
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'translate', texts: unique });
    } catch (e) {
      if (extensionGone()) {
        promptReload();
        return { ok: false, fatal: true, msg: '' };
      }
      return { ok: false, fatal: true, msg: '扩展后台没响应，刷新一下页面再试' };
    }
    // 等结果的这段时间里用户点了「还原」或重新开始，这批结果就别往页面上贴了
    if (token !== undefined && token !== runToken) return { ok: true, dropped: true };
    if (!res || !res.ok) {
      const msg = (res && res.error) || '翻译失败';
      const fatal = /API Key|网络连不上|后台没响应/i.test(msg);
      return { ok: false, fatal, msg };
    }
    if (res.fallback && !fallbackNoticed) {
      fallbackNoticed = true;
      toast('免费额度用完了，已自动切到大模型继续翻（设置里可以关掉）', 6000);
    }
    const map = new Map();
    unique.forEach((t, i) => map.set(t, res.results[i] || ''));
    for (const item of items) {
      const text = map.get(item.text);
      if (!text) {
        stats.failed++;
        continue;
      }
      applyTranslation(item.el, text);
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------ 自动化

  function observe(el, text) {
    texts.set(el, text);
    io.observe(el);
  }

  function startMutationObserver() {
    if (mo) return;
    mo = new MutationObserver(() => {
      if (!active) return;
      clearTimeout(moTimer);
      moTimer = setTimeout(scanNew, 700);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function scanNew() {
    if (!active) return;
    for (const { el, text } of collectBlocks(document.body)) {
      if (io) observe(el, text);
      else enqueue(el, text);
    }
  }

  function startTranslation() {
    if (active) return;
    runToken++;
    active = true;
    stats.total = 0;
    stats.done = 0;
    stats.failed = 0;
    const blocks = collectBlocks(document.body);
    if (settings.visibleOnly) {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            io.unobserve(e.target);
            const t = texts.get(e.target);
            if (t) enqueue(e.target, t);
          }
        },
        { rootMargin: '600px 0px' }
      );
      for (const b of blocks) observe(b.el, b.text);
    } else {
      for (const b of blocks) enqueue(b.el, b.text);
    }
    startMutationObserver();
    document.documentElement.classList.add('ct-active');
    showHud();
    renderHud();
  }

  function stopTranslation() {
    active = false;
    runToken++;
    queue = [];
    queued.clear();
    if (io) {
      io.disconnect();
      io = null;
    }
    if (mo) {
      mo.disconnect();
      mo = null;
    }
    clearTimeout(pumpTimer);
    pumpTimer = 0;
    clearTimeout(moTimer);
    document.documentElement.classList.remove('ct-active');
    hideHud();
  }

  // ------------------------------------------------------------------ 界面（Shadow DOM 隔离）

  let shadow = null;
  let hudEl = null;
  let toastEl = null;
  let bubbleEl = null;
  let cardEl = null;
  let cardBody = null;
  let hideTimer = 0;

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .hud, .toast, .bubble, .card {
      font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #1f2933;
    }
    .hud {
      position: fixed; right: 16px; bottom: 16px; display: flex; align-items: center; gap: 8px;
      padding: 7px 10px; border-radius: 999px; background: rgba(255,255,255,.96);
      box-shadow: 0 4px 18px rgba(15,23,42,.18); border: 1px solid rgba(15,23,42,.08);
      z-index: 2147483647;
    }
    .hud .dot { width: 8px; height: 8px; border-radius: 50%; background: #2f7cf6; animation: ct-pulse 1.1s infinite; }
    .hud .txt { font-variant-numeric: tabular-nums; color: #475569; }
    .hud button {
      border: 0; background: transparent; cursor: pointer; color: #94a3b8; font-size: 15px;
      line-height: 1; padding: 0 2px;
    }
    .hud button:hover { color: #475569; }
    @keyframes ct-pulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
    .toast {
      position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
      max-width: min(520px, calc(100vw - 48px)); padding: 12px 18px; border-radius: 12px;
      background: rgba(24,32,44,.94); color: #f8fafc; box-shadow: 0 18px 44px rgba(2,6,23,.4);
      align-items: center; gap: 10px; z-index: 2147483647;
      font-size: 14px;
    }
    .toast-action {
      flex: 0 0 auto; border: 0; cursor: pointer; font: inherit; font-size: 12px;
      padding: 3px 10px; border-radius: 7px; color: #fff; background: rgba(255,255,255,.18);
    }
    .toast-action:hover { background: rgba(255,255,255,.3); }
    .bubble {
      position: fixed; width: 34px; height: 34px; border-radius: 50%; border: 0; cursor: pointer;
      background: #2f7cf6; color: #fff; font-size: 15px; font-weight: 600;
      box-shadow: 0 6px 18px rgba(47,124,246,.45); z-index: 2147483647;
    }
    .bubble:hover { background: #2566d8; }
    .card {
      position: fixed; width: min(360px, calc(100vw - 32px)); border-radius: 14px; overflow: hidden;
      background: #fff; box-shadow: 0 18px 50px rgba(2,6,23,.28); border: 1px solid rgba(15,23,42,.08);
      z-index: 2147483647;
    }
    .card-head {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      background: #f5f7fa; border-bottom: 1px solid rgba(15,23,42,.06); color: #64748b; font-size: 12px;
    }
    .card-head .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-head button {
      border: 0; background: transparent; color: #64748b; cursor: pointer; font-size: 12px;
      padding: 2px 6px; border-radius: 6px;
    }
    .card-head button:hover { background: rgba(15,23,42,.06); color: #1f2933; }
    .card-body { padding: 12px; max-height: 44vh; overflow: auto; font-size: 14px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
    .card-src { padding: 8px 12px 10px; color: #94a3b8; font-size: 12px; border-top: 1px dashed rgba(15,23,42,.08); max-height: 22vh; overflow: auto; white-space: pre-wrap; word-break: break-word; }
    @media (prefers-color-scheme: dark) {
      .hud { background: rgba(30,41,59,.96); border-color: rgba(148,163,184,.25); color: #e2e8f0; }
      .hud .txt { color: #94a3b8; }
      .card { background: #1e293b; border-color: rgba(148,163,184,.18); color: #e2e8f0; }
      .card-head { background: #172033; border-color: rgba(148,163,184,.14); color: #94a3b8; }
      .card-src { color: #94a3b8; border-color: rgba(148,163,184,.16); }
    }
  `;

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'whale-translate-host';
    host.style.cssText = 'all:initial; position:fixed; inset:0; width:0; height:0; z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${UI_CSS}</style>`;

    hudEl = document.createElement('div');
    hudEl.className = 'hud';
    hudEl.innerHTML = '<span class="dot"></span><span class="txt"></span><button title="停止">×</button>';
    hudEl.style.display = 'none';
    hudEl.querySelector('button').addEventListener('click', () => {
      stopTranslation();
      toast('已停止，译文保留；再按 Alt+T 可还原');
    });

    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.style.display = 'none';

    bubbleEl = document.createElement('button');
    bubbleEl.className = 'bubble';
    bubbleEl.type = 'button';
    bubbleEl.title = '翻译选中文字';
    bubbleEl.textContent = '译';
    bubbleEl.style.display = 'none';
    bubbleEl.addEventListener('mousedown', (e) => e.preventDefault());
    bubbleEl.addEventListener('click', onBubbleClick);

    cardEl = document.createElement('div');
    cardEl.className = 'card';
    cardEl.style.display = 'none';
    cardEl.innerHTML =
      '<div class="card-head"><span class="grow">译文</span>' +
      '<button class="copy" type="button">复制</button>' +
      '<button class="close" type="button">×</button></div>' +
      '<div class="card-body"></div>' +
      '<div class="card-src"></div>';
    cardBody = cardEl.querySelector('.card-body');
    cardEl.querySelector('.close').addEventListener('click', hideCard);
    cardEl.querySelector('.copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(cardBody.textContent || '');
        toast('已复制');
      } catch {
        toast('复制失败，手动选一下吧');
      }
    });

    shadow.append(hudEl, toastEl, bubbleEl, cardEl);
    (document.documentElement || document.body).appendChild(host);
  }

  function showHud() {
    if (hudEl) hudEl.style.display = 'flex';
  }
  function hideHud() {
    if (hudEl) hudEl.style.display = 'none';
  }
  function renderHud() {
    if (!hudEl || hudEl.style.display === 'none') return;
    const txt = hudEl.querySelector('.txt');
    txt.textContent = stats.total ? `译 ${stats.done}/${stats.total}` : '译 0/0';
    // 翻完了就自己收起来，别一直挂在那儿
    clearTimeout(renderHud.timer);
    if (stats.total > 0 && stats.done + stats.failed >= stats.total && !queue.length && !pumping) {
      renderHud.timer = setTimeout(() => {
        if (!queue.length) hideHud();
      }, 2400);
    }
  }
  function toast(msg, ms = 3200, action) {
    if (!toastEl) return;
    toastEl.textContent = '';
    const text = document.createElement('span');
    text.textContent = msg;
    toastEl.appendChild(text);
    if (action && action.label) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        try { action.onClick(); } catch { /* 忽略 */ }
        toastEl.style.display = 'none';
      });
      toastEl.appendChild(btn);
    }
    toastEl.style.display = 'flex';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      toastEl.style.display = 'none';
    }, ms);
  }

  function hideBubble() {
    if (bubbleEl) bubbleEl.style.display = 'none';
  }
  function hideCard() {
    if (cardEl) cardEl.style.display = 'none';
  }

  // ------------------------------------------------------------------ 划词

  let selectionText = '';

  /** 选区里如果混进了自己插入的译文，先剔掉，别把译文再翻一遍 */
  function cleanSelectionText(sel) {
    try {
      const range = sel.getRangeAt(0);
      const frag = range.cloneContents();
      frag.querySelectorAll('.ct-tr, .ct-orig').forEach((n) => n.remove());
      const holder = document.createElement('div');
      holder.appendChild(frag);
      return normalize(holder.textContent || '');
    } catch {
      return normalize(sel.toString());
    }
  }

  function onMouseUp(e) {
    if (!settings.selectionBubble) return;
    if (e.target && e.target.id === 'whale-translate-host') return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        hideBubble();
        return;
      }
      const text = cleanSelectionText(sel);
      if (!text || text.length > 3000 || !/[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(text)) {
        hideBubble();
        return;
      }
      if (looksTranslated(text, settings.target)) {
        hideBubble();
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) {
        hideBubble();
        return;
      }
      selectionText = text;
      const size = 34;
      const x = Math.min(Math.max(8, rect.left + rect.width / 2 - size / 2), window.innerWidth - size - 8);
      const y = Math.min(Math.max(8, rect.top - size - 8), window.innerHeight - size - 8);
      bubbleEl.style.left = `${x}px`;
      bubbleEl.style.top = `${y}px`;
      bubbleEl.style.display = 'block';
      cardEl.style.display = 'none';
    }, 10);
  }

  async function translateSelection(text) {
    if (!text) return;
    hideBubble();
    positionCard();
    cardBody.textContent = '翻译中…';
    cardEl.querySelector('.card-src').textContent = text.length > 400 ? text.slice(0, 400) + '…' : text;
    cardEl.style.display = 'block';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'translate', texts: [text] });
      if (!res || !res.ok) {
        cardBody.textContent = (res && res.error) || '翻译失败';
        return;
      }
      const out = (res.results && res.results[0]) || '';
      if (out) cardBody.textContent = out;
      else if (res.skipped && res.skipped[0]) cardBody.textContent = '这段已经是目标语言了';
      else cardBody.textContent = '接口没返回内容，换个接口或重试';
    } catch {
      if (extensionGone()) {
        cardBody.textContent = '扩展刚更新过，刷新页面后再试';
        promptReload();
      } else {
        cardBody.textContent = '扩展后台没响应，刷新页面再试';
      }
    }
  }

  function positionCard() {
    const top = parseFloat(bubbleEl.style.top || '0');
    const left = parseFloat(bubbleEl.style.left || '0');
    const width = Math.min(360, window.innerWidth - 32);
    const x = Math.min(Math.max(8, left + 17 - width / 2), window.innerWidth - width - 8);
    const y = Math.min(Math.max(8, top + 42), window.innerHeight - 220);
    cardEl.style.left = `${x}px`;
    cardEl.style.top = `${y}px`;
  }

  function onBubbleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const sel = window.getSelection();
    translateSelection(selectionText || (sel ? sel.toString() : ''));
  }

  // ------------------------------------------------------------------ 消息

  function applySettings(next) {
    const prevMode = settings.mode;
    settings = { ...settings, ...next };
    if (settings.mode !== prevMode && active) {
      restorePage();
      stopTranslation();
      startTranslation();
      return;
    }
    if (settings.auto && !active) startTranslation();
  }

  async function refreshSettings() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'settings:get' });
      if (r && r.ok) applySettings(r.settings);
    } catch { /* 扩展刚重载时可能拿不到 */ }
  }

  // 设置页改完设置时，让已经打开的页面也跟上（只更新内存，不主动重翻，免得白花钱）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings || !changes.settings.newValue) return;
    settings = { ...settings, ...changes.settings.newValue };
  });

  // 快捷键：浏览器命令（Alt+T）和页面内监听可能同时触发，400ms 内只算一次
  let lastToggleAt = 0;

  function doToggle() {
    if (active) {
      restorePage();
      stopTranslation();
      toast('已还原原文');
    } else {
      startTranslation();
    }
  }

  function toggleOnce() {
    const now = Date.now();
    if (now - lastToggleAt < 400) return false;
    lastToggleAt = now;
    doToggle();
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'ui:toggle') {
      toggleOnce();
      sendResponse({ ok: true, active });
      return;
    }
    if (msg.type === 'ui:state') {
      sendResponse({
        ok: true,
        active,
        translated: document.querySelectorAll('[data-ct-done]').length,
        mode: settings.mode,
        target: settings.target,
        provider: settings.provider
      });
      return;
    }
    if (msg.type === 'ui:apply-settings') {
      applySettings(msg.settings || {});
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'ui:translate-selection') {
      translateSelection(String(msg.text || '').trim());
      sendResponse({ ok: true });
      return;
    }
  });

  // ------------------------------------------------------------------ 启动

  function bindGlobal() {
    document.addEventListener('mouseup', onMouseUp, true);
    // 点页面任何地方（卡片内部除外）→ 气泡和译文卡片都收起来
    document.addEventListener('mousedown', (e) => {
      if (e.target && e.target.id === 'whale-translate-host') return;
      hideBubble();
      hideCard();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideBubble();
        hideCard();
      }
    }, true);
    // 兜底：浏览器命令没绑上时，页面里自己接住 Alt+T / Alt+Q
    document.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const key = String(e.key || '').toLowerCase();
      const hit = e.code === 'KeyT' || e.code === 'KeyQ' || key === 't' || key === 'q';
      if (!hit) return;
      e.preventDefault();
      toggleOnce();
    }, true);
    // 页面一滚，卡片就跟着走丢了，干脆收掉；卡片自己内部的滚动不算
    window.addEventListener('scroll', (e) => {
      hideBubble();
      const t = e.target;
      if (t === window || t === document || t === document.documentElement || t === document.body) hideCard();
    }, { passive: true, capture: true });
  }

  async function init() {
    buildUI();
    bindGlobal();
    try {
      const r = await chrome.runtime.sendMessage({ type: 'settings:get' });
      if (r && r.ok) settings = { ...DEFAULTS, ...r.settings };
    } catch { /* 用默认值继续 */ }
    if (settings.auto) setTimeout(() => { if (!active) startTranslation(); }, 900);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
