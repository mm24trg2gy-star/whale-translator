import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeSettings,
  DEFAULTS,
  looksTranslated,
  chunkText,
  flattenForRequest,
  rejoinResults,
  parseTranslationArray,
  buildMessages,
  describeHttpError,
  chunkByBytes,
  decodeEntities,
  sanitizeImported,
  buildExportPayload,
  convertCurrencies,
  formatCny,
  getKeyFor,
  setKeyFor,
  hostOf,
  cacheKey,
  targetForSystemLang
} from '../src/lib.js';

test('targetForSystemLang：默认译入语言跟着系统语言走', () => {
  assert.equal(targetForSystemLang('zh-CN'), 'zh-CN');
  assert.equal(targetForSystemLang('zh-TW'), 'zh-TW');
  assert.equal(targetForSystemLang('en-US'), 'en');
  assert.equal(targetForSystemLang('fr-FR'), 'fr');
  assert.equal(targetForSystemLang('de-DE'), 'de');
  assert.equal(targetForSystemLang('pt-BR'), 'en', '不支持的语言回落到英文');
  assert.equal(targetForSystemLang(''), 'en');
});

test('Key 按 host 分开存：换到别家时拿不到 DeepSeek 的 Key', () => {
  const s = mergeSettings({ llm: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-deep', model: 'm' } });
  assert.equal(getKeyFor(s), 'sk-deep', '旧的单字段 Key 要迁移到当前 host');
  assert.equal(s.llm.apiKey, '', '旧字段应清空');

  const other = mergeSettings({ ...s, llm: { ...s.llm, baseUrl: 'https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1' } });
  assert.equal(getKeyFor(other), '', '换到通义时不该拿到 DeepSeek 的 Key');

  const withQwen = { ...other, llm: setKeyFor(other.llm, 'sk-qwen') };
  assert.equal(getKeyFor(withQwen), 'sk-qwen');
  assert.equal(withQwen.llm.keys['api.deepseek.com'], 'sk-deep', '两家的 Key 各自保留');

  const back = mergeSettings({ ...withQwen, llm: { ...withQwen.llm, baseUrl: 'https://api.deepseek.com/v1' } });
  assert.equal(getKeyFor(back), 'sk-deep', '切回 DeepSeek 还能用回原 Key');
});

test('hostOf：坏地址不炸', () => {
  assert.equal(hostOf('https://api.deepseek.com/v1'), 'api.deepseek.com');
  assert.equal(hostOf('not a url'), '');
  assert.equal(hostOf(null), '');
});

test('convertCurrencies：常见写法都能补上人民币估价', () => {
  const rates = { ZAR: 2.5, USD: 0.14, EUR: 0.13 };
  // 30 万兰特 ÷ 2.5 = 12 万
  assert.equal(convertCurrencies('ZAR 300K', rates), 'ZAR 300K（≈¥12万）');
  assert.equal(convertCurrencies('300K南非兰特', rates), '300K南非兰特（≈¥12万）');
  assert.equal(convertCurrencies('预算 20M ZAR', rates), '预算 20M ZAR（≈¥800万）');
  assert.equal(convertCurrencies('$1,200', rates), '$1,200（≈¥8571）');
  assert.equal(convertCurrencies('报价 €500', rates), '报价 €500（≈¥3846）');
});

test('convertCurrencies：不重复加、不碰人民币、没汇率就原样返回', () => {
  const rates = { ZAR: 2.5, USD: 0.14 };
  const once = convertCurrencies('ZAR 300K', rates);
  assert.equal(convertCurrencies(once, rates), once, '已经换算过的不该再加一层');
  assert.equal(convertCurrencies('人民币 300 元', rates), '人民币 300 元');
  assert.equal(convertCurrencies('ZAR 300K', null), 'ZAR 300K');
  assert.equal(convertCurrencies('ZAR 300K', { EUR: 0.13 }), 'ZAR 300K', '没有该币种汇率就跳过');
  assert.equal(convertCurrencies('no money here', rates), 'no money here');
});

test('formatCny：大数用万/亿，小数保留两位', () => {
  assert.equal(formatCny(120000), '12万');
  assert.equal(formatCny(1150), '1150');
  assert.equal(formatCny(3.2), '3.2');
  assert.equal(formatCny(120000000), '1.2亿');
});

test('sanitizeImported：只收白名单字段，兼容包装格式，脏值被纠正', () => {
  const wrapped = sanitizeImported({ settings: { provider: 'llm', llm: { apiKey: 'sk-a' }, evil: 'x' } });
  assert.equal(wrapped.provider, 'llm');
  assert.equal(getKeyFor(wrapped), 'sk-a');
  assert.equal(wrapped.evil, undefined, '未知字段不该进设置');
  assert.equal(wrapped.target, 'zh-CN', '缺字段回落到默认');

  const bare = sanitizeImported({ provider: 'nope', target: 'xx', llm: { baseUrl: 'http://127.0.0.1:1/v1' } });
  assert.equal(bare.provider, 'mymemory');
  assert.equal(bare.target, 'zh-CN');
  assert.equal(bare.llm.baseUrl, 'http://127.0.0.1:1/v1');

  assert.equal(sanitizeImported(null).provider, 'mymemory');
  assert.equal(sanitizeImported('不是对象').provider, 'mymemory');
});

test('buildExportPayload：带应用标记、时间和设置', () => {
  const p = buildExportPayload({ provider: 'llm', target: 'ja' }, new Date('2026-10-22T00:00:00Z'));
  assert.equal(p.app, 'whale-translator');
  assert.equal(p.format, 1);
  assert.equal(p.exportedAt, '2026-10-22T00:00:00.000Z');
  assert.equal(p.settings.provider, 'llm');
  assert.match(p.note, /Key/);
});

test('导入/导出：金额换算开关也要能带过去', () => {
  const s = sanitizeImported({ settings: { autoCurrency: false, provider: 'llm' } });
  assert.equal(s.autoCurrency, false, '关掉的换算开关不该被重置成开');
});

test('decodeEntities：坏实体不炸', () => {
  assert.equal(decodeEntities('&#99999999; ok'), ' ok');
  assert.equal(decodeEntities('&#x110000;'), '');
});

test('mergeSettings：空值补默认，脏值被纠正', () => {
  const s = mergeSettings(undefined);
  assert.equal(s.provider, 'mymemory');
  assert.equal(s.target, 'zh-CN');
  assert.equal(s.mode, 'bilingual');
  assert.equal(s.visibleOnly, true);
  assert.equal(s.llm.model, 'deepseek-flash');

  const bad = mergeSettings({ provider: 'baidu', target: 'klingon', mode: 'weird', auto: 1 });
  assert.equal(bad.provider, 'mymemory');
  assert.equal(bad.target, 'zh-CN');
  assert.equal(bad.mode, 'bilingual');
  assert.equal(bad.auto, true);
});

test('mergeSettings：llm 部分合并，不丢已有字段', () => {
  const s = mergeSettings({ provider: 'llm', llm: { apiKey: 'sk-x' } });
  assert.equal(s.provider, 'llm');
  assert.equal(getKeyFor(s), 'sk-x');
  assert.equal(s.llm.baseUrl, DEFAULTS.llm.baseUrl);
});

test('looksTranslated：中文不再翻，英文要翻', () => {
  assert.equal(looksTranslated('今天天气很好，我们去海边吧。', 'zh-CN'), true);
  assert.equal(looksTranslated('The quick brown fox jumps over the lazy dog.', 'zh-CN'), false);
  assert.equal(looksTranslated('12345 !!! 😀', 'zh-CN'), true);
  assert.equal(looksTranslated('', 'zh-CN'), true);
  assert.equal(looksTranslated('Hello world', 'en'), true);
  assert.equal(looksTranslated('你好世界', 'en'), false);
  // 中英混排，主体是中文
  assert.equal(looksTranslated('DeepSeek 发布了新的 V3 模型，速度很快。', 'zh-CN'), true);
});

test('chunkText：按句切分，不超长，拼回原文', () => {
  const text = 'First sentence here. Second sentence is a bit longer! Third one? And a fourth.';
  const parts = chunkText(text, 25);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), text);
  for (const p of parts) assert.ok(p.length <= 25, `chunk too long: ${p.length}`);
});

test('chunkText：没有标点的长文本也能硬切', () => {
  const text = 'a'.repeat(100);
  const parts = chunkText(text, 30);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every((p) => p.length <= 30));
});

test('flattenForRequest + rejoinResults：长文拆分后能拼回', () => {
  const texts = ['Short one.', 'x'.repeat(50) + '. ' + 'y'.repeat(50) + '.'];
  const { parts, index } = flattenForRequest(texts, 40);
  assert.ok(parts.length >= 3);
  assert.equal(index.length, parts.length);
  const results = parts.map((p) => p.toUpperCase());
  const joined = rejoinResults(results, index, texts.length);
  assert.equal(joined[0], 'SHORT ONE.');
  assert.equal(joined[1], texts[1].toUpperCase());
});

test('parseTranslationArray：各种脏格式', () => {
  assert.deepEqual(parseTranslationArray('{"translations":["甲","乙"]}', 2), ['甲', '乙']);
  assert.deepEqual(parseTranslationArray('```json\n{"translations":["甲","乙"]}\n```', 2), ['甲', '乙']);
  assert.deepEqual(parseTranslationArray('好的，结果如下：{"translations":["甲"]}', 1), ['甲']);
  assert.deepEqual(parseTranslationArray('["甲","乙"]', 2), ['甲', '乙']);
  assert.deepEqual(parseTranslationArray('{"translations":[{"text":"甲"}]}', 1), ['甲']);
  // 条数不符 → null，让上层重试
  assert.equal(parseTranslationArray('{"translations":["甲"]}', 2), null);
  assert.equal(parseTranslationArray('这不是 JSON', 1), null);
  assert.equal(parseTranslationArray('', 1), null);
});

test('buildMessages：系统提示带目标语言，用户消息是 JSON 数组', () => {
  const msgs = buildMessages(['Hello', 'World'], 'ja');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /日本語/);
  assert.match(msgs[0].content, /translations/);
  assert.deepEqual(JSON.parse(msgs[1].content), ['Hello', 'World']);
});

test('describeHttpError：常见状态码给人话', () => {
  assert.match(describeHttpError(401, 'llm'), /Key 无效/);
  assert.match(describeHttpError(429, 'edge'), /频繁/);
  assert.match(describeHttpError(503, 'google'), /服务端/);
});

test('cacheKey：按接口 + 目标语言隔离', () => {
  const a = cacheKey({ provider: 'edge', target: 'zh-CN' }, 'hi');
  const b = cacheKey({ provider: 'llm', target: 'zh-CN' }, 'hi');
  const c = cacheKey({ provider: 'edge', target: 'ja' }, 'hi');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('chunkByBytes：按字节切，不超限，拼回原文', () => {
  const text = 'Whales sing in the deep ocean and travel for miles every single day.';
  const parts = chunkByBytes(text, 30);
  assert.equal(parts.join(''), text);
  for (const p of parts) assert.ok(new TextEncoder().encode(p).length <= 30);
  // 中文：3 字节一个字，不能按字符数算
  const zh = '鲸鱼在深海里唱歌，声音可以传到很远很远的地方。'.repeat(3);
  const zhParts = chunkByBytes(zh, 30);
  assert.equal(zhParts.join(''), zh);
  for (const p of zhParts) assert.ok(new TextEncoder().encode(p).length <= 30, p);
});

test('decodeEntities：把 HTML 实体还原', () => {
  assert.equal(decodeEntities('Tom &amp; Jerry &#39;quote&#39; &quot;x&quot; &lt;b&gt;'), `Tom & Jerry 'quote' "x" <b>`);
  assert.equal(decodeEntities('中文 &#20320;'), '中文 你');
});

test('looksTranslated：日文里的汉字不该被当成中文', () => {
  assert.equal(looksTranslated('これは日本語のテストです', 'zh-CN'), false);
});
