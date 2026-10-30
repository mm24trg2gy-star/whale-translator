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

const $ = (sel) => document.querySelector(sel);

const PRESETS = {
  deepseek: { label: 'DeepSeek · deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', jsonMode: true },
  qwen: { label: '通义千问 · qwen-flash（最便宜）', baseUrl: 'https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1', model: 'qwen-flash', jsonMode: true },
  glm: { label: '智谱 GLM · glm-5.3-flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', jsonMode: true },
  mimo: { label: '小米 MiMo · mimo-v2.6-flash', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash', jsonMode: true },
  siliconflow: { label: '硅基流动 · Qwen2.5-7B', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', jsonMode: false },
  ollama: { label: '本地 Ollama · qwen2.5:7b', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', jsonMode: false }
};

const PROVIDER_NOTES = {
  mymemory: '免 Key · 国内能直连 · 每天 5000 词（推荐先试这个）',
  google: '免 Key · 质量稳 · 国内需要代理才连得上',
  llm: '按量计费 · 通义 flash 约 ¥0.15 / 百万 tokens 起，一页几厘钱'
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
    label.innerHTML =
      `<input type="radio" name="provider" value="${p.id}" ${settings.provider === p.id ? 'checked' : ''} />` +
      `<div><b>${p.name}</b><span>${PROVIDER_NOTES[p.id] || ''}</span></div>`;
    label.querySelector('input').addEventListener('change', () => {
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
  custom.textContent = '自定义（手动填）';
  select.appendChild(custom);
  for (const [key, p] of Object.entries(PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = p.label;
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
      const t = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
      const name = providerMeta(r.provider).name;
      $('#quota-text').textContent = r.llmReady
        ? `${name} 额度用完了，正在用大模型兜底 · ${t} 恢复免费额度`
        : `${name} 额度用完了，但大模型还没配好 Key，翻不了 · ${t} 后恢复`;
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
    if (r && r.ok) $('#cache-note').textContent = `已缓存 ${r.cached} 条译文，句句复用，不会重复花钱。`;
  } catch {
    $('#cache-note').textContent = '取不到缓存状态（后台刚重启，稍后再看）。';
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
    $('#test-out').textContent = '已切回免费接口';
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
    $('#test-out').textContent = `已填好 ${preset.label}，记得填对应的 Key`;
  });

  $('#test').addEventListener('click', async () => {
    const out = $('#test-out');
    out.className = '';
    out.textContent = '测试中…';
    await persist();
    await new Promise((r) => setTimeout(r, 300)); // 等设置落盘
    try {
      const r = await chrome.runtime.sendMessage({ type: 'test' });
      if (r && r.ok) {
        out.className = 'ok';
        const extra = r.fallback ? '（免费额度用完，已自动切到大模型）' : '';
        out.textContent = `通了 ✓ ${r.ms}ms · ${r.sample}${extra}`;
        refreshCacheNote();
        refreshQuota();
      } else {
        out.className = 'err';
        out.textContent = (r && r.error) || '失败';
      }
    } catch (e) {
      out.className = 'err';
      out.textContent = '后台无响应，重开设置页试试';
    }
  });

  $('#clear-cache').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'cache:clear' });
    await refreshCacheNote();
    $('#test-out').className = 'ok';
    $('#test-out').textContent = '缓存已清空';
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
      a.download = `鲸译设置-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      out.className = 'ok';
      out.textContent = '已导出（文件里有 Key，记得用完删）';
    } catch (e) {
      out.className = 'err';
      out.textContent = '导出失败：' + (e && e.message);
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
      out.textContent = '导入成功，刷新已打开的网页后生效';
    } catch (err) {
      out.className = 'err';
      out.textContent = '导入失败：不是有效的设置文件（' + (err && err.message) + '）';
    } finally {
      e.target.value = '';
    }
  });
}

async function init() {
  try {
    const ver = chrome.runtime.getManifest().version;
    $('#ver').textContent = 'v' + ver;
    $('#ver').title = '当前版本';
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
      const t = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      note.textContent = `汇率更新于 ${t}（${r.source}），一天自动刷新一次。`;
      note.style.display = 'block';
    } else {
      note.textContent = '暂时取不到汇率（没网或接口挂了），先不换算。';
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
      note.textContent = `✓ 已检测到本机内置 Key（只对 ${host} 生效），这里留空会自动用它`;
      note.style.display = 'block';
    }
  } catch { /* 没有就没有 */ }
}

init().catch((e) => {
  $('#test-out').className = 'err';
  $('#test-out').textContent = '初始化失败：' + (e && e.message);
});
