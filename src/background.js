// background.js —— 翻译调度中心：设置、缓存、限速、三家接口。
import {
  mergeSettings,
  LANGS,
  looksTranslated,
  cacheKey,
  flattenForRequest,
  rejoinResults,
  buildMessages,
  parseTranslationArray,
  describeHttpError,
  chunkByBytes,
  decodeEntities,
  convertCurrencies,
  getKeyFor,
  hostOf,
  targetName
} from './lib.js';

const SETTINGS_KEY = 'settings';
const CACHE_KEY = 'cache';
const RATES_KEY = 'rates';
const RATES_TTL = 24 * 3600 * 1000; // 汇率一天刷新一次
const CACHE_LIMIT = 4000;

// 免费接口别打太猛，容易被 429
const GAP = { mymemory: 300, google: 260, llm: 0 };

/** @type {ReturnType<typeof mergeSettings>|null} */
let settingsCache = null;
let cache = new Map();
let cacheLoaded = false;
let lastCallAt = 0;
let gate = Promise.resolve();
let saveTimer = 0;

// 本机内置 Key（项目根目录 key.local.json，不进 zip）。
// 它和某个 host 绑定，只在那个接口下生效，不会发给别家。
let localKey = { key: '', host: '' };
let localKeyLoaded = false;

async function ensureLocalKey() {
  if (localKeyLoaded) return;
  localKeyLoaded = true;
  try {
    const res = await fetch(chrome.runtime.getURL('key.local.json'), { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data && typeof data.apiKey === 'string' && data.apiKey.trim()) {
      localKey = {
        key: data.apiKey.trim(),
        host: hostOf(data.baseUrl || 'https://api.deepseek.com/v1')
      };
    }
  } catch { /* 没有这个文件就当作没配置 */ }
}

/** 当前接口可用的 Key：只认当前 host 的，拿不到就空着（绝不把别家的 Key 发出去） */
function resolveApiKey(settings) {
  const cfg = settings.llm || {};
  const key = getKeyFor(settings);
  if (key) return key;
  const host = hostOf(cfg.baseUrl);
  if (localKey.key && localKey.host && host && localKey.host === host) return localKey.key;
  return '';
}

// ---------------------------------------------------------------- 设置

async function getSettings() {
  await ensureLocalKey();
  if (settingsCache) return settingsCache;
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  settingsCache = mergeSettings(got[SETTINGS_KEY]);
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[SETTINGS_KEY]) {
    settingsCache = mergeSettings(changes[SETTINGS_KEY].newValue);
  }
});

async function saveSettings(patch) {
  const cur = await getSettings();
  const next = mergeSettings({ ...cur, ...patch, llm: { ...cur.llm, ...(patch.llm || {}) } });
  settingsCache = next;
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

// ---------------------------------------------------------------- 缓存

async function ensureCache() {
  if (cacheLoaded) return;
  const got = await chrome.storage.local.get(CACHE_KEY);
  cache = new Map(Object.entries(got[CACHE_KEY] || {}));
  cacheLoaded = true;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveNow(); }, 2000);
}

async function saveNow() {
  saveTimer = 0;
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(cache) });
  } catch {
    // 超配额就砍一半再来
    cache = new Map([...cache.entries()].slice(-Math.floor(CACHE_LIMIT / 2)));
    try {
      await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(cache) });
    } catch { /* 存不下就算了，内存里还有 */ }
  }
}

// ---------------------------------------------------------------- 限速闸门

function pace(provider) {
  const gap = GAP[provider] ?? 150;
  const run = gate.then(async () => {
    const wait = lastCallAt + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  gate = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------- MyMemory 免费接口
// 免 Key，国内可直连；单次请求 500 字节上限，所以按字节切片、逐片翻译后拼回。

async function myMemoryOne(text, to) {
  const url =
    'https://api.mymemory.translated.net/get?q=' +
    encodeURIComponent(text) +
    '&langpair=' +
    encodeURIComponent('autodetect|' + to);

  for (let attempt = 0; attempt < 2; attempt++) {
    await pace('mymemory');
    const res = await fetch(url);

    // 429 多数是“请求太密”，先等一会儿重来一次；还不行就当成额度用完，交给兜底
    if (res.status === 429) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1600));
        continue;
      }
      throw new QuotaError('MyMemory 限流了（429），今天的免费额度可能也见底了', 'mymemory');
    }
    if (!res.ok) throw new Error(describeHttpError(res.status, 'mymemory'));

    const data = await res.json();
    const status = Number(data && data.responseStatus);
    const details = String((data && data.responseDetails) || '');
    if (status !== 200) {
      if (status === 429 || /QUOTA|FREE TRANSLATIONS|TOO MANY/i.test(details)) {
        throw new QuotaError('MyMemory 今天的免费额度用完了（每天 5000 词）', 'mymemory');
      }
      throw new Error('MyMemory 返回 ' + (status || '异常') + (details ? `：${details.slice(0, 80)}` : ''));
    }
    return decodeEntities((data.responseData && data.responseData.translatedText) || '');
  }
  throw new Error('MyMemory 请求失败');
}

async function myMemoryTranslate(parts, settings) {
  const to = (LANGS.find((l) => l.code === settings.target) || LANGS[0]).code;
  const out = [];
  for (const part of parts) {
    const pieces = chunkByBytes(part, 450);
    let translated = '';
    for (const piece of pieces) {
      translated += await myMemoryOne(piece, to);
    }
    out.push(translated);
  }
  return out;
}

// ---------------------------------------------------------------- Google 免费接口

async function googleOne(text, to) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=' +
    encodeURIComponent(to) +
    '&q=' +
    encodeURIComponent(text);
  const res = await fetch(url);
  if (!res.ok) throw new Error(describeHttpError(res.status, 'google'));
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('Google 返回格式异常');
  return data[0].map((seg) => (seg && seg[0]) || '').join('');
}

async function googleTranslate(parts, settings) {
  const to = (LANGS.find((l) => l.code === settings.target) || LANGS[0]).google;
  if (parts.length === 1) {
    await pace('google');
    return [await googleOne(parts[0], to)];
  }
  const clean = parts.map((t) => t.replace(/\s*\n\s*/g, ' ').trim());
  const joined = clean.join('\n');
  await pace('google');
  const res = await fetch(
    'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=' + encodeURIComponent(to),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ q: joined })
    }
  );
  if (!res.ok) {
    if (res.status === 429) throw new QuotaError('Google 触发了限流（429）', 'google');
    throw new Error(describeHttpError(res.status, 'google'));
  }
  const data = await res.json();
  const text = (data[0] || []).map((seg) => (seg && seg[0]) || '').join('');
  const lines = text.split('\n');
  if (lines.length === clean.length) return lines;
  // 行数对不上（Google 会自己合并句子）→ 退回逐条翻译
  const out = [];
  for (const t of clean) {
    await pace('google');
    out.push(await googleOne(t, to));
  }
  return out;
}

// ---------------------------------------------------------------- 大模型接口（OpenAI 兼容）

function chatUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
}

/** 各家「关掉深度思考」的参数名不一样，认不出来就不传（400 时会自动去掉重试） */
function thinkingOffParams(baseUrl) {
  const h = hostOf(baseUrl);
  if (!h) return {};
  if (h.endsWith('deepseek.com') || h.endsWith('bigmodel.cn') || h.includes('xiaomimimo')) {
    return { thinking: { type: 'disabled' } };
  }
  if (h.includes('dashscope') || h.includes('qianwen') || h.includes('aliyuncs') || h.includes('siliconflow')) {
    return { enable_thinking: false };
  }
  return {};
}

async function llmTranslate(parts, settings) {
  await ensureLocalKey();
  const cfg = settings.llm;
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(cfg.baseUrl || '');
  const apiKey = resolveApiKey(settings);
  if (!apiKey && !isLocal) {
    const host = hostOf(cfg.baseUrl);
    throw new Error(`这个接口（${host || '未填地址'}）还没填 API Key，去设置页补上`);
  }

  const body = {
    model: cfg.model,
    temperature: 0,
    stream: false,
    messages: buildMessages(parts, settings.target)
  };
  if (cfg.jsonMode) body.response_format = { type: 'json_object' };
  // 翻译用不上思考：开着会多几百毫秒、还多算输出 token
  if (!isLocal) Object.assign(body, thinkingOffParams(cfg.baseUrl));

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const send = async () => {
    await pace('llm');
    return fetch(chatUrl(cfg.baseUrl), { method: 'POST', headers, body: JSON.stringify(body) });
  };

  let res = await send();
  if (res.status === 400) {
    // 有些兼容实现不认 response_format / thinking 这类可选参数，去掉再试一次
    const optional = ['response_format', 'thinking', 'enable_thinking', 'reasoning_effort'];
    let stripped = false;
    for (const k of optional) {
      if (k in body) {
        delete body[k];
        stripped = true;
      }
    }
    if (stripped) res = await send();
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(describeHttpError(res.status, 'llm', detail));
  }
  const data = await res.json();
  const raw = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  const arr = parseTranslationArray(raw, parts.length);
  if (!arr) {
    // 条数对不上时先拆半再试，别让一整批（甚至整页）陪葬
    if (parts.length > 1) {
      const mid = Math.ceil(parts.length / 2);
      const left = await llmTranslate(parts.slice(0, mid), settings);
      const right = await llmTranslate(parts.slice(mid), settings);
      return [...left, ...right];
    }
    throw new Error('模型返回的条数/格式对不上，换个模型或关掉 JSON 模式试试');
  }
  return arr;
}

// ---------------------------------------------------------------- 额度烧完之后切到大模型

class QuotaError extends Error {
  constructor(message, provider) {
    super(message);
    this.name = 'QuotaError';
    this.provider = provider;
  }
}

let quotaState = null;

/** 免费额度按天恢复，所以冷却到明天 00:05 */
function nextResetAt() {
  const d = new Date();
  d.setHours(24, 5, 0, 0);
  return d.getTime();
}

async function ensureQuota() {
  if (quotaState) return quotaState;
  const got = await chrome.storage.local.get('quota');
  quotaState = (got && got.quota) || {};
  return quotaState;
}

async function setCooldown(provider, reason) {
  await ensureQuota();
  quotaState[provider] = { until: nextResetAt(), at: Date.now(), reason: reason || '' };
  await chrome.storage.local.set({ quota: quotaState });
}

async function clearCooldown() {
  quotaState = {};
  await chrome.storage.local.set({ quota: {} });
}

function coolingDown(provider) {
  const q = quotaState && quotaState[provider];
  return !!(q && q.until > Date.now());
}

function llmReady(settings) {
  const cfg = settings.llm || {};
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(cfg.baseUrl || '');
  const key = resolveApiKey(settings);
  return !!(key || local) && !!String(cfg.model || '').trim();
}

/** 这次请求实际该用哪个接口：主接口在冷却且大模型可用 → 用大模型 */
async function effectiveProvider(settings) {
  if (settings.provider === 'llm') return 'llm';
  if (settings.autoFallback === false) return settings.provider;
  await ensureQuota();
  if (coolingDown(settings.provider) && llmReady(settings)) return 'llm';
  return settings.provider;
}

// ---------------------------------------------------------------- 对外：翻译一批文本

async function callProvider(name, parts, settings) {
  if (name === 'llm') return llmTranslate(parts, settings);
  if (name === 'google') return googleTranslate(parts, settings);
  return myMemoryTranslate(parts, settings);
}

async function translate(texts, settings) {
  await ensureCache();
  await ensureQuota();
  const out = new Array(texts.length).fill('');
  const skipped = new Array(texts.length).fill(false); // 已经是目标语言 / 没内容，主动跳过
  const pending = [];

  texts.forEach((raw, i) => {
    const text = String(raw == null ? '' : raw);
    if (!text.trim() || looksTranslated(text, settings.target)) {
      skipped[i] = true;
      return;
    }
    const k = cacheKey(settings, text);
    if (cache.has(k)) {
      out[i] = cache.get(k);
      return;
    }
    pending.push({ i, text, k });
  });
  if (!pending.length) {
    // 全都命中缓存：也要走一遍金额换算，否则老缓存里的金额没有 ≈¥
    if (settings.autoCurrency !== false && out.some((t) => t)) {
      const r = await getRates();
      if (r && r.rates) {
        for (let i = 0; i < out.length; i++) {
          if (out[i]) {
            const before = out[i];
            out[i] = convertCurrencies(before, r.rates, 'CNY');
          }
        }
      }
    }
    return { results: out, fallback: null, skipped };
  }

  let provider = await effectiveProvider(settings);
  let fallback = null;
  if (provider !== settings.provider) {
    fallback = { from: settings.provider, to: provider, reason: '免费额度已用完' };
  }

  const isLLM = provider === 'llm';
  const budget = isLLM ? 1600 : 1400;
  const maxItems = provider === 'google' ? 8 : 20;

  const groups = [];
  let cur = [];
  let chars = 0;
  for (const p of pending) {
    if (cur.length && (chars + p.text.length > budget || cur.length >= maxItems)) {
      groups.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(p);
    chars += p.text.length;
  }
  if (cur.length) groups.push(cur);

  for (const group of groups) {
    const { parts, index } = flattenForRequest(group.map((p) => p.text), provider === 'llm' ? 1500 : 1400);
    if (!parts.length) continue;
    let results;
    try {
      results = await callProvider(provider, parts, settings);
    } catch (e) {
      // 免费额度烧完 → 记下冷却，立刻换大模型重试这一批，别让用户白等
      const canFallback =
        e && e.name === 'QuotaError' &&
        provider !== 'llm' &&
        settings.autoFallback !== false &&
        llmReady(settings);
      if (!canFallback) throw e;
      await setCooldown(provider, e.message);
      results = await callProvider('llm', parts, settings);
      fallback = { from: provider, to: 'llm', reason: e.message };
      provider = 'llm';
    }
    const joined = rejoinResults(results, index, group.length);
    group.forEach((p, j) => {
      const t = (joined[j] || '').trim();
      if (!t) return;
      out[p.i] = t;
      cache.set(p.k, t);
    });
  }
  scheduleSave();

  // 金额换算成人民币（缓存里存原文，换算只在出口做，换汇率不用清缓存）
  if (settings.autoCurrency !== false && out.some((t) => t)) {
    const r = await getRates();
    if (r && r.rates) {
      for (let i = 0; i < out.length; i++) {
        if (out[i]) out[i] = convertCurrencies(out[i], r.rates, 'CNY');
      }
    }
  }

  return { results: out, fallback, skipped };
}

// ---------------------------------------------------------------- 汇率

let ratesCache = null;

async function getRates() {
  const now = Date.now();
  if (ratesCache && now - ratesCache.at < RATES_TTL) return ratesCache;

  const readStored = async () => {
    const got = await chrome.storage.local.get(RATES_KEY);
    return got && got[RATES_KEY] ? got[RATES_KEY] : null;
  };

  const stored = ratesCache || (await readStored());
  if (stored && now - stored.at < RATES_TTL) {
    ratesCache = stored;
    return stored;
  }

  const sources = [
    async () => {
      const res = await fetch('https://open.er-api.com/v6/latest/CNY', { cache: 'no-store' });
      const d = await res.json();
      if (d && d.result === 'success' && d.rates) {
        return { at: now, source: 'open.er-api.com', date: d.time_last_update_utc || '', rates: d.rates };
      }
      return null;
    },
    async () => {
      const res = await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/cny.json', { cache: 'no-store' });
      const d = await res.json();
      if (d && d.cny) {
        return { at: now, source: 'jsdelivr', date: d.date || '', rates: d.cny };
      }
      return null;
    }
  ];

  for (const fetchRates of sources) {
    try {
      const got = await fetchRates();
      if (got) {
        ratesCache = got;
        await chrome.storage.local.set({ [RATES_KEY]: ratesCache });
        return ratesCache;
      }
    } catch { /* 换下一个源 */ }
  }

  if (stored) {
    ratesCache = stored; // 过期也先用着，总比不换强
    return stored;
  }
  return null;
}

// ---------------------------------------------------------------- 消息处理

function errorText(e) {
  if (!e) return '翻译失败';
  const msg = String(e.message || e);
  if (/Failed to fetch|NetworkError|ERR_/i.test(msg)) {
    return '网络连不上（国内访问 Google 需要代理；也可以换 MyMemory 或大模型接口）';
  }
  return msg;
}

async function handle(msg) {
  switch (msg && msg.type) {
    case 'settings:get':
      return { ok: true, settings: await getSettings() };
    case 'settings:set': {
      const s = await saveSettings(msg.patch || {});
      return { ok: true, settings: s };
    }
    case 'translate': {
      const s = await getSettings();
      const texts = Array.isArray(msg.texts) ? msg.texts : [];
      // 允许调用方临时指定目标语言（弹窗的文本框会按输入语言自动选）
      const target = msg.target && LANGS.some((l) => l.code === msg.target) ? msg.target : s.target;
      const eff = target === s.target ? s : { ...s, target };
      const { results, fallback, skipped } = await translate(texts, eff);
      return { ok: true, results, fallback, skipped, target };
    }
    case 'quota:get': {
      const s = await getSettings();
      await ensureQuota();
      const q = quotaState[s.provider];
      return {
        ok: true,
        provider: s.provider,
        until: q && q.until > Date.now() ? q.until : 0,
        reason: (q && q.reason) || '',
        cooling: !!(q && q.until > Date.now()),
        llmReady: llmReady(s),
        autoFallback: s.autoFallback !== false
      };
    }
    case 'quota:clear': {
      await clearCooldown();
      return { ok: true };
    }
    case 'open-options': {
      chrome.runtime.openOptionsPage();
      return { ok: true };
    }
    case 'rates:info': {
      const r = await getRates();
      return {
        ok: true,
        at: r ? r.at : 0,
        source: (r && r.source) || '',
        date: (r && r.date) || '',
        okRate: !!(r && r.rates)
      };
    }
    case 'stats': {
      await ensureCache();
      return { ok: true, cached: cache.size };
    }
    case 'cache:clear': {
      cache = new Map();
      scheduleSave();
      return { ok: true };
    }
    case 'test': {
      const s = await getSettings();
      const t0 = Date.now();
      const { results, fallback } = await translate(['Hello there! This is a quick test of the translation engine.'], s);
      return { ok: true, ms: Date.now() - t0, sample: results[0] || '(空)', provider: s.provider, target: targetName(s.target), fallback };
    }
    default:
      return { ok: false, error: '未知消息' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ ok: false, error: errorText(e) }));
  return true;
});

// ---------------------------------------------------------------- 右键菜单 / 快捷键

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'translate-selection',
      title: '鲸译：翻译“%s”',
      contexts: ['selection']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'translate-selection' || !tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'ui:translate-selection', text: info.selectionText || '' });
  } catch { /* 页面里没注入，忽略 */ }
});

/** 给标签页发指令；老页面没有内容脚本时现场注入一次再试 */
async function toggleTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ui:toggle' });
    return true;
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
      await new Promise((r) => setTimeout(r, 180));
      await chrome.tabs.sendMessage(tabId, { type: 'ui:toggle' });
      return true;
    } catch {
      return false;
    }
  }
}

function flashBadge(text = '!') {
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    chrome.action.setBadgeText({ text });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
  } catch { /* 忽略 */ }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-page' && command !== 'toggle-page-2') return;
  const t = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!t || !t.id) return;
  const ok = await toggleTab(t.id);
  // 打不开的页面（chrome://、商店页）给个红点提示，别让主人以为快捷键坏了
  if (!ok) flashBadge('!');
});
