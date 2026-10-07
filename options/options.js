// SnapMark 设置页逻辑
// AI 配置存 chrome.storage.local（不同步，避免 API Key 上云）

const DEFAULTS = {
  aiBaseUrl: 'https://api.openai.com/v1',
  aiApiKey: '',
  aiModel: 'gpt-4o-mini',
  aiTemperature: 0.2,
  aiMaxTokens: 2000,
  aiCustomPrompt: ''
};

// 常见服务商的 Base URL + 推荐视觉模型
const PRESETS = {
  openai:       { aiBaseUrl: 'https://api.openai.com/v1',                        aiModel: 'gpt-4o-mini' },
  deepseek:     { aiBaseUrl: 'https://api.deepseek.com/v1',                      aiModel: 'deepseek-vl' },
  dashscope:    { aiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', aiModel: 'qwen-vl-max' },
  moonshot:     { aiBaseUrl: 'https://api.moonshot.cn/v1',                       aiModel: 'moonshot-v1-8k-vision-preview' },
  zhipu:        { aiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',             aiModel: 'glm-4v-flash' },
  siliconflow:  { aiBaseUrl: 'https://api.siliconflow.cn/v1',                    aiModel: 'Qwen/Qwen2-VL-72B-Instruct' },
  ollama:       { aiBaseUrl: 'http://localhost:11434/v1',                        aiModel: 'llava' }
};

const FIELDS = ['aiBaseUrl', 'aiApiKey', 'aiModel', 'aiTemperature', 'aiMaxTokens', 'aiCustomPrompt'];

const $ = (id) => document.getElementById(id);

function setStatus(cls, msg) {
  const el = $('status');
  el.className = 'status ' + cls;
  el.textContent = msg;
}

function readForm() {
  return {
    aiBaseUrl: $('aiBaseUrl').value.trim(),
    aiApiKey: $('aiApiKey').value.trim(),
    aiModel: $('aiModel').value.trim(),
    aiTemperature: parseFloat($('aiTemperature').value) || 0,
    aiMaxTokens: parseInt($('aiMaxTokens').value, 10) || 2000,
    aiCustomPrompt: $('aiCustomPrompt').value
  };
}

async function load() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  FIELDS.forEach((k) => {
    if ($(k)) $(k).value = cfg[k] !== undefined && cfg[k] !== null ? cfg[k] : '';
  });
}

async function save(showMsg = true) {
  const cfg = readForm();

  if (!cfg.aiBaseUrl) {
    setStatus('err', '请填写 Base URL');
    return false;
  }
  if (!/^https?:\/\//i.test(cfg.aiBaseUrl)) {
    setStatus('err', 'Base URL 必须以 http:// 或 https:// 开头');
    return false;
  }
  if (!cfg.aiModel) {
    setStatus('err', '请填写模型名称');
    return false;
  }

  await chrome.storage.local.set(cfg);
  if (showMsg) setStatus('ok', '✓ 已保存');
  return true;
}

async function test() {
  // 先落盘再测，避免测的是旧配置
  if (!(await save(false))) return;

  setStatus('busy', '正在测试连接…');
  $('test').disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'testAIConnection',
      config: readForm()
    });
    if (res && res.ok) setStatus('ok', '✓ ' + res.message);
    else setStatus('err', '✗ ' + ((res && res.message) || '测试失败'));
  } catch (err) {
    setStatus('err', '✗ ' + err.message);
  } finally {
    $('test').disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  load();

  $('save').addEventListener('click', () => save());
  $('test').addEventListener('click', test);

  // 显示/隐藏 API Key
  $('toggleKey').addEventListener('click', () => {
    const inp = $('aiApiKey');
    const showing = inp.type === 'text';
    inp.type = showing ? 'password' : 'text';
    $('toggleKey').textContent = showing ? '显示' : '隐藏';
  });

  // 服务商快速填充
  $('preset').addEventListener('change', (e) => {
    const p = PRESETS[e.target.value];
    if (!p) return;
    $('aiBaseUrl').value = p.aiBaseUrl;
    $('aiModel').value = p.aiModel;
    setStatus('busy', '已填入 ' + e.target.options[e.target.selectedIndex].text + ' 的地址，请补上 API Key 后保存。');
  });

  // Ctrl+S 保存
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });
});
