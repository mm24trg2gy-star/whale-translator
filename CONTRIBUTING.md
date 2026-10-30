# 参与贡献

谢谢愿意搭把手。这个项目很小，规则也简单。

## 先跑起来

```bash
npm test               # 单测 + 后台链路（不需要浏览器）
npm run test:browser   # 端到端：真的装扩展、翻页面、查 DOM
```

浏览器测试需要 **Edge / Chromium / Chrome for Testing**（Google Chrome 137+ 禁用了 `--load-extension`）。
脚本会自动找常见安装路径，找不到就用环境变量指定：

```bash
# Windows
set WT_BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
# macOS / Linux
WT_BROWSER=/usr/bin/chromium npm run test:browser
```

## 代码地图

| 文件 | 职责 |
| --- | --- |
| `src/lib.js` | 纯函数：设置合并、语言判断、切片、JSON 解析、金额换算 |
| `src/background.js` | 后台：接口调度、缓存、限速、额度兜底、汇率 |
| `src/content.js` | 页面侧：找段落、批量翻译、渲染、划词卡片（Shadow DOM） |
| `src/options.*` / `src/popup.*` | 设置页 / 工具栏面板 |

改逻辑优先往 `lib.js` 放纯函数，配一条单测；碰 DOM 的改动请顺手补一条 `tests/smoke.mjs` 的断言。

## 提交前

1. `npm test` 全绿
2. 改了页面行为的话，`npm run test:browser` 也跑一遍
3. **确认没有把密钥提交上去**：`git status` 里不该出现 `key.local.json`、`*.pem`、`keys/`

## 不要提交的东西

- `key.local.json`（本机内置 Key）
- `keys/`、`*.pem`、`*.key`
- `dist/` 构建产物

## 提 PR

- 一个 PR 只做一件事，标题写清楚「修什么 / 加什么」
- 说明里带上复现步骤（哪个网站、什么操作、期望 vs 实际）
- 改 UI 的话附一张截图

## 协议

提交的代码按 [MIT](LICENSE) 授权。
