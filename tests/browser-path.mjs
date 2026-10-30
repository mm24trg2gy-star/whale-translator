// 找一个 Chromium 系浏览器来跑端到端测试。
// 优先用环境变量 WT_BROWSER，其次按平台找常见安装路径。
//
// 注意：Google Chrome 137+ 的品牌版禁用了 --load-extension，
// 所以默认优先 Edge / Chromium；Chrome for Testing 也可以。
import fs from 'node:fs';

const CANDIDATES = {
  win32: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome for Testing\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ],
  darwin: [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ],
  linux: [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/snap/bin/chromium'
  ]
};

export function resolveBrowser() {
  if (process.env.WT_BROWSER) return process.env.WT_BROWSER;
  const list = CANDIDATES[process.platform] || [];
  for (const p of list) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* 继续找 */ }
  }
  throw new Error(
    '没找到可用的 Chromium 系浏览器。请安装 Edge / Chromium，或用 WT_BROWSER 指定路径：\n' +
    '  Windows: set WT_BROWSER=C:\\path\\to\\msedge.exe && npm run test:browser\n' +
    '  macOS/Linux: WT_BROWSER=/path/to/chromium npm run test:browser\n' +
    '（Google Chrome 137+ 不支持 --load-extension，请用 Edge / Chromium / Chrome for Testing）'
  );
}
