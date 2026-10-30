import {
  mergeSettings,
  sanitizeImported,
  buildExportPayload,
  getKeyFor,
  setKeyFor,
  hostOf,
  LANGS,
  PROVIDERS,
  providerMeta
} from './lib.js';
import { t, applyI18n, uiLang } from './i18n.js';

const $ = (sel) => document.querySelector(sel);

const PRESETS = {
  deepseek: { labelKey: 'presetDeepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', jsonMode: true },
  qwen: { labelKey: 'presetQwen', baseUrl: 'https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1', model: 'qwen-flash', jsonMode: true },
  glm: { labelKey: 'presetGlm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', jsonMode: true },
  mimo: { labelKey: 'presetMimo', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash', jsonMode: true },
  siliconflow: { labelKey: 'presetSiliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', jsonMode: false },
  ollama: { labelKey: 'presetOllama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', jsonMode: false }
};

const PROVIDER_NOTE_KEYS = {
  mymemory: 'noteMymemory',
  google: 'noteGoogle',
  llm: 'noteLlm'
};

let settings = mergeSettings();
let saveTimer = 0;

function flashSaved() {
  const el = $('#saved');
  el.classList.add('on');
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => el.classList.remove('on'), 1500);
}

async function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeSettings, 250);
}

/** 真正落盘（关页面时也要走一次，别让最后一次改动丢掉） */
async function writeSettings() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  settings = mergeSettings(settings);
  await chrome.storage.local.set({ settings });
  flashSaved();
}

window.addEventListener('pagehide', () => { if (saveTimer) writeSettings(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && saveTimer) writeSettings();
});

function renderLang() {
  const select = $('#target');
  select.innerHTML = '';
  for (const l of LANGS) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = l.name;
    select.appendChild(o);
  }
  select.value = settings.target;
}

function renderProviders() {
  const box = $('#providers');
  box.innerHTML = '';
  for (const p of PROVIDERS) {
    const label = document.createElement('label');
    label.className = 'provider' + (settings.provider === p.id ? ' on' : '');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'provider';
    input.value = p.id;
    input.checked = settings.provider === p.id;
    const text = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = uiLang() === 'en' ? (p.nameEn || p.name) : p.name;
    const note = document.createElement('span');
    note.textContent = PROVIDER_NOTE_KEYS[p.id] ? t(PROVIDER_NOTE_KEYS[p.id]) : '';
    text.append(name, note);
    label.append(input, text);
    input.addEventListener('change', () => {
      settings.provider = p.id;
      renderProviders();
      renderLlmBox();
      persist();
    });
    box.appendChild(label);
  }
}

function renderLlmBox() {
  $('#llm-box').classList.toggle('show', settings.provider === 'llm');
  $('#base-url').value = settings.llm.baseUrl;
  $('#model').value = settings.llm.model;
  // Key 按 host 分开存：切到别家时，DeepSeek 的 Key 不会跟过去
  $('#api-key').value = getKeyFor(settings);
  $('#json-mode').classList.toggle('on', settings.llm.jsonMode !== false);
  renderPresetSelect();
}

function currentPresetKey() {
  const base = String(settings.llm.baseUrl || '').trim().replace(/\/+$/, '');
  for (const [key, p] of Object.entries(PRESETS)) {
    if (p.baseUrl.replace(/\/+$/, '') === base) return key;
  }
  return 'custom';
}

function renderPresetSelect() {
  const select = $('#preset');
  if (!select) return;
  select.innerHTML = '';
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = t('presetCustom');
  select.appendChild(custom);
  for (const [key, p] of Object.entries(PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = t(p.labelKey);
    select.appendChild(opt);
  }
  select.value = currentPresetKey();
}

function renderSwitches() {
  $('#auto').classList.toggle('on', !!settings.auto);
  $('#visible').classList.toggle('on', settings.visibleOnly !== false);
  $('#bubble').classList.toggle('on', settings.selectionBubble !== false);
  $('#currency').classList.toggle('on', settings.autoCurrency !== false);
  $('#auto-fallback').classList.toggle('on', settings.autoFallback !== false);
  $('#mode').value = settings.mode;
}

async function refreshQuota() {
  const box = $('#quota-note');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'quota:get' });
    if (r && r.ok && r.cooling) {
      const when = new Date(r.until);
      const hhmm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
      const meta = providerMeta(r.provider);
      const name = uiLang() === 'en' ? (meta.nameEn || meta.name) : meta.name;
      $('#quota-text').textContent = r.llmReady
        ? t('quotaLlmOpts', { name, t: hhmm })
        : t('quotaNoKeyOpts', { name, t: hhmm });
      box.style.display = 'flex';
    } else {
      box.style.display = 'none';
    }
  } catch {
    box.style.display = 'none';
  }
}

async function refreshCacheNote() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'stats' });
    if (r && r.ok) $('#cache-note').textContent = t('cacheNoteOpts', { n: r.cached });
  } catch {
    $('#cache-note').textContent = t('cacheNoteFail');
  }
}

function bind() {
  $('#target').addEventListener('change', (e) => {
    settings.target = e.target.value;
    persist();
  });
  $('#mode').addEventListener('change', (e) => {
    settings.mode = e.target.value;
    persist();
  });
  $('#auto').addEventListener('click', () => {
    settings.auto = !settings.auto;
    renderSwitches();
    persist();
  });
  $('#visible').addEventListener('click', () => {
    settings.visibleOnly = !settings.visibleOnly;
    renderSwitches();
    persist();
  });
  $('#bubble').addEventListener('click', () => {
    settings.selectionBubble = !settings.selectionBubble;
    renderSwitches();
    persist();
  });
  $('#currency').addEventListener('click', () => {
    settings.autoCurrency = settings.autoCurrency === false;
    renderSwitches();
    persist();
    refreshRateNote();
  });

  for (const id of ['base-url', 'model', 'api-key']) {
    $(`#${id}`).addEventListener('input', (e) => {
      if (id === 'api-key') {
        settings.llm = setKeyFor(settings.llm, e.target.value); // 只写当前 host 的槽
      } else {
        const key = id === 'base-url' ? 'baseUrl' : 'model';
        settings.llm[key] = e.target.value;
        renderPresetSelect();
      }
      persist();
    });
  }
  $('#json-mode').addEventListener('click', () => {
    settings.llm.jsonMode = settings.llm.jsonMode === false;
    $('#json-mode').classList.toggle('on', settings.llm.jsonMode);
    persist();
  });
  $('#auto-fallback').addEventListener('click', () => {
    settings.autoFallback = settings.autoFallback === false;
    $('#auto-fallback').classList.toggle('on', settings.autoFallback !== false);
    persist();
    refreshQuota();
  });
  $('#quota-clear').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'quota:clear' });
    await refreshQuota();
    $('#test-out').className = 'ok';
    $('#test-out').textContent = t('switchedToFree');
  });

  $('#preset').addEventListener('change', (e) => {
    const key = e.target.value;
    const preset = PRESETS[key];
    if (!preset) return; // 自定义：不动输入框
    settings.llm = { ...settings.llm, baseUrl: preset.baseUrl, model: preset.model, jsonMode: preset.jsonMode };
    settings.provider = 'llm';
    renderProviders();
    renderLlmBox();
    renderPresetSelect();
    persist();
    $('#test-out').className = '';
    $('#test-out').textContent = t('presetFilled', { label: t(preset.labelKey) });
  });

  $('#test').addEventListener('click', async () => {
    const out = $('#test-out');
    out.className = '';
    out.textContent = t('testing');
    await persist();
    await new Promise((r) => setTimeout(r, 300)); // 等设置落盘
    try {
      const r = await chrome.runtime.sendMessage({ type: 'test' });
      if (r && r.ok) {
        out.className = 'ok';
        const extra = r.fallback ? t('testFallbackExtra') : '';
        out.textContent = t('testOk', { ms: r.ms, sample: r.sample, extra });
        refreshCacheNote();
        refreshQuota();
      } else {
        out.className = 'err';
        out.textContent = (r && r.error) || t('testFailText');
      }
    } catch (e) {
      out.className = 'err';
      out.textContent = t('backendDown');
    }
  });

  $('#clear-cache').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'cache:clear' });
    await refreshCacheNote();
    $('#test-out').className = 'ok';
    $('#test-out').textContent = t('cacheCleared');
  });

  // ---- 备份 / 迁移 ----
  $('#export-settings').addEventListener('click', async () => {
    const out = $('#io-out');
    try {
      const payload = buildExportPayload(settings);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = uiLang() === 'en' ? `whale-translator-settings-${stamp}.json` : `鲸译设置-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      out.className = 'ok';
      out.textContent = t('exported');
    } catch (e) {
      out.className = 'err';
      out.textContent = t('exportFail', { e: e && e.message });
    }
  });

  $('#import-settings').addEventListener('click', () => $('#import-file').click());

  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    const out = $('#io-out');
    if (!file) return;
    try {
      const text = await file.text();
      settings = sanitizeImported(JSON.parse(text));
      await chrome.storage.local.set({ settings });
      renderLang();
      renderProviders();
      renderLlmBox();
      renderSwitches();
      flashSaved();
      out.className = 'ok';
      out.textContent = t('imported');
    } catch (err) {
      out.className = 'err';
      out.textContent = t('importFail', { e: err && err.message });
    } finally {
      e.target.value = '';
    }
  });
}

async function init() {
  applyI18n();
  try {
    const ver = chrome.runtime.getManifest().version;
    $('#ver').textContent = 'v' + ver;
    $('#ver').title = t('verTitle');
  } catch { /* 忽略 */ }
  const stored = await chrome.storage.local.get('settings');
  settings = mergeSettings(stored.settings);
  renderLang();
  renderProviders();
  renderLlmBox();
  renderSwitches();
  bind();
  refreshCacheNote();
  refreshQuota();
  checkLocalKey();
  refreshRateNote();
}

async function refreshRateNote() {
  const note = $('#rate-note');
  if (!note) return;
  if (settings.autoCurrency === false) {
    note.style.display = 'none';
    return;
  }
  try {
    const r = await chrome.runtime.sendMessage({ type: 'rates:info' });
    if (r && r.ok && r.okRate && r.at) {
      const d = new Date(r.at);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      note.textContent = t('rateUpdated', { date: dateStr, source: r.source });
      note.style.display = 'block';
    } else {
      note.textContent = t('rateFail');
      note.style.display = 'block';
    }
  } catch {
    note.style.display = 'none';
  }
}

async function checkLocalKey() {
  try {
    const res = await fetch(chrome.runtime.getURL('key.local.json'), { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.apiKey) {
      const host = hostOf(data.baseUrl || 'https://api.deepseek.com/v1');
      const note = $('#local-key-note');
      note.textContent = t('localKeyNote', { host });
      note.style.display = 'block';
    }
  } catch { /* 没有就没有 */ }
}

init().catch((e) => {
  $('#test-out').className = 'err';
  $('#test-out').textContent = t('initFail', { e: e && e.message });
});
