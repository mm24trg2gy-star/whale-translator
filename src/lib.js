// lib.js —— 纯函数工具层。浏览器里被 background.js import，Node 里被单测 import。
// 这一层不碰 chrome.* / DOM，方便直接跑测试。

export const DEFAULTS = {
  provider: 'mymemory', // mymemory | google | llm
  target: 'zh-CN',
  mode: 'bilingual', // bilingual | only
  auto: false,
  visibleOnly: true,
  selectionBubble: true,
  autoFallback: true,
  autoCurrency: true,
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-flash',
    jsonMode: true
  }
};

export const LANGS = [
  { code: 'zh-CN', name: '简体中文 / Chinese', zh: '简体中文', native: 'Chinese', google: 'zh-CN' },
  { code: 'zh-TW', name: '繁體中文 / Traditional Chinese', zh: '繁體中文', native: 'Traditional Chinese', google: 'zh-TW' },
  { code: 'en', name: '英语 / English', zh: '英语', native: 'English', google: 'en' },
  { code: 'ja', name: '日语 / 日本語', zh: '日语', native: '日本語', google: 'ja' },
  { code: 'ko', name: '韩语 / 한국어', zh: '韩语', native: '한국어', google: 'ko' },
  { code: 'ru', name: '俄语 / Русский', zh: '俄语', native: 'Русский', google: 'ru' },
  { code: 'fr', name: '法语 / Français', zh: '法语', native: 'Français', google: 'fr' },
  { code: 'de', name: '德语 / Deutsch', zh: '德语', native: 'Deutsch', google: 'de' },
  { code: 'es', name: '西班牙语 / Español', zh: '西班牙语', native: 'Español', google: 'es' }
];

export const PROVIDERS = [
  { id: 'mymemory', name: 'MyMemory（免费）', hint: '免 Key · 国内能直连 · 每天 5000 词额度' },
  { id: 'google', name: 'Google 翻译（免费）', hint: '免 Key · 质量稳 · 国内需要代理' },
  { id: 'llm', name: '大模型 API（按量计费）', hint: '译文最顺 · 通义 flash 约 ¥0.15 / 百万 tokens 起' }
];

export function targetName(code) {
  return (LANGS.find((l) => l.code === code) || LANGS[0]).name;
}

export function providerMeta(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}

/** 取 URL 的 host（用来按服务商分开存 Key） */
export function hostOf(url) {
  try {
    return new URL(String(url || '')).host.toLowerCase();
  } catch {
    return '';
  }
}

/** 当前接口对应的 Key：按 host 分开存，DeepSeek 的 Key 不会发给别家 */
export function getKeyFor(settings) {
  const llm = (settings && settings.llm) || {};
  const host = hostOf(llm.baseUrl);
  if (!host || !llm.keys || typeof llm.keys !== 'object') return '';
  const key = llm.keys[host];
  return typeof key === 'string' ? key.trim() : '';
}

/** 把 Key 写进当前接口对应的槽位 */
export function setKeyFor(llm, key) {
  const host = hostOf(llm && llm.baseUrl);
  const keys = { ...((llm && llm.keys) || {}) };
  if (!host) return { ...llm, keys };
  if (String(key || '').trim()) keys[host] = String(key).trim();
  else delete keys[host];
  return { ...llm, keys };
}

/** 把存储里读出来的（可能残缺、可能多字段）设置补全成完整结构 */
export function mergeSettings(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  const llm = s.llm && typeof s.llm === 'object' ? s.llm : {};
  const merged = {
    ...DEFAULTS,
    ...s,
    llm: { ...DEFAULTS.llm, ...llm }
  };
  if (!PROVIDERS.some((p) => p.id === merged.provider)) merged.provider = DEFAULTS.provider;
  if (!LANGS.some((l) => l.code === merged.target)) merged.target = DEFAULTS.target;
  if (merged.mode !== 'only') merged.mode = 'bilingual';
  merged.auto = !!merged.auto;
  merged.visibleOnly = merged.visibleOnly !== false;
  merged.selectionBubble = merged.selectionBubble !== false;
  merged.autoFallback = merged.autoFallback !== false;
  merged.autoCurrency = merged.autoCurrency !== false;
  if (typeof merged.llm.baseUrl !== 'string' || !merged.llm.baseUrl.trim()) {
    merged.llm.baseUrl = DEFAULTS.llm.baseUrl;
  }
  if (typeof merged.llm.model !== 'string' || !merged.llm.model.trim()) {
    merged.llm.model = DEFAULTS.llm.model;
  }
  merged.llm.jsonMode = merged.llm.jsonMode !== false;

  // Key 按 host 分开存；老的单字段 apiKey 迁移到当前 host 名下后清空
  merged.llm.keys = merged.llm.keys && typeof merged.llm.keys === 'object' ? { ...merged.llm.keys } : {};
  const host = hostOf(merged.llm.baseUrl);
  if (typeof merged.llm.apiKey === 'string' && merged.llm.apiKey.trim() && host && !merged.llm.keys[host]) {
    merged.llm.keys[host] = merged.llm.apiKey.trim();
  }
  merged.llm.apiKey = '';
  return merged;
}

export function cacheKey(settings, text) {
  return `${settings.provider}|${settings.target}|${text}`;
}

/** 导入用的白名单：只认这些字段，别的一概不落库 */
const IMPORTABLE_KEYS = ['provider', 'target', 'mode', 'auto', 'visibleOnly', 'selectionBubble', 'autoFallback', 'autoCurrency'];
const IMPORTABLE_LLM_KEYS = ['baseUrl', 'apiKey', 'keys', 'model', 'jsonMode'];

/**
 * 把用户导入的 JSON 变成一份干净的设置。
 * 兼容两种格式：{ settings: {...} }（我们自己导出的）和裸设置对象。
 */
export function sanitizeImported(raw) {
  let src = {};
  if (raw && typeof raw === 'object') {
    src = raw.settings && typeof raw.settings === 'object' ? raw.settings : raw;
  }
  const picked = { llm: {} };
  for (const k of IMPORTABLE_KEYS) {
    if (src[k] !== undefined) picked[k] = src[k];
  }
  if (src.llm && typeof src.llm === 'object') {
    for (const k of IMPORTABLE_LLM_KEYS) {
      if (src.llm[k] !== undefined) picked.llm[k] = src.llm[k];
    }
  }
  return mergeSettings(picked);
}

/** 导出用的载荷 */
export function buildExportPayload(settings, now = new Date()) {
  return {
    app: 'whale-translator',
    format: 1,
    exportedAt: now.toISOString(),
    note: '这个文件里含 API Key，别发给别人',
    settings
  };
}

const LETTER_RE = /[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/;
const CJK_RE = /[\u4e00-\u9fff]/g;
const LATIN_RE = /[A-Za-z]/g;
const KANA_HANGUL_RE = /[\u3040-\u30ff\uac00-\ud7af]/g;

const countOf = (s, re) => (s.match(re) || []).length;

/**
 * 判断这段文本是否「已经是目标语言 / 根本不需要翻译」。
 * 目的只有一个：别把中文再翻一遍浪费额度。
 */
export function looksTranslated(text, target) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (!LETTER_RE.test(s)) return true; // 纯数字、符号、emoji

  const cjk = countOf(s, CJK_RE);
  const kana = countOf(s, KANA_HANGUL_RE) - cjk; // 粗略
  const latin = countOf(s, LATIN_RE);

  if (target === 'zh-CN' || target === 'zh-TW') {
    if (kana > 0) return false; // 日文/韩文里也有汉字，别误判
    return cjk >= 2 && cjk * 2 >= latin;
  }
  if (target === 'en') {
    return latin >= 4 && latin >= cjk * 3;
  }
  return false;
}

/** 超长段落按句子切成小块，尽量保留分隔符，拼回去不失真 */
export function chunkText(text, max) {
  const s = String(text || '');
  if (s.length <= max) return [s];
  const parts = [];
  let rest = s;
  const boundary = /[.!?。！？；;:：\n]/g;
  while (rest.length > max) {
    const head = rest.slice(0, max);
    let cut = -1;
    boundary.lastIndex = 0;
    let m;
    while ((m = boundary.exec(head))) cut = m.index + 1;
    if (cut < max * 0.35) cut = max; // 找不到句读就硬切
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

/** 把一批长文本摊平成「可发送的片段」，index 记录每片属于第几条 */
export function flattenForRequest(texts, maxLen) {
  const parts = [];
  const index = [];
  texts.forEach((t, i) => {
    const chunks = String(t).length <= maxLen ? [String(t)] : chunkText(t, maxLen);
    for (const c of chunks) {
      if (!c.trim()) continue;
      parts.push(c);
      index.push(i);
    }
  });
  return { parts, index };
}

/** 与 flattenForRequest 配对，把片段结果拼回原条数 */export function rejoinResults(results, index, count) {
  const out = new Array(count).fill('');
  results.forEach((r, k) => {
    const i = index[k];
    if (i === undefined) return;
    out[i] = (out[i] || '') + (r == null ? '' : String(r));
  });
  return out;
}

/**
 * 按 UTF-8 字节数切分（MyMemory 单次请求只有 500 字节），
 * 尽量在空格/标点处断开，别把单词劈两半。
 */
export function chunkByBytes(text, maxBytes = 450) {
  const s = String(text || '');
  if (!s) return [];
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return [s];

  const isBoundary = (ch) => /[\s.,!?;:，。！？；：、)\]】」』]/.test(ch);
  const parts = [];
  let rest = s;
  while (rest) {
    let bytes = 0;
    let cut = 0;
    for (const ch of rest) {
      const b = enc.encode(ch).length;
      if (bytes + b > maxBytes) break;
      bytes += b;
      cut += ch.length;
    }
    if (cut <= 0) cut = 1;
    if (cut < rest.length) {
      const window = rest.slice(0, cut);
      const floor = Math.floor(window.length * 0.5);
      for (let i = window.length - 1; i >= floor; i--) {
        if (isBoundary(window[i])) {
          cut = i + 1;
          break;
        }
      }
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return parts;
}

/** 翻译接口偶尔返回 HTML 实体，转回来再插进页面 */
export function decodeEntities(s) {
  const safe = (n) => (Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
  return String(s == null ? '' : s)
    .replace(/&#(\d+);/g, (_, d) => safe(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safe(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function buildMessages(texts, target) {
  const lang = targetName(target);
  return [
    {
      role: 'system',
      content:
        `你是专业翻译引擎。把用户给出的 JSON 数组里的每个字符串翻译成${lang}。\n` +
        '规则：\n' +
        '1. 逐条翻译，输出条数与输入完全相同、顺序不变，不得合并或拆分；\n' +
        '2. 保留原文的换行、URL、代码、数字、专有名词；\n' +
        '3. 不要解释、不要加注、不要输出 Markdown 代码块；\n' +
        '4. 只输出一个 JSON 对象：{"translations": ["译文1", "译文2", ...]}'
    },
    { role: 'user', content: JSON.stringify(texts) }
  ];
}

/** 从模型输出里抠出译文数组；条数不符就返回 null（交给上层重试/拆批） */
export function parseTranslationArray(raw, expected) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  let obj = null;
  try {
    obj = JSON.parse(s);
  } catch {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    const c = s.indexOf('[');
    const d = s.lastIndexOf(']');
    if (a >= 0 && b > a) {
      try { obj = JSON.parse(s.slice(a, b + 1)); } catch { obj = null; }
    }
    if (obj == null && c >= 0 && d > c) {
      try { obj = JSON.parse(s.slice(c, d + 1)); } catch { obj = null; }
    }
  }
  if (obj == null) return null;

  let arr = Array.isArray(obj) ? obj : obj.translations || obj.items || obj.result || obj.data;
  if (!Array.isArray(arr)) return null;

  const out = arr.map((x) => {
    if (typeof x === 'string') return x;
    if (x && typeof x === 'object') return String(x.text ?? x.translation ?? x.zh ?? '');
    return '';
  });
  if (expected != null && out.length !== expected) return null;
  return out;
}

/** 构造主流「OpenAI 兼容」错误里的可读提示 */
export function describeHttpError(status, provider, detail) {
  const names = { llm: '模型接口', google: 'Google', mymemory: 'MyMemory' };
  const head = `${names[provider] || provider}返回 ${status}`;
  if (status === 401 || status === 403) return `${head}：Key 无效或没有权限`;
  if (status === 429) return `${head}：请求太频繁，歇几秒再试`;
  if (status >= 500) return `${head}：服务端出错，稍后再试`;
  const extra = detail ? `（${String(detail).slice(0, 120)}）` : '';
  return head + extra;
}

// ---------------------------------------------------------------- 金额换算成人民币

/** 币种 → 中文/英文别名。值为 [ISO, 中文名...] */
const CURRENCY_ALIASES = [
  ['ZAR', '南非兰特', '兰特'],
  ['USD', '美元', '美金', 'US$'],
  ['EUR', '欧元'],
  ['GBP', '英镑'],
  ['JPY', '日元', '日币'],
  ['KRW', '韩元'],
  ['RUB', '卢布'],
  ['HKD', '港元', '港币'],
  ['AUD', '澳元', '澳大利亚元'],
  ['CAD', '加元', '加拿大元'],
  ['SGD', '新加坡元', '新币'],
  ['INR', '印度卢比', '卢比'],
  ['BRL', '雷亚尔'],
  ['AED', '迪拉姆'],
  ['CHF', '瑞士法郎', '瑞郎'],
  ['THB', '泰铢'],
  ['MYR', '林吉特', '马币'],
  ['TRY', '土耳其里拉'],
  ['MXN', '墨西哥比索'],
  ['VND', '越南盾'],
  ['PHP', '菲律宾比索'],
  ['IDR', '印尼盾']
];

const SYMBOL_CODES = { $: 'USD', '€': 'EUR', '£': 'GBP', '₽': 'RUB', '₩': 'KRW', '₹': 'INR' };

const aliasToCode = new Map();
for (const [code, ...aliases] of CURRENCY_ALIASES) {
  aliasToCode.set(code.toLowerCase(), code);
  for (const a of aliases) aliasToCode.set(a, code);
}

const ALIAS_PATTERN = CURRENCY_ALIASES
  .flatMap(([code, ...aliases]) => [code, ...aliases])
  .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .sort((a, b) => b.length - a.length)
  .join('|');

// 数字 + 可选单位（K/M/B/万/亿）；金额里允许逗号
const NUM_PART = '([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*([KkMmBb万亿])?';
const PRE_RE = new RegExp(`(^|[^A-Za-z])(${ALIAS_PATTERN})\\s*${NUM_PART}`, 'gi');
const POST_RE = new RegExp(`${NUM_PART}\\s*(${ALIAS_PATTERN})(?![A-Za-z])`, 'gi');
const SYMBOL_RE = new RegExp(`([$€£₽₩₹])\\s*${NUM_PART}`, 'g');

const MULTIPLIER = { k: 1e3, m: 1e6, b: 1e9, 万: 1e4, 亿: 1e8 };

function toNumber(numStr, unit) {
  const n = Number(String(numStr).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = unit ? MULTIPLIER[String(unit).toLowerCase()] || MULTIPLIER[unit] : 1;
  return n * (mult || 1);
}

/** 人民币金额的显示：1.2万 / 11.7万 / 1150 / 3.20 */
export function formatCny(v) {
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1e8) return (v / 1e8).toFixed(2).replace(/\.?0+$/, '') + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  if (v >= 100) return String(Math.round(v));
  if (v >= 1) return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function convertOne(match, code, numStr, unit, rates, to) {
  const iso = aliasToCode.get(String(code).toLowerCase()) || aliasToCode.get(code);
  if (!iso || iso === to) return match; // 人民币不用换
  const amount = toNumber(numStr, unit);
  const rate = rates && rates[iso];
  if (!amount || !rate || !Number.isFinite(rate)) return match;
  const cny = amount / rate; // rate = 1 CNY 兑多少 ISO
  const text = formatCny(cny);
  if (!text) return match;
  return `${match}（≈¥${text}）`;
}

/**
 * 把译文里的外币金额后面补一个人民币估价。
 * rates 形如 { ZAR: 2.5, USD: 0.14 }，含义是「1 元人民币 = 多少该币种」。
 */
export function convertCurrencies(text, rates, to = 'CNY') {
  if (!text || !rates || typeof text !== 'string') return text;
  const done = (whole, end) => whole.slice(end, end + 3) === '（≈¥';

  let out = text.replace(SYMBOL_RE, (m, sym, num, unit, offset, whole) => {
    if (done(whole, offset + m.length)) return m;
    return convertOne(m, SYMBOL_CODES[sym], num, unit, rates, to);
  });

  out = out.replace(PRE_RE, (m, lead, code, num, unit, offset, whole) => {
    if (done(whole, offset + m.length)) return m;
    return lead + convertOne(m.slice(lead.length), code, num, unit, rates, to);
  });

  out = out.replace(POST_RE, (m, num, unit, code, offset, whole) => {
    if (done(whole, offset + m.length)) return m;
    return convertOne(m, code, num, unit, rates, to);
  });

  return out;
}

