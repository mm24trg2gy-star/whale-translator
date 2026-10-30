// 界面多语言：跟着浏览器/系统的默认语言走。
// 中文环境用中文，其它语言用英文。覆盖工具栏面板（popup）和设置页（options）。
const DICT = {
  zh: {
    // ---- 通用 ----
    appTitle: '鲸译',
    appSub: '省钱网页翻译',
    settings: '设置',

    // ---- 工具栏面板 ----
    toggleTranslate: '翻译此页',
    toggleRestore: '还原原文',
    targetLang: '译文语言',
    displayMode: '显示方式',
    modeBilingual: '双语',
    modeOnly: '纯译文',
    autoLabel: '打开网页自动翻译',
    autoTitle: '打开就翻，不用每次点',
    visibleLabel: '只翻可见区域',
    visibleTitle: '滚到哪翻到哪，长文档更省钱',
    bubbleLabel: '划词翻译',
    providerLabel: '翻译接口',
    fallbackLabel: '额度用完自动切大模型',
    fallbackSub: '免费接口烧完不断档',
    quickPlaceholder: '中文→英文，英文→中文；其它语言用上面的译文语言',
    goTranslate: '翻译',
    translating: '翻译中',
    copy: '复制',
    cached: '已缓存 {n} 条译文',
    footerHint: '翻译 / 还原当前页　·　选中文字后点「译」',
    pageNotTranslatable: '这个页面不能翻译（chrome:// 或商店页）',
    quotaLlm: '免费额度已用完，正在用大模型兜底 · {t} 恢复',
    quotaNoKey: '免费额度已用完，但大模型还没配 Key · 去设置里补上',
    injectFail: '注入失败，刷新页面后再试',
    langSwitched: '语言已切换，重新翻译后生效',
    modeSwitched: '模式已切换',
    autoOn: '以后打开的网页会自动翻译',
    autoOff: '已关闭自动翻译',
    visibleOn: '只翻滚动到的区域，更省',
    visibleOff: '整页一次性翻完',
    needKey: '还没填 API Key，点右上角 ⚙ 去设置里补上',
    noFallback: '已切到免费接口；额度用完会直接报错（兜底开关关着）',
    providerSwitched: '接口已切换，新翻的内容走新接口',
    fallbackOn: '免费额度用完会自动切到大模型',
    fallbackOff: '已关闭额度兜底',
    emptyInput: '先输入或粘贴点文字',
    autoDirection: '自动选向：{label}（要改请用上面的译文语言）',
    alreadyTarget: '这段已经是目标语言了，不用翻',
    noContent: '接口没返回内容，换个接口或再试一次',
    noBackend: '扩展后台没响应，重开一下面板试试',
    copied: '已复制',
    copyFail: '复制失败，手动选一下吧',
    initFail: '初始化失败：{e}',

    // ---- 设置页 ----
    optionsTitle: '鲸译 · 设置',
    optionsSub: '整页双语 + 划词翻译，能白嫖的不花钱，该花钱的也只花在刀刃上。',
    secProvider: '翻译接口',
    presetLabel: '快速选择服务商',
    presetSub: '点一下自动填好地址和模型，填错了可以手动改',
    baseUrlLabel: '接口地址（OpenAI 兼容）',
    modelLabel: '模型名',
    keyLabel: 'API Key',
    localKeyNoteFallback: '✓ 已检测到本机内置 Key，这里留空会自动用它',
    localKeyNote: '✓ 已检测到本机内置 Key（只对 {host} 生效），这里留空会自动用它',
    jsonMode: 'JSON 模式',
    jsonModeSub: '模型支持时更稳；报 400 就关掉',
    fallbackLong: '免费额度用完自动切到大模型',
    fallbackLongSub: 'MyMemory 每天 5000 词，烧完自动改用上面配置的大模型，页面上会提示你',
    quotaClear: '立即切回免费',
    secBehavior: '翻译行为',
    modeLabel: '显示方式',
    modeOptBilingual: '双语对照（原文 + 译文）',
    modeOptOnly: '只看译文（隐藏原文）',
    autoLongSub: '每种页面都会自动开翻，怕吵就关着用 Alt+T',
    visibleLongSub: '滚到哪翻到哪；长文档能省掉一大半费用',
    bubbleLongSub: '选中文字后弹出「译」按钮',
    currencyLabel: '外币金额自动换算',
    currencySub: '译文里出现 ZAR / USD / € 之类的金额，后面补一个 ≈¥ 估价',
    secTools: '连通性测试 / 缓存',
    testBtn: '测试当前接口',
    clearCacheBtn: '清空译文缓存',
    testIdle: '还没测试',
    secBackup: '备份 / 迁移',
    exportBtn: '导出设置（JSON）',
    importBtn: '导入设置',
    backupNote: '换电脑、重装浏览器时，导出这份 JSON 再导入就恢复原样（接口、Key、语言、开关全在里面）。<br />⚠️ 文件里<b>包含 API Key 明文</b>，用完就删，别丢网盘、别发群里。',
    secAbout: '说明',
    aboutNote: '· 密钥只存在本机 <code>chrome.storage.local</code>，不上传任何服务器。<br />· MyMemory / Google 用的是网页版翻译的公开入口，免费用、不用注册，但不是官方 API，量大可能被限流。<br />· 大模型接口按 token 计费，翻译整页通常只要几厘到几分钱；相同句子会被缓存，第二次不花钱。<br />· 快捷键 <code>Alt + T</code> 可翻译 / 还原当前页；右键选中文字也有「鲸译」菜单。',
    saved: '已保存 ✓',
    verTitle: '当前版本',

    // ---- 设置页动态文案 ----
    quotaLlmOpts: '{name} 额度用完了，正在用大模型兜底 · {t} 恢复免费额度',
    quotaNoKeyOpts: '{name} 额度用完了，但大模型还没配好 Key，翻不了 · {t} 后恢复',
    cacheNoteOpts: '已缓存 {n} 条译文，句句复用，不会重复花钱。',
    cacheNoteInit: '已缓存 0 条译文。',
    cacheNoteFail: '取不到缓存状态（后台刚重启，稍后再看）。',
    presetFilled: '已填好 {label}，记得填对应的 Key',
    testing: '测试中…',
    testOk: '通了 ✓ {ms}ms · {sample}{extra}',
    testFallbackExtra: '（免费额度用完，已自动切到大模型）',
    testFailText: '失败',
    backendDown: '后台无响应，重开设置页试试',
    cacheCleared: '缓存已清空',
    switchedToFree: '已切回免费接口',
    exported: '已导出（文件里有 Key，记得用完删）',
    exportFail: '导出失败：{e}',
    imported: '导入成功，刷新已打开的网页后生效',
    importFail: '导入失败：不是有效的设置文件（{e}）',
    rateUpdated: '汇率更新于 {date}（{source}），一天自动刷新一次。',
    rateFail: '暂时取不到汇率（没网或接口挂了），先不换算。',

    // ---- 服务商说明 ----
    noteMymemory: '免 Key · 国内能直连 · 每天 5000 词（推荐先试这个）',
    noteGoogle: '免 Key · 质量稳 · 国内需要代理才连得上',
    noteLlm: '按量计费 · 通义 flash 约 ¥0.15 / 百万 tokens 起，一页几厘钱',
    presetCustom: '自定义（手动填）',
    presetDeepseek: 'DeepSeek · deepseek-flash',
    presetQwen: '通义千问 · qwen-flash（最便宜）',
    presetGlm: '智谱 GLM · glm-5.3-flash',
    presetMimo: '小米 MiMo · mimo-v2.6-flash',
    presetSiliconflow: '硅基流动 · Qwen2.5-7B',
    presetOllama: '本地 Ollama · qwen2.5:7b'
  },
  en: {
    // ---- 通用 ----
    appTitle: 'Whale Translate',
    appSub: 'Affordable page translation',
    settings: 'Settings',

    // ---- 工具栏面板 ----
    toggleTranslate: 'Translate this page',
    toggleRestore: 'Restore original',
    targetLang: 'Translate into',
    displayMode: 'Display',
    modeBilingual: 'Bilingual',
    modeOnly: 'Translation only',
    autoLabel: 'Auto-translate new pages',
    autoTitle: 'Translate pages as soon as they open',
    visibleLabel: 'Visible area only',
    visibleTitle: 'Translate as you scroll — cheaper on long pages',
    bubbleLabel: 'Translate selection',
    providerLabel: 'Provider',
    fallbackLabel: 'Fall back to LLM when quota runs out',
    fallbackSub: 'Keeps working after the free quota is gone',
    quickPlaceholder: 'Chinese→English, English→Chinese; other languages use the target above',
    goTranslate: 'Translate',
    translating: 'Translating',
    copy: 'Copy',
    cached: '{n} translations cached',
    footerHint: 'translate / restore this page · select text → 译',
    pageNotTranslatable: 'This page cannot be translated (chrome:// or web store pages)',
    quotaLlm: 'Free quota used up, falling back to the LLM · resets at {t}',
    quotaNoKey: 'Free quota used up and no LLM key yet · add one in Settings',
    injectFail: 'Injection failed — reload the page and try again',
    langSwitched: 'Language changed; retranslate to apply',
    modeSwitched: 'Display mode changed',
    autoOn: 'New pages will be translated automatically',
    autoOff: 'Auto-translate turned off',
    visibleOn: 'Only the visible area will be translated',
    visibleOff: 'The whole page will be translated at once',
    needKey: 'No API key yet — click ⚙ in the top-right to add one',
    noFallback: 'Switched to the free provider; quota errors will now be shown directly (fallback off)',
    providerSwitched: 'Provider changed; new text uses the new provider',
    fallbackOn: 'Will fall back to the LLM when the free quota runs out',
    fallbackOff: 'Quota fallback turned off',
    emptyInput: 'Type or paste some text first',
    autoDirection: 'Auto direction: {label} (change the target above to override)',
    alreadyTarget: 'This is already in the target language',
    noContent: 'The provider returned nothing — try another provider or retry',
    noBackend: 'Extension background is not responding — reopen this panel',
    copied: 'Copied',
    copyFail: 'Copy failed — select the text manually',
    initFail: 'Init failed: {e}',

    // ---- 设置页 ----
    optionsTitle: 'Whale Translate · Settings',
    optionsSub: 'Full-page bilingual translation plus selection translation — free where possible, cheap where not.',
    secProvider: 'Provider',
    presetLabel: 'Quick preset',
    presetSub: 'Fills in the URL and model for you; you can still edit them',
    baseUrlLabel: 'API base URL (OpenAI compatible)',
    modelLabel: 'Model',
    keyLabel: 'API Key',
    localKeyNoteFallback: '✓ Built-in local key detected — leave this empty to use it',
    localKeyNote: '✓ Built-in local key detected (only for {host}) — leave this empty to use it',
    jsonMode: 'JSON mode',
    jsonModeSub: 'More stable when supported; turn it off if you get a 400',
    fallbackLong: 'Fall back to the LLM when the free quota runs out',
    fallbackLongSub: 'MyMemory allows 5,000 words per day; after that the LLM above takes over and the page tells you',
    quotaClear: 'Switch back to free now',
    secBehavior: 'Translation behaviour',
    modeLabel: 'Display',
    modeOptBilingual: 'Bilingual (original + translation)',
    modeOptOnly: 'Translation only (hide original)',
    autoLongSub: 'Every page starts translating automatically; turn it off and use Alt+T if that is too noisy',
    visibleLongSub: 'Translate as you scroll — saves a lot on long documents',
    bubbleLongSub: 'Show a 译 button after you select text',
    currencyLabel: 'Convert foreign amounts',
    currencySub: 'Appends an ≈¥ estimate after amounts like ZAR / USD / €',
    secTools: 'Connection test / cache',
    testBtn: 'Test current provider',
    clearCacheBtn: 'Clear translation cache',
    testIdle: 'Not tested yet',
    secBackup: 'Backup / migrate',
    exportBtn: 'Export settings (JSON)',
    importBtn: 'Import settings',
    backupNote: 'Moving to a new machine or reinstalling the browser? Export this JSON and import it to restore everything (provider, keys, language, switches).<br />⚠️ The file contains your <b>API key in plain text</b> — delete it when done, do not upload it anywhere.',
    secAbout: 'Notes',
    aboutNote: '· Keys live only in <code>chrome.storage.local</code> on this machine; nothing is uploaded to any server of ours.<br />· MyMemory / Google use the public web endpoints: free, no signup, but not official APIs — heavy use may be rate-limited.<br />· LLM providers bill per token; a full page usually costs a fraction of a cent, and repeated sentences are cached for free.<br />· <code>Alt + T</code> translates / restores the current page; there is also a right-click menu entry for selected text.',
    saved: 'Saved ✓',
    verTitle: 'Current version',

    // ---- 设置页动态文案 ----
    quotaLlmOpts: '{name} quota is used up, falling back to the LLM · free quota returns at {t}',
    quotaNoKeyOpts: '{name} quota is used up and the LLM has no key yet · returns at {t}',
    cacheNoteOpts: '{n} translations cached — reused, never paid for twice.',
    cacheNoteInit: '0 translations cached.',
    cacheNoteFail: 'Cannot read cache status (the background just restarted, check again later).',
    presetFilled: 'Filled in {label} — remember to add its API key',
    testing: 'Testing…',
    testOk: 'OK ✓ {ms}ms · {sample}{extra}',
    testFallbackExtra: ' (free quota used up, switched to the LLM)',
    testFailText: 'Failed',
    backendDown: 'No response from the background — reopen this page',
    cacheCleared: 'Cache cleared',
    switchedToFree: 'Switched back to the free provider',
    exported: 'Exported (the file contains your key — delete it when done)',
    exportFail: 'Export failed: {e}',
    imported: 'Imported — reload open pages to apply',
    importFail: 'Import failed: not a valid settings file ({e})',
    rateUpdated: 'FX rates updated {date} ({source}), refreshed once a day.',
    rateFail: 'FX rates unavailable right now (offline or the service is down) — conversion paused.',

    // ---- 服务商说明 ----
    noteMymemory: 'No key · works without a proxy in China · 5,000 words/day (start here)',
    noteGoogle: 'No key · stable quality · needs a proxy in China',
    noteLlm: 'Pay per use · Qwen flash from ¥0.15 per million tokens, a page costs a fraction of a cent',
    presetCustom: 'Custom (enter manually)',
    presetDeepseek: 'DeepSeek · deepseek-flash',
    presetQwen: 'Qwen · qwen-flash (cheapest)',
    presetGlm: 'Zhipu GLM · glm-5.3-flash',
    presetMimo: 'Xiaomi MiMo · mimo-v2.6-flash',
    presetSiliconflow: 'SiliconFlow · Qwen2.5-7B',
    presetOllama: 'Local Ollama · qwen2.5:7b'
  }
};

/** 当前界面语言：zh / en */
export function uiLang() {
  let raw = '';
  try {
    raw = (chrome && chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || '';
  } catch { /* 忽略 */ }
  if (!raw) raw = (typeof navigator !== 'undefined' && navigator.language) || 'zh';
  return /^zh/i.test(raw) ? 'zh' : 'en';
}

/** 取一条文案，{name} 会被 vars 里的值替换 */
export function t(key, vars) {
  const dict = DICT[uiLang()] || DICT.zh;
  let s = dict[key];
  if (s == null) s = DICT.zh[key];
  if (s == null) return key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

/** 把 HTML 里带 data-i18n* 的元素按当前语言填好 */
export function applyI18n(root = document) {
  const lang = uiLang();
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    el.innerHTML = t(el.dataset.i18nHtml);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of root.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }
}
