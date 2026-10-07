// SnapMark Popup Script
// 处理 popup 按钮和设置

const DEFAULT_SETTINGS = {
  color: '#ff3b30',
  strokeWidth: 3,
  fontSize: 18,
  fontColor: '#ffffff',
  showNumbering: false,
  jpegQuality: 0.92
};

let saveTimeout = null;

function debouncedSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveSettings, 300);
}

function saveSettings() {
  const settings = {
    color: document.getElementById('setting-color').value,
    strokeWidth: parseInt(document.getElementById('setting-stroke').value, 10),
    fontSize: parseInt(document.getElementById('setting-fontsize').value, 10) || 18,
    jpegQuality: parseFloat(document.getElementById('setting-quality').value),
    showNumbering: document.getElementById('setting-numbering').checked
  };
  chrome.storage.sync.set(settings);
}

function loadSettings() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    document.getElementById('setting-color').value = settings.color;
    document.getElementById('setting-stroke').value = settings.strokeWidth;
    document.getElementById('setting-stroke-val').textContent = settings.strokeWidth;
    document.getElementById('setting-fontsize').value = settings.fontSize;
    document.getElementById('setting-quality').value = settings.jpegQuality;
    document.getElementById('setting-quality-val').textContent = settings.jpegQuality;
    document.getElementById('setting-numbering').checked = settings.showNumbering;
  });
}

async function activateScreenshot(mode, opts) {
  saveSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    alert('无法找到当前标签页');
    return;
  }
  // 浏览器内置页面禁止注入脚本，提前给出明确提示
  if (/^(chrome|edge|about|devtools|chrome-extension|moz-extension):/i.test(tab.url || '')) {
    alert('浏览器内置页面无法截图，请在普通网页上使用。');
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'startScreenshot', mode, opts: opts || {} });
  } catch (err) {
    // content script 可能还没注入，尝试通过 background 注入
    try {
      await chrome.runtime.sendMessage({ action: 'activateScreenshot', mode, opts: opts || {} });
    } catch (err2) {
      alert('请刷新页面后重试');
      return;
    }
  }
  window.close();
}

// 检查 AI 是否已配置，未配置则显示提示条
async function checkAIConfig() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getAIConfig' });
    const configured = res && res.config && res.config.configured;
    const banner = document.getElementById('ai-banner');
    if (!configured) banner.classList.remove('hidden');
    else banner.classList.add('hidden');
  } catch (err) {
    /* background 未就绪时忽略 */
  }
}

function openOptions() {
  chrome.runtime.openOptionsPage();
  window.close();
}

// 绑定按钮事件
document.getElementById('btn-ai').addEventListener('click', () => activateScreenshot('region', { autoAI: true }));
document.getElementById('btn-region').addEventListener('click', () => activateScreenshot('region'));
document.getElementById('btn-fullpage').addEventListener('click', () => activateScreenshot('fullpage'));
document.getElementById('btn-element').addEventListener('click', () => activateScreenshot('element'));
document.getElementById('btn-options').addEventListener('click', openOptions);
document.getElementById('btn-setup').addEventListener('click', openOptions);

// 绑定设置事件
document.getElementById('setting-color').addEventListener('input', debouncedSave);
document.getElementById('setting-stroke').addEventListener('input', (e) => {
  document.getElementById('setting-stroke-val').textContent = e.target.value;
  debouncedSave();
});
document.getElementById('setting-fontsize').addEventListener('change', debouncedSave);
document.getElementById('setting-quality').addEventListener('input', (e) => {
  document.getElementById('setting-quality-val').textContent = e.target.value;
  debouncedSave();
});
document.getElementById('setting-numbering').addEventListener('change', debouncedSave);

// 初始化
loadSettings();
checkAIConfig();