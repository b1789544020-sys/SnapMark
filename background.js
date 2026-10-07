// SnapMark Background Service Worker
// 处理截图请求、消息路由、设置存储、AI 视觉分析

// ========== 默认设置 ==========
const DEFAULT_SETTINGS = {
  color: '#ff3b30',
  strokeWidth: 3,
  fontSize: 18,
  fontColor: '#ffffff',
  showNumbering: false,
  jpegQuality: 0.92
};

// AI 配置存 storage.local（不用 sync，避免 API Key 被同步上云）
const DEFAULT_AI_CONFIG = {
  aiBaseUrl: 'https://api.openai.com/v1',
  aiApiKey: '',
  aiModel: 'gpt-4o-mini',
  aiTemperature: 0.2,
  aiMaxTokens: 2000,
  aiCustomPrompt: ''
};

// ========== AI 预设任务 ==========
// 每个预设 = 一个 system prompt + 一句 user 指令
const AI_PRESETS = {
  ocr: {
    label: '提取文字',
    system: '你是一个精准的 OCR 引擎。只输出图片中的文字内容本身，不要添加任何解释、前言或 Markdown 代码块包裹。严格保留原始的换行、缩进和段落结构。如果图片中没有文字，只回复：（未检测到文字）',
    user: '提取这张图片中的所有文字。'
  },
  explain: {
    label: '解释一下',
    system: '你是一位资深的技术专家和产品顾问。用简体中文回答，语言精炼、直接、有条理，多用短句和列表。不要说客套话。',
    user: '看这张截图，告诉我：1) 这是什么；2) 关键信息是什么；3) 如果里面有报错、异常或问题，指出原因并给出具体的修复步骤。'
  },
  translate: {
    label: '翻译成中文',
    system: '你是专业翻译。把内容翻译成自然流畅的简体中文，保持原文的段落和排版结构。只输出译文，不要输出原文，不要加解释。如果原文已经是中文，则翻译成英文。',
    user: '翻译这张图片里的所有文字。'
  },
  table: {
    label: '转表格',
    system: '你是数据提取专家。把图片中的表格/列表数据转换为标准 Markdown 表格。只输出表格本身，不要任何额外说明。数字保持原样，不要自行计算或修改。',
    user: '把这张图片里的数据整理成 Markdown 表格。'
  },
  code: {
    label: '识别代码',
    system: '你是代码识别专家。从图片中提取代码，修正明显的 OCR 字符误识别（如 l/1、O/0、;/：），并用正确语言标记的 Markdown 代码块输出。只输出代码块，不要解释。',
    user: '提取这张图片里的代码。'
  },
  alt: {
    label: '写图片描述',
    system: '你是无障碍专家。用一句简洁准确的简体中文描述图片内容，适合用作 HTML alt 属性。不超过 100 字，只输出描述文本本身。',
    user: '为这张图片写一段 alt 描述。'
  }
};

// ========== 快捷键 ==========
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (command === 'take-screenshot') {
    activateScreenshot(tab.id, 'region');
  } else if (command === 'take-fullpage') {
    activateScreenshot(tab.id, 'fullpage');
  } else if (command === 'take-ai') {
    // 截图后直接进入 AI 提问
    activateScreenshot(tab.id, 'region', { autoAI: true });
  }
});

// ========== 消息路由 ==========
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender).then(sendResponse).catch((err) => {
    sendResponse({ error: err.message });
  });
  return true; // 保持消息通道开放以支持异步响应
});

async function handleMessage(request, sender) {
  switch (request.action) {
    case 'activateScreenshot': {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab) throw new Error('No active tab');
      await activateScreenshot(tab.id, request.mode || 'region', request.opts);
      return { success: true };
    }

    case 'captureVisibleTab': {
      // content 脚本请求截取当前标签页（已做频率节流）
      const tabId = sender.tab
        ? sender.tab.id
        : ((await chrome.tabs.query({ active: true, currentWindow: true }))[0] || {}).id;
      if (!tabId) throw new Error('No active tab');
      const dataUrl = await captureThrottled(tabId);
      return { dataUrl };
    }

    case 'downloadImage':
      return await downloadImage(request.dataUrl, request.filename);

    case 'getSettings': {
      const result = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      return { settings: result };
    }

    case 'saveSettings':
      await chrome.storage.sync.set(request.settings);
      return { success: true };

    case 'getAIConfig': {
      const cfg = await chrome.storage.local.get(DEFAULT_AI_CONFIG);
      // 不把完整 key 回传给 content script，只回传是否已配置
      return {
        config: {
          aiBaseUrl: cfg.aiBaseUrl,
          aiModel: cfg.aiModel,
          aiCustomPrompt: cfg.aiCustomPrompt,
          configured: !!(cfg.aiApiKey && cfg.aiApiKey.trim())
        },
        presets: Object.fromEntries(
          Object.entries(AI_PRESETS).map(([k, v]) => [k, { label: v.label }])
        )
      };
    }

    case 'saveAIConfig':
      await chrome.storage.local.set(request.config);
      return { success: true };

    case 'testAIConnection':
      return await testAIConnection(request.config);

    case 'openOptions':
      chrome.runtime.openOptionsPage();
      return { success: true };

    default:
      throw new Error('Unknown action: ' + request.action);
  }
}

// ========== captureVisibleTab 节流 ==========
// Chrome 限制每秒调用次数（MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND），
// 整页截图会连续调用，必须串行 + 保持最小间隔，否则直接抛错。
const CAPTURE_MIN_INTERVAL = 550;
let lastCaptureAt = 0;
let captureChain = Promise.resolve();

function captureThrottled(tabId) {
  const run = async () => {
    const wait = CAPTURE_MIN_INTERVAL - (Date.now() - lastCaptureAt);
    if (wait > 0) await sleep(wait);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tabId, { format: 'png' });
        lastCaptureAt = Date.now();
        return dataUrl;
      } catch (err) {
        const msg = String(err && err.message || err);
        // 触发限流则退避重试
        if (/MAX_CAPTURE|quota|rate/i.test(msg) && attempt < 2) {
          await sleep(CAPTURE_MIN_INTERVAL * (attempt + 1));
          continue;
        }
        throw new Error('截图失败: ' + msg);
      }
    }
    throw new Error('截图失败: 超出调用频率限制');
  };

  // 串到同一条链上，保证严格串行
  const result = captureChain.then(run, run);
  captureChain = result.catch(() => {});
  return result;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}


// ========== AI 流式引擎 ==========
// 必须在 background 里发请求：content script 里 fetch 会被目标页面的 CSP 拦截。
// 用长连接 port 把 token 一段段推回 content script，实现打字机效果。
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'snapmark-ai') return;

  const controller = new AbortController();
  let closed = false;

  port.onDisconnect.addListener(() => {
    closed = true;
    controller.abort();
  });

  const post = (msg) => {
    if (closed) return;
    try { port.postMessage(msg); } catch (e) { /* port 已关闭 */ }
  };

  port.onMessage.addListener(async (req) => {
    if (req.type === 'abort') {
      closed = true;
      controller.abort();
      return;
    }
    if (req.type !== 'ask') return;

    try {
      await streamAI(req, post, controller.signal);
    } catch (err) {
      if (err.name === 'AbortError') {
        post({ type: 'aborted' });
      } else {
        post({ type: 'error', message: err.message });
      }
    }
  });
});

async function streamAI(req, post, signal) {
  const cfg = await chrome.storage.local.get(DEFAULT_AI_CONFIG);

  if (!cfg.aiApiKey || !cfg.aiApiKey.trim()) {
    throw new Error('尚未配置 API Key，请点击「⚙ 设置」填写');
  }

  // 组装 prompt：预设任务 或 用户自由提问
  let systemPrompt;
  let userPrompt;
  if (req.preset && AI_PRESETS[req.preset]) {
    systemPrompt = AI_PRESETS[req.preset].system;
    userPrompt = AI_PRESETS[req.preset].user;
  } else {
    systemPrompt = '你是一个能看图的智能助手。用简体中文回答，简洁准确，不说废话。';
    userPrompt = req.question || '描述这张图片。';
  }
  // 用户在设置里填的全局附加要求
  if (cfg.aiCustomPrompt && cfg.aiCustomPrompt.trim()) {
    systemPrompt += '\n\n附加要求：' + cfg.aiCustomPrompt.trim();
  }
  // 带上页面上下文，让回答更贴合场景
  if (req.pageContext) {
    userPrompt += `\n\n（截图来自网页「${req.pageContext.title || ''}」${req.pageContext.url ? ' ' + req.pageContext.url : ''}）`;
  }

  const body = {
    model: cfg.aiModel || 'gpt-4o-mini',
    stream: true,
    temperature: Number(cfg.aiTemperature) || 0.2,
    max_tokens: Number(cfg.aiMaxTokens) || 2000,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          { type: 'image_url', image_url: { url: req.imageDataUrl, detail: 'high' } }
        ]
      }
    ]
  };

  const endpoint = String(cfg.aiBaseUrl || '').replace(/\/+$/, '') + '/chat/completions';

  post({ type: 'start', model: body.model });

  const res = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + cfg.aiApiKey.trim()
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    let detail = '';
    try {
      const errJson = await res.json();
      detail = (errJson.error && (errJson.error.message || errJson.error.code)) || JSON.stringify(errJson).slice(0, 300);
    } catch (e) {
      detail = await res.text().catch(() => '');
      detail = detail.slice(0, 300);
    }
    throw new Error(`接口返回 ${res.status}${detail ? '：' + detail : ''}`);
  }

  // 逐块解析 SSE
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // 最后一行可能不完整，留到下一轮

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;

      try {
        const json = JSON.parse(payload);
        const choice = json.choices && json.choices[0];
        if (!choice) continue;
        // 兼容 OpenAI / DeepSeek / 通义 / Kimi 等 delta 格式
        const delta = choice.delta || {};
        const piece = delta.content || (choice.message && choice.message.content) || '';
        if (piece) {
          full += piece;
          post({ type: 'delta', text: piece });
        }
      } catch (e) {
        // 单块解析失败不中断整个流
      }
    }
  }

  post({ type: 'done', text: full });
}

// 设置页的连通性测试：发一张 1x1 图，最省 token
async function testAIConnection(inputCfg) {
  const stored = await chrome.storage.local.get(DEFAULT_AI_CONFIG);
  const cfg = Object.assign({}, stored, inputCfg || {});

  if (!cfg.aiApiKey || !cfg.aiApiKey.trim()) {
    return { ok: false, message: '请先填写 API Key' };
  }

  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const endpoint = String(cfg.aiBaseUrl || '').replace(/\/+$/, '') + '/chat/completions';

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.aiApiKey.trim()
      },
      body: JSON.stringify({
        model: cfg.aiModel || 'gpt-4o-mini',
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Reply with the single word: ok' },
            { type: 'image_url', image_url: { url: tinyPng } }
          ]
        }]
      })
    });

    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = (j.error && (j.error.message || j.error.code)) || '';
      } catch (e) { /* ignore */ }
      const hints = {
        401: 'API Key 无效或已过期',
        403: '无权访问该模型',
        404: 'Base URL 或模型名不对（注意 Base URL 要以 /v1 结尾）',
        429: '请求过于频繁或余额不足'
      };
      return {
        ok: false,
        message: `${res.status} ${hints[res.status] || '请求失败'}${detail ? '：' + detail : ''}`
      };
    }

    const data = await res.json();
    const reply = data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '').trim()
      : '';
    return {
      ok: true,
      message: `连接成功！模型 ${data.model || cfg.aiModel} 已响应${reply ? '（“' + reply.slice(0, 30) + '”）' : ''}`
    };
  } catch (err) {
    return { ok: false, message: '网络错误：' + err.message + '（检查 Base URL 是否可访问）' };
  }
}

// ========== 截图激活 ==========
async function activateScreenshot(tabId, mode, opts) {
  try {
    // 先注入/确保 content 脚本存在
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/content.css']
    });

    // 发送激活消息
    await chrome.tabs.sendMessage(tabId, {
      action: 'startScreenshot',
      mode: mode,
      opts: opts || {}
    });
  } catch (err) {
    console.error('SnapMark: Failed to activate screenshot', err);
  }
}

async function downloadImage(dataUrl, filename) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const pageTitle = (await getCurrentTabTitle()).slice(0, 30).replace(/[\\/:*?"<>|]/g, '_');
  const finalName = filename || `snapmark_${pageTitle}_${ts}.png`;

  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: `SnapMark/${finalName}`,
    saveAs: false,
    conflictAction: 'uniquify'
  });

  return { success: true, downloadId, filename: finalName };
}

async function getCurrentTabTitle() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.title : 'webpage';
}

// 安装时初始化默认设置，首次安装打开设置页引导填 Key
chrome.runtime.onInstalled.addListener(async (details) => {
  const current = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...current });

  const localCur = await chrome.storage.local.get(null);
  await chrome.storage.local.set({ ...DEFAULT_AI_CONFIG, ...localCur });

  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
  console.log('SnapMark v2 installed.');
});