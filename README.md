# SnapMark — 截图 AI 助手

> 浏览器插件（Chrome MV3 / Edge / 任何 Chromium 内核）。截图之后，把图直接交给 AI：**提取文字、解释报错、翻译、转 Markdown 表格、识别代码**。当然也保留了完整的箭头 / 矩形 / 马赛克 / 画笔标注能力。

截图工具满地都是，但截完图之后的事情基本没人管：图里的文字复制不出来、报错看不懂、外语页面读不了、表格只能手抄。SnapMark 解决的是**截图之后**的问题。

## ✨ AI 功能

截图完成后，工具栏第一组就是 AI 任务，点一下即出结果（流式输出，边生成边显示）：

| 任务 | 用途 |
| --- | --- |
| 🔤 **提取文字** | 图片 OCR，保留原始换行和缩进，可一键复制 |
| 💡 **解释一下** | 看懂截图内容；如果图里有报错/异常，直接给出原因和修复步骤 |
| 🌐 **翻译成中文** | 外语网页、图片内文字即截即译（原文是中文则译成英文） |
| 📊 **转表格** | 网页表格 / 列表 → 标准 Markdown 表格，可直接粘进文档 |
| 💻 **识别代码** | 截图里的代码转成可复制代码块，并修正 OCR 字符误识别 |
| ♿ **写图片描述** | 生成适合 `alt` 属性的无障碍描述 |
| 💬 **自由提问** | 对着这张图随便问，`Enter` 发送 |

结果面板支持：**📋 复制**、**➕ 把回答写回图片**（作为文字标注）、**↻ 重新生成**。

> 💡 小技巧：先用**箭头或矩形**圈出重点，再点 AI 按钮 —— 标注会和图一起发给模型，回答更聚焦。

### 支持的模型

任何兼容 OpenAI `/chat/completions` 接口的**视觉模型**都能用。设置页内置了一键填充：

OpenAI (gpt-4o-mini) · DeepSeek · 阿里通义千问 (qwen-vl-max) · Moonshot Kimi · 智谱 GLM (glm-4v-flash **有免费额度**) · 硅基流动 · 本地 Ollama (llava，完全离线免费)

**隐私**：API Key 只存在本机 `chrome.storage.local`，不会同步上云，也不会回传给页面脚本；图片只发往你自己填写的服务商地址。

## 📸 截图功能

### 基础
| 功能 | 说明 |
| --- | --- |
| 区域截图 | 鼠标拖拽选取，显示选区尺寸 (如 `800×600`) |
| 整页截图 | 滚动分段截图 + Canvas 拼接成长图 |
| 标注工具 | 箭头（颜色/粗细）、矩形框、文字（字号/颜色）、马赛克、自由画笔 |
| 撤销/重做 | `Ctrl+Z` / `Ctrl+Shift+Z` |
| 导出 | 复制到剪贴板、下载 PNG、下载 JPEG（可调质量） |

### 进阶
| 功能 | 说明 |
| --- | --- |
| 元素级截图 | 悬停高亮 DOM 元素边界，Click 精确截取（`getBoundingClientRect`） |
| 序号标注 | 自动给标注点加 1, 2, 3... 序号 |
| 记住设置 | `chrome.storage` 持久化画笔颜色/粗细/字号 |
| 长页面滚动拼接 | 逐段截图 → Canvas 垂直拼接成一张长图 |

### 细节
- 8 个拖拽手柄支持选区微调
- 工具栏智能避让（选区下方空间不足时自动放到上方）
- 整页长图自动等比缩放到视口内预览，标注坐标不失真
- 发给 AI 前图片自动压缩到长边 1600px，省 token 也更快
- 文件名自动包含 `网页标题_时间戳.png`

## 📦 项目结构

```
SnapMark/
├── manifest.json              # Chrome MV3 manifest
├── background.js              # Service Worker：消息路由 / AI 流式引擎 / 下载 / 截图节流
├── content/
│   ├── content.js             # 核心：Canvas Overlay / 选区 / 标注 / 拼接 / AI 面板
│   └── content.css            # 截图层 / 工具栏 / AI 面板样式
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js               # 弹出窗口 UI（启动各种截图模式）
├── options/
│   ├── options.html
│   ├── options.css
│   └── options.js             # AI 设置页：Base URL / API Key / 模型 / 连通性测试
├── icons/
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   └── icon-128.png
├── tools/
│   ├── make_icons.py          # 重新生成图标的脚本（无外部依赖）
│   └── verify_v2.py           # 自检脚本：括号平衡 / 消息链路 / AI 接线 / DOM id
├── test-page.html             # 本地测试页面
└── README.md
```

## 🚀 安装与运行

### 方式一：开发者模式加载（推荐用于试用）

1. 打开 Chrome / Edge，地址栏输入 `chrome://extensions/`（Edge 用 `edge://extensions/`）
2. 打开右上角 **"开发者模式"** 开关
3. 点击 **"加载已解压的扩展程序"**
4. 选择本目录（`SnapMark/` 所在文件夹）
5. 首次安装会自动打开**设置页**，填入你的 API Key 并点「测试连接」

> 只想用截图标注、不用 AI？跳过设置即可，截图功能不受影响。

### 方式二：打包成 .crx / 上架

1. 在扩展管理页点击 **"打包扩展程序"**
2. 选择 `SnapMark/` 文件夹，生成 `.crx` 即可分发

## ⌨️ 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Alt+Shift+A` | 截图并直接问 AI |
| `Alt+Shift+S` | 区域截图 |
| `Alt+Shift+F` | 整页截图 |
| `Esc` | 取消 / 关闭 |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做标注 |

想改快捷键：`chrome://extensions/shortcuts`（Edge 为 `edge://extensions/shortcuts`）。

## 🎯 使用说明

### 启动截图

- 点击工具栏的 ✨ **SnapMark 图标** → 弹出窗口 → 选一种模式（或用上面的快捷键）
- 鼠标变成十字光标，在页面上**拖拽**框选区域
- 释放鼠标后弹出工具栏，第一组就是 AI 任务

### AI 流程

1. （可选）先用箭头/矩形圈出重点
2. 点一个 AI 任务按钮，或点「💬 自由提问」输入问题
3. 结果流式显示在右侧面板，可复制 / 写回图片 / 重新生成

### 标注流程

| 按钮 | 功能 |
| --- | --- |
| ➤ 箭头 | 单击起点 → 拖拽 → 释放（带颜色/粗细） |
| ▭ 矩形 | 单击起点 → 拖拽 → 释放 |
| T 文字 | 单击位置 → 输入文字 → 回车确认 |
| ▦ 马赛克 | 单击起点 → 拖拽选区 → 释放（自动像素化） |
| ✎ 画笔 | 自由涂抹 |
| ¹²³ 序号 | 下一个标注自动加递增序号 |
| ↶ 撤销 / ↷ 重做 | 也可用 `Ctrl+Z` / `Ctrl+Shift+Z` |
| ✕ 取消 | 放弃当前截图 |

### 导出

- **📋 复制**：写入剪贴板，可直接 `Ctrl+V` 粘贴到微信/钉钉/PS
- **⤓ PNG**：无损下载
- **⤓ JPEG**：可调质量（默认 0.92）

### 整页截图

- 弹出窗口 → **"整页截图"**：自动滚动拼接整张长图
- 提示：会自动触发滚动，请勿手动操作页面

### 元素级截图

1. 点击工具栏的 **"元素截图"** 按钮
2. 鼠标悬停时页面元素会被蓝色边框高亮
3. 单击目标元素 → 直接进入标注界面

## 🔧 技术要点

- **Canvas Overlay**：全屏 `position:fixed` Canvas，绘制选区 / 标注，不污染页面 DOM
- **选区拖拽**：`mousedown` 记录起点 → `mousemove` 实时绘制 → `mouseup` 固定
- **标注图层**：每个标注是一个对象 `{type, x, y, w, h, ...}`，存于数组，支持 `Ctrl+Z` 撤销栈
- **马赛克实现**：`ctx.getImageData` → 块状降采样 → `ctx.putImageData`
- **长页面拼接**：`window.scrollTo` + 视口截图 → 离屏 Canvas 垂直拼接
- **持久化**：`chrome.storage.sync` 存标注偏好，`chrome.storage.local` 存 AI 配置
- **剪贴板**：`navigator.clipboard.write([new ClipboardItem({'image/png': blob})])`
- **下载**：`chrome.downloads.download({url: dataURL, filename})`

### AI 链路

- **请求必须发自 background**：content script 里 `fetch` 会被目标页面的 CSP 拦截，所以 AI 请求全部在 service worker 里发出
- **流式输出**：`chrome.runtime.connect` 建长连接 port，background 解析 SSE（`data:` 分块）后逐 token `postMessage` 回页面，实现打字机效果；`AbortController` 支持中断
- **截图节流**：`chrome.tabs.captureVisibleTab` 有每秒调用上限，整页截图会连续调用，因此串行化 + 550ms 最小间隔 + 限流退避重试
- **图片预处理**：发给模型前等比缩到长边 1600px 并转 JPEG，显著降低 token 消耗和延迟
- **Markdown 渲染**：模型输出**不用** `innerHTML` 拼接，全部走 `createElement` + `textContent`，避免 XSS
- **Key 安全**：API Key 存 `storage.local`（不参与账号同步），`getAIConfig` 只回传"是否已配置"布尔值，绝不下发给 content script

## 🧪 本地测试

打开 `test-page.html`（一个内置丰富元素的测试页面）：

```bash
# 双击打开 test-page.html，或
start SnapMark\test-page.html
```

页面包含：图片、文字、按钮、SVG、表格、长文等，方便测试各种截图场景。

## ⚠️ 已知限制

- **chrome:// / 扩展商店 / PDF 页面** 等受保护页面无法注入 content script（浏览器硬限制）
- **iframe 跨域** 元素无法高亮（仅能截取顶层页面）
- **整页超长**：受 Canvas 最大尺寸限制，超过 16384px 的页面只截取前 16384px（会有提示）
- **AI 需自备 API Key**，且必须是**支持图片输入的视觉模型**（纯文本模型如 `deepseek-chat` 会报错）
- **马赛克遇跨域图片**：`getImageData` 被 CORS 阻止时会退化为半透明灰块

## 🧰 自检

改完代码想确认没写坏，跑一下自检脚本（纯标准库，无需装任何依赖）：

```bash
python tools/verify_v2.py
```

会检查：括号平衡、未定义函数调用、manifest 引用的文件是否存在、快捷键三处文案是否一致、
`sendMessage` 的 action 是否都有对应处理、DOM id 是否对得上、`cleanup()` 是否漏删元素、
AI 链路（预设 key / port 名 / 流式消息类型）是否对齐、API Key 是否有泄露风险。

## 📝 版本

### v2.0.0 — 从"截图标注器"变成"截图 AI 助手"

**新增**
- 6 个 AI 预设任务：提取文字 / 解释一下 / 翻译 / 转表格 / 识别代码 / 写图片描述
- 自由提问：对着截图随便问，流式输出
- AI 结果面板：复制、把回答写回图片、重新生成
- 设置页：7 家服务商一键填充、显示/隐藏 Key、连通性测试（含针对 401/403/404/429 的具体诊断）
- 新快捷键 `Alt+Shift+A`：截图后直接展开 AI 提问

**修复 v1 的 4 个 bug**
- `resizeSelection()` 引用了 `bindSelection()` 的局部变量 `origSelection` → 拖动 8 个手柄必然抛 `ReferenceError`
- 引导画布与标注画布共用 `id="snapmark-canvas"` → `$()` 取错元素，且 `cleanup()` 只删得掉一个，另一个残留在页面上
- 整页截图循环调用 `captureVisibleTab` 无节流 → 必定触发 Chrome 每秒调用上限而失败
- 快捷键三处文案不一致（`popup` 写 `Alt`+`S`、`manifest` 注册 `Ctrl`+`Shift`+`S`、`README` 写 `Alt+Shift+S`）

**其他改进**
- 整页长图自动等比缩放到视口内预览（原来会撑出屏幕无法操作）
- 整页拼接改用每段真实 `scrollY` 偏移 + 从截图宽度反推 DPR，修正拼接错位
- 超长页面加 Canvas 尺寸上限保护（原来会得到一张全空白图）
- 工具栏智能避让，不再固定贴在选区顶部遮挡内容
- 清理了 3 段从未被触发的死代码消息监听器
- 新增 `tools/verify_v2.py` 自检脚本（22 项检查）

### v1.0.0
首发版本，包含所有核心 / 进阶 / 细节功能