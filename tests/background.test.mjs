// 用本地假接口跑一遍后台真实链路：设置 → 请求 → 解析 → 缓存 → 400 回退。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const store = {};
const listeners = { message: [], changed: [] };

globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        if (typeof key === 'string') return { [key]: store[key] };
        return { ...store };
      },
      set: async (obj) => { Object.assign(store, obj); }
    },
    onChanged: { addListener: (fn) => listeners.changed.push(fn) }
  },
  runtime: {
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} }
  },
  contextMenus: {
    removeAll: (cb) => cb && cb(),
    create: () => {},
    onClicked: { addListener: () => {} }
  },
  commands: { onCommand: { addListener: () => {} } },
  tabs: { query: async () => [], sendMessage: async () => ({}) }
};

await import('../src/background.js');

function send(msg) {
  return new Promise((resolve) => {
    const fn = listeners.message[0];
    fn(msg, {}, resolve);
  });
}

function startMockServer() {
  const state = { requests: [], rejectJsonMode: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      const payload = body ? JSON.parse(body) : {};
      if (state.rejectJsonMode && payload.response_format) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'response_format unsupported' } }));
        return;
      }
      const texts = JSON.parse(payload.messages[1].content);
      const translations = texts.map((t) => '【译】' + t);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ translations }) } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

test('大模型链路：设置 → 翻译 → 缓存命中 → 400 回退', async (t) => {
  const { server, state, port } = await startMockServer();
  t.after(() => server.close());

  const setRes = await send({
    type: 'settings:set',
    patch: {
      provider: 'llm',
      target: 'zh-CN',
      llm: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test', model: 'mock', jsonMode: true }
    }
  });
  assert.equal(setRes.ok, true);
  assert.equal(setRes.settings.provider, 'llm');

  const r1 = await send({ type: 'translate', texts: ['Hello world.', '这句话已经是中文了，不需要再翻译。'] });
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r1.results[0], '【译】Hello world.');
  assert.equal(r1.results[1], '', '中文段落应被跳过，不花钱');
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].body.model, 'mock');
  assert.equal(state.requests[0].body.temperature, 0);
  assert.deepEqual(state.requests[0].body.response_format, { type: 'json_object' });

  // 第二次同样的文本 → 缓存命中，不再打接口
  const r2 = await send({ type: 'translate', texts: ['Hello world.'] });
  assert.equal(r2.results[0], '【译】Hello world.');
  assert.equal(state.requests.length, 1, '命中缓存不该发请求');

  // 服务端不支持 response_format → 自动去掉重试
  state.rejectJsonMode = true;
  const r3 = await send({ type: 'translate', texts: ['A brand new sentence.'] });
  assert.equal(r3.ok, true, r3.error);
  assert.equal(r3.results[0], '【译】A brand new sentence.');
  assert.equal(state.requests.length, 3);
  assert.equal(state.requests[2].body.response_format, undefined);
});

test('大模型链路：返回条数不对时报错而不是乱贴', async (t) => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"translations":["只有一条"]}' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(() => server.close());

  await send({
    type: 'settings:set',
    patch: { provider: 'llm', target: 'zh-CN', llm: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm' } }
  });

  // 返回条数不够时会自动拆半重试：两条拆成两次单条，各自都能对上
  const r = await send({ type: 'translate', texts: ['One long sentence here.', 'Another totally different one.'] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.results.length, 2);
  assert.ok(r.results.every((t) => t.includes('只有一条')));
});

test('大模型链路：单条也解析不出来，才老实报错', async (t) => {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"translations":[]}' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(() => server.close());

  await send({
    type: 'settings:set',
    patch: { provider: 'llm', target: 'zh-CN', llm: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm' } }
  });
  const r = await send({ type: 'translate', texts: ['A sentence that no one can translate.'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /条数|格式/);
});

test('大模型链路：没填 Key 时给出人话提示', async () => {
  await send({ type: 'settings:set', patch: { provider: 'llm', llm: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '' } } });
  const r = await send({ type: 'translate', texts: ['Needs a key here.'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /API Key/);
});

test('已经是目标语言的文本：返回空结果，但打上 skipped 标记', async () => {
  await send({
    type: 'settings:set',
    patch: { provider: 'mymemory', target: 'zh-CN' }
  });
  const r = await send({ type: 'translate', texts: ['这是一句中文，不需要再翻译。'] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.results[0], '', '跳过的不该有译文');
  assert.equal(r.skipped[0], true, '要标记成 skipped，前端才能给出准确提示');
});

test('translate 可以临时指定目标语言（弹窗文本框的中→英）', async (t) => {
  const { server, port } = await startMockServer();
  t.after(() => server.close());

  await send({
    type: 'settings:set',
    patch: { provider: 'llm', target: 'zh-CN', llm: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-t', model: 'mock', jsonMode: true } }
  });
  const r = await send({ type: 'translate', texts: ['这是一句中文。'], target: 'en' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.target, 'en', '应该按传入的目标语言翻');
  assert.ok(String(r.results[0]).startsWith('【译】'), '中文不该被跳过，要真的翻成英文');
  assert.equal(r.skipped[0], false);
});

test('翻译请求默认关掉深度思考，接口不认这个参数时自动去掉重试', async (t) => {
  const realFetch = globalThis.fetch;
  const seen = [];
  let rejectThinking = false;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('api.deepseek.com')) return realFetch(url, opts);
    const body = JSON.parse(opts.body);
    seen.push(body);
    if (rejectThinking && 'thinking' in body) {
      return new Response(JSON.stringify({ error: { message: 'unknown field thinking' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: ['你好'] }) } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  await send({
    type: 'settings:set',
    patch: { provider: 'llm', llm: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-unit', model: 'deepseek-flash', jsonMode: true } }
  });

  const r1 = await send({ type: 'translate', texts: ['Hello there, friend.'] });
  assert.equal(r1.ok, true, r1.error);
  assert.deepEqual(seen[0].thinking, { type: 'disabled' }, '默认应该关掉思考');

  // 换一段没缓存过的文本，这次让接口拒绝 thinking 参数
  rejectThinking = true;
  const r2 = await send({ type: 'translate', texts: ['A different sentence for the retry path.'] });
  assert.equal(r2.ok, true, r2.error);
  const last = seen[seen.length - 1];
  assert.equal('thinking' in last, false, '重试时应把 thinking 去掉');

  // 别把这份假 Key 留给后面的用例
  await send({ type: 'settings:set', patch: { llm: { keys: {} } } });
});

test('金额换算：命中缓存的译文也要补 ≈¥', async (t) => {
  const { server, port } = await startMockServer();
  t.after(() => server.close());

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('open.er-api.com') || String(url).includes('currency-api')) {
      return new Response(JSON.stringify({ result: 'success', rates: { ZAR: 2.5, USD: 0.14 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return realFetch(url, opts);
  };
  t.after(() => { globalThis.fetch = realFetch; });

  await send({ type: 'cache:clear' });
  await send({
    type: 'settings:set',
    patch: {
      provider: 'llm',
      autoCurrency: true,
      llm: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-cur', model: 'mock', jsonMode: true }
    }
  });

  const first = await send({ type: 'translate', texts: ['Design budget: ZAR 300K'] });
  assert.equal(first.ok, true, first.error);
  assert.ok(first.results[0].includes('≈¥'), '第一次翻译就该换算');

  // 第二次全部命中缓存，仍然要带 ≈¥
  const second = await send({ type: 'translate', texts: ['Design budget: ZAR 300K'] });
  assert.equal(second.ok, true, second.error);
  assert.ok(second.results[0].includes('≈¥'), '缓存命中的结果也要换算');
});

test('stats / cache:clear', async () => {
  const s = await send({ type: 'stats' });
  assert.equal(s.ok, true);
  assert.ok(s.cached >= 1);
  const c = await send({ type: 'cache:clear' });
  assert.equal(c.ok, true);
  const s2 = await send({ type: 'stats' });
  assert.equal(s2.cached, 0);
});

test('免费额度用完：自动切到大模型，并且当天不再打免费接口', async (t) => {
  const { server, port } = await startMockServer();
  t.after(() => server.close());

  const realFetch = globalThis.fetch;
  let myMemoryCalls = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('mymemory')) {
      myMemoryCalls++;
      return new Response(
        JSON.stringify({
          responseStatus: 429,
          responseDetails: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return realFetch(url, opts);
  };
  t.after(() => { globalThis.fetch = realFetch; });

  await send({ type: 'quota:clear' });
  const set = await send({
    type: 'settings:set',
    patch: {
      provider: 'mymemory',
      autoFallback: true,
      llm: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-fallback', model: 'mock', jsonMode: true }
    }
  });
  assert.equal(set.ok, true);

  const r1 = await send({ type: 'translate', texts: ['The first sentence of the day.'] });
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r1.results[0], '【译】The first sentence of the day.');
  assert.ok(r1.fallback, '应该告诉页面的用户已经切到大模型了');
  assert.equal(r1.fallback.from, 'mymemory');
  assert.equal(r1.fallback.to, 'llm');
  assert.equal(myMemoryCalls, 1);

  // 冷却期内：直接走大模型，不该再浪费一次免费接口请求
  const r2 = await send({ type: 'translate', texts: ['A completely different second sentence.'] });
  assert.equal(r2.ok, true);
  assert.equal(r2.results[0], '【译】A completely different second sentence.');
  assert.equal(myMemoryCalls, 1, '冷却期内不该再打 MyMemory');
  assert.ok(r2.fallback);

  const q = await send({ type: 'quota:get' });
  assert.equal(q.cooling, true);
  assert.equal(q.llmReady, true);
  assert.ok(q.until > Date.now());

  await send({ type: 'quota:clear' });
  const q2 = await send({ type: 'quota:get' });
  assert.equal(q2.cooling, false);
});

test('关掉兜底开关 / 没配 Key 时，额度用完就老实报错', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('mymemory')) {
      return new Response(JSON.stringify({ responseStatus: 429, responseDetails: 'QUOTA EXCEEDED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return realFetch(url, opts);
  };
  t.after(() => { globalThis.fetch = realFetch; });

  await send({ type: 'quota:clear' });
  await send({
    type: 'settings:set',
    patch: { provider: 'mymemory', autoFallback: false, llm: { apiKey: 'sk-x', model: 'mock' } }
  });
  const off = await send({ type: 'translate', texts: ['Sentence with fallback disabled.'] });
  assert.equal(off.ok, false);
  assert.match(off.error, /额度/);

  // 开着兜底但没有 Key → 也不该偷偷用大模型
  await send({ type: 'quota:clear' });
  await send({
    type: 'settings:set',
    patch: { provider: 'mymemory', autoFallback: true, llm: { apiKey: '', model: 'mock', baseUrl: 'https://api.deepseek.com/v1' } }
  });
  const noKey = await send({ type: 'translate', texts: ['Sentence without any key at all.'] });
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /额度/);
});
