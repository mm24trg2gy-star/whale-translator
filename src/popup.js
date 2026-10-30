import { mergeSettings, LANGS, PROVIDERS, getKeyFor } from './lib.js';

const $ = (sel) => document.querySelector(sel);
const setStatus = (msg) => { $('#status').textContent = msg || ''; };

let settings = mergeSettings();
let tabId = null;
let tabState = null;

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  settings = mergeSettings(stored.settings);
  return settings;
}

async function saveSettings(patch) {
  settings = mergeSettings({ ...settings, ...patch, llm: { ...settings.llm, ...(patch.llm || {}) } });
  await chrome.storage.local.set({ settings });
  await sendToTab({ type: 'ui:apply-settings', settings });
}

async function sendToTab(msg) {
  if (!tabId) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return null;
  }
}

/** 老页面（扩展安装前就打开的）没有内容脚本，现场注入一次 */
async function ensureContent() {
  const state = await sendToTab({ type: 'ui:state' });
  if (state) return state;
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
    return await sendToTab({ type: 'ui:state' });
  } catch {
    return null;
  }
}

function renderTargets() {
  const select = $('#target');
  select.innerHTML = '';
  for (const lang of LANGS) {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.name;
    select.appendChild(opt);
  }
  select.value = settings.target;
}

function renderProviders() {
  const select = $('#provider');
  select.innerHTML = '';
  for (const p of PROVIDERS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  }
  select.value = settings.provider;
}

function render() {
  renderTargets();
  renderProviders();
  document.querySelectorAll('#mode button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === settings.mode);
  });
  $('#auto').classList.toggle('on', !!settings.auto);
  $('#visible').classList.toggle('on', settings.visibleOnly !== false);
  $('#bubble').classList.toggle('on', settings.selectionBubble !== false);
  $('#fallback').classList.toggle('on', settings.autoFallback !== false);

  const active = !!(tabState && tabState.active);
  const translated = (tabState && tabState.translated) || 0;
  const btn = $('#toggle');
  btn.classList.toggle('is-on', active || translated > 0);
  btn.textContent = active || translated > 0 ? '还原原文' : '翻译此页';
}

async function refreshState() {
  tabState = await ensureContent();
  if (!tabState) setStatus('这个页面不能翻译（chrome:// 或商店页）');
  else setStatus('');
  render();
}

async function refreshQuota() {
  const hint = $('#quota');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'quota:get' });
    if (r && r.ok && r.cooling && r.llmReady) {
      const when = new Date(r.until);
      const t = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
      hint.textContent = `免费额度已用完，正在用大模型兜底 · ${t} 恢复`;
      hint.style.display = 'block';
    } else if (r && r.ok && r.cooling && !r.llmReady) {
      hint.textContent = '免费额度已用完，但大模型还没配 Key · 去设置里补上';
      hint.style.display = 'block';
    } else {
      hint.style.display = 'none';
    }
  } catch {
    hint.style.display = 'none';
  }
}

async function refreshCache() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'stats' });
    if (r && r.ok) $('#cache').textContent = `已缓存 ${r.cached} 条译文`;
  } catch { /* 忽略 */ }
}

async function togglePage() {
  const state = await ensureContent();
  if (!state) {
    setStatus('这个页面不能翻译（chrome:// 或商店页）');
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ui:toggle' });
  } catch {
    setStatus('注入失败，刷新页面后再试');
    return;
  }
  setTimeout(refreshState, 120);
}

function bind() {
  $('#toggle').addEventListener('click', togglePage);

  $('#target').addEventListener('change', (e) => {
    saveSettings({ target: e.target.value });
    setStatus('语言已切换，重新翻译后生效');
  });

  document.querySelectorAll('#mode button').forEach((b) => {
    b.addEventListener('click', async () => {
      await saveSettings({ mode: b.dataset.mode });
      render();
      setStatus('模式已切换');
    });
  });

  $('#auto').addEventListener('click', async () => {
    await saveSettings({ auto: !settings.auto });
    render();
    setStatus(settings.auto ? '以后打开的网页会自动翻译' : '已关闭自动翻译');
  });

  $('#visible').addEventListener('click', async () => {
    await saveSettings({ visibleOnly: !settings.visibleOnly });
    render();
    setStatus(settings.visibleOnly ? '只翻滚动到的区域，更省' : '整页一次性翻完');
  });

  $('#bubble').addEventListener('click', async () => {
    await saveSettings({ selectionBubble: !settings.selectionBubble });
    render();
  });

  $('#provider').addEventListener('change', async (e) => {
    const provider = e.target.value;
    await saveSettings({ provider });
    await refreshQuota();
    if (provider === 'llm' && !getKeyFor(settings) && !/localhost|127\.0\.0\.1/.test(settings.llm.baseUrl || '')) {
      setStatus('还没填 API Key，点右上角 ⚙ 去设置里补上');
    } else if (provider !== 'llm' && settings.autoFallback === false) {
      setStatus('已切到免费接口；额度用完会直接报错（兜底开关关着）');
    } else {
      setStatus('接口已切换，新翻的内容走新接口');
    }
  });

  $('#fallback').addEventListener('click', async () => {
    await saveSettings({ autoFallback: settings.autoFallback === false });
    render();
    setStatus(settings.autoFallback !== false ? '免费额度用完会自动切到大模型' : '已关闭额度兜底');
  });

  $('#open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  // ---- 文本框翻译 ----
  /** 中文→英文、英文→中文；日文/韩文/俄文等其它文字按上面选的语言走 */
  function autoTargetFor(text) {
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    const other = (text.match(/[\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff\u0590-\u06ff\u0e00-\u0e7f]/g) || []).length;
    if (!other && cjk >= 1 && cjk * 2 >= latin) return { code: 'en', label: '中文 → English' };
    if (!other && latin >= 2 && latin > cjk * 2) return { code: 'zh-CN', label: 'English → 中文' };
    return { code: null, label: '' };
  }

  async function quickTranslate() {
    const input = $('#quick-input');
    const out = $('#quick-out');
    const text = input.value.trim();
    if (!text) {
      out.textContent = '先输入或粘贴点文字';
      return;
    }
    const auto = autoTargetFor(text);
    const btn = $('#quick-go');
    btn.disabled = true;
    btn.textContent = '翻译中';
    out.textContent = '…';
    const msg = { type: 'translate', texts: [text] };
    if (auto.code) msg.target = auto.code;
    try {
      const r = await chrome.runtime.sendMessage(msg);
      if (!r || !r.ok) {
        out.textContent = (r && r.error) || '翻译失败';
        $('#quick-copy').style.display = 'none';
      } else {
        const t = (r.results && r.results[0]) || '';
        const wasSkipped = !!(r.skipped && r.skipped[0]);
        if (t) {
          out.textContent = t;
          $('#quick-copy').style.display = 'inline-block';
          if (auto.label) setStatus(`自动选向：${auto.label}（要改请用上面的译文语言）`);
        } else if (wasSkipped) {
          out.textContent = '这段已经是目标语言了，不用翻';
          $('#quick-copy').style.display = 'none';
        } else {
          out.textContent = '接口没返回内容，换个接口或再试一次';
          $('#quick-copy').style.display = 'none';
        }
      }
    } catch {
      out.textContent = '扩展后台没响应，重开一下面板试试';
      $('#quick-copy').style.display = 'none';
    } finally {
      btn.disabled = false;
      btn.textContent = '翻译';
    }
  }

  $('#quick-go').addEventListener('click', quickTranslate);
  $('#quick-input').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      quickTranslate();
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      quickTranslate();
    }
  });
  $('#quick-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#quick-out').textContent || '');
      setStatus('已复制');
    } catch {
      setStatus('复制失败，手动选一下吧');
    }
  });
}

async function init() {
  bind();
  try { $('#ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch { /* 忽略 */ }
  await getSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  render();
  await Promise.all([refreshState(), refreshCache(), refreshQuota()]);
}

init().catch((e) => setStatus('初始化失败：' + (e && e.message ? e.message : e)));
