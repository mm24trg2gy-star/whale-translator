import { mergeSettings, LANGS, PROVIDERS, getKeyFor } from './lib.js';
import { t, applyI18n, uiLang } from './i18n.js';

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
    opt.textContent = uiLang() === 'en' ? (p.nameEn || p.name) : p.name;
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
  btn.textContent = active || translated > 0 ? t('toggleRestore') : t('toggleTranslate');
}

async function refreshState() {
  tabState = await ensureContent();
  if (!tabState) setStatus(t('pageNotTranslatable'));
  else setStatus('');
  render();
}

async function refreshQuota() {
  const hint = $('#quota');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'quota:get' });
    if (r && r.ok && r.cooling && r.llmReady) {
      const when = new Date(r.until);
      const t2 = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
      hint.textContent = t('quotaLlm', { t: t2 });
      hint.style.display = 'block';
    } else if (r && r.ok && r.cooling && !r.llmReady) {
      hint.textContent = t('quotaNoKey');
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
    if (r && r.ok) $('#cache').textContent = t('cached', { n: r.cached });
  } catch { /* 忽略 */ }
}

async function togglePage() {
  const state = await ensureContent();
  if (!state) {
    setStatus(t('pageNotTranslatable'));
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ui:toggle' });
  } catch {
    setStatus(t('injectFail'));
    return;
  }
  setTimeout(refreshState, 120);
}

function bind() {
  $('#toggle').addEventListener('click', togglePage);

  $('#target').addEventListener('change', (e) => {
    saveSettings({ target: e.target.value });
    setStatus(t('langSwitched'));
  });

  document.querySelectorAll('#mode button').forEach((b) => {
    b.addEventListener('click', async () => {
      await saveSettings({ mode: b.dataset.mode });
      render();
      setStatus(t('modeSwitched'));
    });
  });

  $('#auto').addEventListener('click', async () => {
    await saveSettings({ auto: !settings.auto });
    render();
    setStatus(settings.auto ? t('autoOn') : t('autoOff'));
  });

  $('#visible').addEventListener('click', async () => {
    await saveSettings({ visibleOnly: !settings.visibleOnly });
    render();
    setStatus(settings.visibleOnly ? t('visibleOn') : t('visibleOff'));
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
      setStatus(t('needKey'));
    } else if (provider !== 'llm' && settings.autoFallback === false) {
      setStatus(t('noFallback'));
    } else {
      setStatus(t('providerSwitched'));
    }
  });

  $('#fallback').addEventListener('click', async () => {
    await saveSettings({ autoFallback: settings.autoFallback === false });
    render();
    setStatus(settings.autoFallback !== false ? t('fallbackOn') : t('fallbackOff'));
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
      out.textContent = t('emptyInput');
      return;
    }
    const auto = autoTargetFor(text);
    const btn = $('#quick-go');
    btn.disabled = true;
    btn.textContent = t('translating');
    out.textContent = '…';
    const msg = { type: 'translate', texts: [text] };
    if (auto.code) msg.target = auto.code;
    try {
      const r = await chrome.runtime.sendMessage(msg);
      if (!r || !r.ok) {
        out.textContent = (r && r.error) || t('noContent');
        $('#quick-copy').style.display = 'none';
      } else {
        const outText = (r.results && r.results[0]) || '';
        const wasSkipped = !!(r.skipped && r.skipped[0]);
        if (outText) {
          out.textContent = outText;
          $('#quick-copy').style.display = 'inline-block';
          if (auto.label) setStatus(t('autoDirection', { label: auto.label }));
        } else if (wasSkipped) {
          out.textContent = t('alreadyTarget');
          $('#quick-copy').style.display = 'none';
        } else {
          out.textContent = t('noContent');
          $('#quick-copy').style.display = 'none';
        }
      }
    } catch {
      out.textContent = t('noBackend');
      $('#quick-copy').style.display = 'none';
    } finally {
      btn.disabled = false;
      btn.textContent = t('goTranslate');
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
      setStatus(t('copied'));
    } catch {
      setStatus(t('copyFail'));
    }
  });
}

async function init() {
  applyI18n();
  bind();
  try { $('#ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch { /* 忽略 */ }
  await getSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  render();
  await Promise.all([refreshState(), refreshCache(), refreshQuota()]);
}

init().catch((e) => setStatus(t('initFail', { e: e && e.message ? e.message : e })));
