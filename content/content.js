// SnapMark Content Script
// 核心功能：Canvas 覆盖层、选区拖拽、标注绘制、撤销重做、导出
// 使用 IIFE 避免污染页面全局变量

(function () {
  'use strict';

  // 防止重复注入
  if (window.__snapmarkActive) {
    // 已经激活则重新触发主流程
    window.dispatchEvent(new CustomEvent('snapmark-restart'));
    return;
  }
  window.__snapmarkActive = true;

  // ========== 状态管理 ==========
  const state = {
    mode: 'region',            // region | fullpage | element
    phase: 'selecting',        // selecting | annotating | done
    selection: null,           // {x, y, w, h}  视口坐标
    screenshot: null,          // ImageBitmap 或 HTMLCanvasElement
    screenshotDpr: 1,          // 截图时 DPR
    annotations: [],           // 标注数组
    history: [],               // 撤销栈
    redoStack: [],             // 重做栈
    currentTool: 'none',       // none | arrow | rect | text | mosaic | pen
    settings: {
      color: '#ff3b30',
      strokeWidth: 3,
      fontSize: 18,
      fontColor: '#ffffff',
      showNumbering: false,
      jpegQuality: 0.92
    },
    isAnnotating: false,
    annotStart: null,
    annotEnd: null,
    currentPenPath: null,
    nextNumber: 1,
    elementHighlight: null,
    // --- v2 AI 相关 ---
    autoAI: false,             // 截完图是否自动展开 AI 面板
    aiConfig: null,            // {aiBaseUrl, aiModel, configured}
    aiPresets: {},             // 预设任务列表
    aiPort: null,              // 与 background 的长连接
    aiStreaming: false,        // 是否正在流式接收
    aiResultText: '',          // 当前 AI 输出的完整文本
    aiLastPreset: null         // 上一次执行的任务，用于「重试」
  };

  // 选区拖拽的共享状态（提到顶层，避免 resizeSelection 取不到）
  let origSelection = null;


  // ========== 工具函数 ==========
  function $(id) { return document.getElementById(id); }
  function createEl(tag, attrs = {}, parent = null) {
    const el = document.createElement(tag);
    for (const k in attrs) {
      if (k === 'style') Object.assign(el.style, attrs[k]);
      else if (k === 'class') el.className = attrs[k];
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(el);
    return el;
  }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function rectFromPoints(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y)
    };
  }

  // ========== 设置加载 ==========
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(state.settings, (result) => {
        state.settings = Object.assign({}, state.settings, result);
        resolve();
      });
    });
  }
  function saveSettings() {
    chrome.storage.sync.set(state.settings);
  }

  // ========== UI 创建 ==========
  let overlay, mask, canvas, ctx, selectionEl, sizeLabel, toolbar;
  let annotationCanvas, annotationCtx;

  function buildUI() {
    // 蒙版
    mask = createEl('div', { id: 'snapmark-mask' });
    document.body.appendChild(mask);

    // 全屏覆盖层（接收鼠标事件）
    overlay = createEl('div', { id: 'snapmark-overlay' });
    document.body.appendChild(overlay);

    // 选区矩形
    selectionEl = createEl('div', { id: 'snapmark-selection' });
    document.body.appendChild(selectionEl);
    selectionEl.style.display = 'none';

    // 8 个手柄
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((pos) => {
      const h = createEl('div', { class: 'snapmark-handle ' + pos });
      h.dataset.handle = pos;
      selectionEl.appendChild(h);
    });

    // 尺寸标签
    sizeLabel = createEl('div', { id: 'snapmark-size-label' });
    document.body.appendChild(sizeLabel);
    sizeLabel.style.display = 'none';

    // 主画布（绘制选区参考线、悬停指示等）
    // 注意：id 与标注画布区分开，否则 $() 会取错元素
    canvas = createEl('canvas', { id: 'snapmark-guide-canvas', class: 'snapmark-canvas-base' });
    document.body.appendChild(canvas);
    resizeCanvas();
    ctx = canvas.getContext('2d');
  }

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
  }

  // ========== 选区交互 ==========
  function bindSelection() {
    let isDrawing = false;
    let isResizing = false;
    let isMoving = false;
    let dragHandle = null;
    let startPt = null;
    let activeElementHover = null;

    function getPoint(e) {
      return {
        x: e.clientX,
        y: e.clientY
      };
    }

    function onMouseMoveHover(e) {
      // 元素高亮模式
      if (state.mode === 'element' && state.phase === 'selecting') {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el && el !== activeElementHover && !isPartOfSnapmark(el)) {
          activeElementHover = el;
          highlightElement(el);
        }
      }
    }

    overlay.addEventListener('mousemove', onMouseMoveHover);

    overlay.addEventListener('mousedown', (e) => {
      if (state.phase !== 'selecting') return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      // 元素模式：直接截取元素
      if (state.mode === 'element' && activeElementHover) {
        captureElement(activeElementHover);
        return;
      }

      isDrawing = true;
      startPt = getPoint(e);
      state.selection = { x: startPt.x, y: startPt.y, w: 0, h: 0 };
      updateSelection();
    });

    document.addEventListener('mousemove', (e) => {
      if (isDrawing && state.phase === 'selecting') {
        const pt = getPoint(e);
        state.selection = rectFromPoints(startPt, pt);
        updateSelection();
      } else if (isResizing && state.phase === 'selecting') {
        resizeSelection(dragHandle, getPoint(e));
        updateSelection();
      } else if (isMoving && state.phase === 'selecting') {
        const dx = e.clientX - startPt.x;
        const dy = e.clientY - startPt.y;
        state.selection.x = origSelection.x + dx;
        state.selection.y = origSelection.y + dy;
        // 边界限制
        state.selection.x = clamp(state.selection.x, -state.selection.w + 20, window.innerWidth - 20);
        state.selection.y = clamp(state.selection.y, -state.selection.h + 20, window.innerHeight - 20);
        updateSelection();
      }
    });

    document.addEventListener('mouseup', (e) => {
      if (isDrawing && state.phase === 'selecting') {
        isDrawing = false;
        if (state.selection.w < 5 || state.selection.h < 5) {
          state.selection = null;
          updateSelection();
          return;
        }
        // 确认选区，进入截图
        confirmSelection();
      } else if (isResizing) {
        isResizing = false;
        dragHandle = null;
      } else if (isMoving) {
        isMoving = false;
      }
    });

    // 手柄拖拽
    selectionEl.addEventListener('mousedown', (e) => {
      if (state.phase !== 'selecting') return;
      const handle = e.target.closest('.snapmark-handle');
      if (handle) {
        e.stopPropagation();
        e.preventDefault();
        isResizing = true;
        dragHandle = handle.dataset.handle;
        startPt = getPoint(e);
        origSelection = { ...state.selection };
      }
    });

    // 选区拖动（在选区中按下并拖动可移动选区）
    selectionEl.addEventListener('mousedown', (e) => {
      if (state.phase !== 'selecting') return;
      if (e.target.classList.contains('snapmark-handle')) return;
      if (!state.selection) return;
      e.stopPropagation();
      e.preventDefault();
      isMoving = true;
      startPt = getPoint(e);
      origSelection = { ...state.selection };
    });

    // Esc 取消
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        cleanup();
      } else if (e.key === 'Enter' && state.phase === 'selecting' && state.selection && state.selection.w > 5) {
        confirmSelection();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && state.phase === 'annotating') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    });
  }

  function isPartOfSnapmark(el) {
    return el.closest && (
      el.closest('#snapmark-overlay') ||
      el.closest('#snapmark-mask') ||
      el.closest('#snapmark-canvas') ||
      el.closest('#snapmark-selection') ||
      el.closest('#snapmark-toolbar') ||
      el.closest('#snapmark-toast') ||
      el.closest('#snapmark-text-input') ||
      el.closest('#snapmark-progress')
    );
  }

  function highlightElement(el) {
    if (state.elementHighlight) {
      state.elementHighlight.remove();
    }
    const r = el.getBoundingClientRect();
    const div = createEl('div', {
      class: 'snapmark-element-highlight',
      style: {
        top: r.top + 'px',
        left: r.left + 'px',
        width: r.width + 'px',
        height: r.height + 'px'
      }
    });
    document.body.appendChild(div);
    state.elementHighlight = div;
  }

  function resizeSelection(handle, pt) {
    const o = origSelection;
    let { x, y, w, h } = o;
    const right = o.x + o.w;
    const bottom = o.y + o.h;
    if (handle.includes('e')) w = pt.x - o.x;
    if (handle.includes('s')) h = pt.y - o.y;
    if (handle.includes('w')) { x = pt.x; w = right - pt.x; }
    if (handle.includes('n')) { y = pt.y; h = bottom - pt.y; }
    if (w < 5) w = 5;
    if (h < 5) h = 5;
    state.selection = { x, y, w, h };
  }

  function updateSelection() {
    if (!state.selection) {
      selectionEl.style.display = 'none';
      sizeLabel.style.display = 'none';
      return;
    }
    const s = state.selection;
    selectionEl.style.display = 'block';
    selectionEl.style.left = s.x + 'px';
    selectionEl.style.top = s.y + 'px';
    selectionEl.style.width = s.w + 'px';
    selectionEl.style.height = s.h + 'px';
    sizeLabel.style.display = 'block';
    sizeLabel.textContent = `${Math.round(s.w)} × ${Math.round(s.h)}`;
    // 标签放在选区右下角
    sizeLabel.style.left = (s.x + s.w) + 'px';
    sizeLabel.style.top = (s.y + s.h + 6) + 'px';
  }

  // ========== 截图核心 ==========
  async function confirmSelection() {
    // 隐藏选区 UI 以免截到自己
    overlay.style.display = 'none';
    mask.style.display = 'none';
    selectionEl.style.display = 'none';
    sizeLabel.style.display = 'none';
    if (state.elementHighlight) state.elementHighlight.style.display = 'none';

    // 短暂延迟让浏览器渲染稳定
    await new Promise(r => setTimeout(r, 50));

    try {
      await captureSelection(state.selection);
    } catch (err) {
      console.error('SnapMark capture error', err);
      showToast('截图失败: ' + err.message);
      cleanup();
    }
  }

  async function captureSelection(sel) {
    // 通过 background 拿到可视区域的 dataURL
    const response = await chrome.runtime.sendMessage({ action: 'captureVisibleTab' });
    if (!response || !response.dataUrl) throw new Error('无法获取页面截图');

    const img = await loadImage(response.dataUrl);
    const dpr = img.width / window.innerWidth;
    state.screenshotDpr = dpr;

    // 根据选区裁剪
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = Math.round(sel.w * dpr);
    cropCanvas.height = Math.round(sel.h * dpr);
    const cropCtx = cropCanvas.getContext('2d');
    cropCtx.drawImage(img,
      Math.round(sel.x * dpr),
      Math.round(sel.y * dpr),
      cropCanvas.width,
      cropCanvas.height,
      0, 0,
      cropCanvas.width,
      cropCanvas.height
    );

    state.screenshot = cropCanvas;
    state.selection = sel;
    state.phase = 'annotating';
    showAnnotationUI();
  }

  async function captureElement(el) {
    // 元素模式：先隐藏所有 SnapMark UI，再截图
    const r = el.getBoundingClientRect();
    overlay.style.display = 'none';
    mask.style.display = 'none';
    if (state.elementHighlight) state.elementHighlight.style.display = 'none';
    selectionEl.style.display = 'none';
    sizeLabel.style.display = 'none';

    await new Promise(res => setTimeout(res, 50));
    try {
      const response = await chrome.runtime.sendMessage({ action: 'captureVisibleTab' });
      if (!response || !response.dataUrl) throw new Error('无法获取页面截图');
      const img = await loadImage(response.dataUrl);
      const dpr = img.width / window.innerWidth;
      state.screenshotDpr = dpr;

      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = Math.round(r.width * dpr);
      cropCanvas.height = Math.round(r.height * dpr);
      const cropCtx = cropCanvas.getContext('2d');
      cropCtx.drawImage(img,
        Math.round(r.left * dpr),
        Math.round(r.top * dpr),
        cropCanvas.width,
        cropCanvas.height,
        0, 0,
        cropCanvas.width,
        cropCanvas.height
      );
      state.screenshot = cropCanvas;
      state.selection = { x: r.left, y: r.top, w: r.width, h: r.height };
      state.phase = 'annotating';
      showAnnotationUI();
    } catch (err) {
      console.error(err);
      showToast('元素截图失败: ' + err.message);
      cleanup();
    }
  }

  async function captureFullPage() {
    overlay.style.display = 'none';
    mask.style.display = 'none';

    await new Promise(r => setTimeout(r, 50));

    const totalHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    const totalWidth = Math.max(
      document.body.scrollWidth,
      document.documentElement.scrollWidth
    );
    const viewportHeight = window.innerHeight;
    const originalScrollY = window.scrollY;

    // Canvas 有最大面积限制，超长页面必须限高，否则得到全空白图
    const MAX_CANVAS_PIXELS = 16384;
    const cappedHeight = Math.min(totalHeight, MAX_CANVAS_PIXELS);
    if (cappedHeight < totalHeight) {
      showToast(`页面过长，仅截取前 ${cappedHeight}px`);
    }

    showProgress('长页面截图中...', 0);

    // 逐段滚动截图（background 已做频率节流，这里不会触发限流）
    const segments = [];
    const overlap = 40; // 重叠像素，避免拼接缝隙
    const step = Math.max(100, viewportHeight - overlap);
    let dpr = window.devicePixelRatio || 1;
    let curY = 0;

    while (curY < cappedHeight) {
      window.scrollTo(0, curY);
      // 等滚动稳定 + 懒加载图片补齐
      await new Promise(r => setTimeout(r, 250));
      const actualY = window.scrollY;   // 页面可能滚不到目标位置（已到底）

      const response = await chrome.runtime.sendMessage({ action: 'captureVisibleTab' });
      if (!response || !response.dataUrl) {
        throw new Error((response && response.error) || '截图失败');
      }
      const img = await loadImage(response.dataUrl);
      // 用真实截图宽度反推 dpr，比 devicePixelRatio 可靠
      dpr = img.width / window.innerWidth;
      segments.push({ y: actualY, img });

      showProgress('长页面截图中...', Math.min(1, (curY + viewportHeight) / cappedHeight));

      // 已经到底就停，避免死循环
      if (actualY + viewportHeight >= cappedHeight - 1) break;
      curY += step;
    }

    // 拼接：按每段真实的 scrollY 偏移绘制，后画的覆盖重叠区
    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = Math.round(totalWidth * dpr);
    fullCanvas.height = Math.round(cappedHeight * dpr);
    const fctx = fullCanvas.getContext('2d');
    fctx.fillStyle = '#ffffff';
    fctx.fillRect(0, 0, fullCanvas.width, fullCanvas.height);

    segments.forEach((seg) => {
      fctx.drawImage(seg.img, 0, Math.round(seg.y * dpr));
    });

    window.scrollTo(0, originalScrollY);
    state.screenshot = fullCanvas;
    state.selection = { x: 0, y: 0, w: totalWidth, h: cappedHeight };
    state.screenshotDpr = dpr;
    state.phase = 'annotating';
    hideProgress();
    showAnnotationUI();
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // ========== 标注 UI ==========
  function showAnnotationUI() {
    // 进入标注阶段后，选区层不再需要
    if (canvas) canvas.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
    if (mask) mask.style.display = 'none';
    if (selectionEl) selectionEl.style.display = 'none';
    if (sizeLabel) sizeLabel.style.display = 'none';
    if (state.elementHighlight) state.elementHighlight.remove();
    state.elementHighlight = null;

    // 创建标注画布
    annotationCanvas = createEl('canvas', {
      id: 'snapmark-annot-canvas',
      class: 'snapmark-canvas-base'
    });
    document.body.appendChild(annotationCanvas);
    annotationCanvas.width = state.screenshot.width;
    annotationCanvas.height = state.screenshot.height;
    annotationCtx = annotationCanvas.getContext('2d');

    // 计算显示尺寸：整页长图会远超视口，需等比缩放到可视范围内
    const maxW = window.innerWidth - 40;
    const maxH = window.innerHeight - 160;   // 给工具栏留位置
    let dispW = state.selection.w;
    let dispH = state.selection.h;
    let dispX = state.selection.x;
    let dispY = state.selection.y;

    if (dispW > maxW || dispH > maxH) {
      const fit = Math.min(maxW / dispW, maxH / dispH);
      dispW = Math.round(dispW * fit);
      dispH = Math.round(dispH * fit);
      dispX = Math.round((window.innerWidth - dispW) / 2);
      dispY = 20;
      // 定位工具栏时按显示后的矩形来算
      state.selection = { x: dispX, y: dispY, w: dispW, h: dispH };
    }

    annotationCanvas.style.position = 'fixed';
    annotationCanvas.style.left = dispX + 'px';
    annotationCanvas.style.top = dispY + 'px';
    annotationCanvas.style.width = dispW + 'px';
    annotationCanvas.style.height = dispH + 'px';
    annotationCanvas.style.zIndex = '2147483646';
    annotationCanvas.style.cursor = 'crosshair';

    // 在选区后面渲染原图（作为背景层）
    showScreenshotBackground();

    // 创建工具栏
    buildToolbar();

    // 快捷键触发时自动展开 AI 面板
    if (state.autoAI) openAIPanel({ focusInput: true });
  }

  function showScreenshotBackground() {
    // 把截图显示在 annotation canvas 后面（直接创建一个 img 元素作为背景）
    let bgImg = $('snapmark-bg-img');
    if (!bgImg) {
      bgImg = createEl('img', { id: 'snapmark-bg-img' });
      document.body.appendChild(bgImg);
    }
    bgImg.src = state.screenshot.toDataURL('image/png');
    bgImg.style.position = 'fixed';
    bgImg.style.left = annotationCanvas.style.left;
    bgImg.style.top = annotationCanvas.style.top;
    bgImg.style.width = annotationCanvas.style.width;
    bgImg.style.height = annotationCanvas.style.height;
    bgImg.style.zIndex = '2147483645';
    bgImg.style.boxShadow = '0 4px 24px rgba(0,0,0,0.5)';
    bgImg.style.pointerEvents = 'none';
  }

  function buildToolbar() {
    toolbar = createEl('div', { id: 'snapmark-toolbar' });

    // AI 任务按钮：从 background 拿到的预设列表
    const presetIcons = {
      ocr: '🔤', explain: '💡', translate: '🌐',
      table: '📊', code: '💻', alt: '♿'
    };
    const aiButtons = Object.entries(state.aiPresets)
      .map(([key, p]) =>
        `<button data-ai-preset="${key}" class="ai-btn" title="${p.label}"><span class="tool-icon">${presetIcons[key] || '✨'}</span> ${p.label}</button>`
      ).join('');

    toolbar.innerHTML = `
      <div class="group ai-group">
        <span class="group-label">AI</span>
        ${aiButtons}
        <button id="snapmark-ai-ask" class="ai-btn accent" title="自由提问"><span class="tool-icon">💬</span> 自由提问</button>
        <button id="snapmark-ai-settings" title="AI 设置"><span class="tool-icon">⚙</span></button>
      </div>
      <div class="group">
        <span class="group-label">标注</span>
        <button data-tool="none" class="tool-btn active"><span class="tool-icon">↖</span> 选择</button>
        <button data-tool="arrow" class="tool-btn"><span class="tool-icon">→</span> 箭头</button>
        <button data-tool="rect" class="tool-btn"><span class="tool-icon">▭</span> 矩形</button>
        <button data-tool="text" class="tool-btn"><span class="tool-icon">T</span> 文字</button>
        <button data-tool="mosaic" class="tool-btn"><span class="tool-icon">▦</span> 马赛克</button>
        <button data-tool="pen" class="tool-btn"><span class="tool-icon">✎</span> 画笔</button>
      </div>
      <div class="group">
        <label>颜色 <input type="color" id="snapmark-color" value="${state.settings.color}"></label>
        <label>粗细 <input type="range" id="snapmark-stroke" min="1" max="20" value="${state.settings.strokeWidth}"><span id="snapmark-stroke-val">${state.settings.strokeWidth}</span></label>
        <label>字号 <input type="number" id="snapmark-font" min="8" max="72" value="${state.settings.fontSize}"></label>
        <label><input type="checkbox" id="snapmark-num" ${state.settings.showNumbering ? 'checked' : ''}> 序号</label>
        <button id="snapmark-undo" title="撤销 Ctrl+Z"><span class="tool-icon">↶</span></button>
        <button id="snapmark-redo" title="重做 Ctrl+Shift+Z"><span class="tool-icon">↷</span></button>
      </div>
      <div class="group">
        <button id="snapmark-copy" class="primary"><span class="tool-icon">📋</span> 复制</button>
        <button id="snapmark-dl-png" class="primary"><span class="tool-icon">⬇</span> PNG</button>
        <button id="snapmark-dl-jpg" class="primary"><span class="tool-icon">⬇</span> JPEG</button>
        <button id="snapmark-cancel" class="danger" title="取消 Esc">✕</button>
      </div>
    `;
    document.body.appendChild(toolbar);

    // 工具栏定位：优先放选区下方，空间不够则放上方，再不够就贴住视口底部
    positionToolbar();
    bindToolbarEvents();
  }

  function positionToolbar() {
    const sel = state.selection;
    const tbH = toolbar.offsetHeight || 96;
    const tbW = toolbar.offsetWidth || 720;
    const gap = 10;

    let top = sel.y + sel.h + gap;
    if (top + tbH > window.innerHeight) {
      top = sel.y - tbH - gap;                       // 放上方
      if (top < 0) top = window.innerHeight - tbH - gap;  // 贴底
    }
    let left = sel.x;
    if (left + tbW > window.innerWidth) left = window.innerWidth - tbW - gap;
    if (left < gap) left = gap;

    toolbar.style.left = Math.max(gap, left) + 'px';
    toolbar.style.top = Math.max(gap, top) + 'px';
    toolbar.style.width = 'auto';
  }


  function bindToolbarEvents() {
    // 工具切换
    toolbar.querySelectorAll('.tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        toolbar.querySelectorAll('.tool-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.currentTool = btn.dataset.tool;
        updateCursor();
      });
    });

    $('snapmark-color').addEventListener('input', (e) => {
      state.settings.color = e.target.value;
      saveSettings();
    });

    $('snapmark-stroke').addEventListener('input', (e) => {
      state.settings.strokeWidth = parseInt(e.target.value, 10);
      $('snapmark-stroke-val').textContent = state.settings.strokeWidth;
      saveSettings();
    });

    $('snapmark-font').addEventListener('change', (e) => {
      state.settings.fontSize = parseInt(e.target.value, 10) || 18;
      saveSettings();
    });

    $('snapmark-num').addEventListener('change', (e) => {
      state.settings.showNumbering = e.target.checked;
      saveSettings();
    });

    $('snapmark-undo').addEventListener('click', undo);
    $('snapmark-redo').addEventListener('click', redo);
    $('snapmark-cancel').addEventListener('click', cleanup);
    $('snapmark-copy').addEventListener('click', () => exportImage('clipboard'));
    $('snapmark-dl-png').addEventListener('click', () => exportImage('png'));
    $('snapmark-dl-jpg').addEventListener('click', () => exportImage('jpeg'));

    // AI 预设任务按钮
    toolbar.querySelectorAll('[data-ai-preset]').forEach((btn) => {
      btn.addEventListener('click', () => runAI({ preset: btn.dataset.aiPreset }));
    });
    $('snapmark-ai-ask').addEventListener('click', () => openAIPanel({ focusInput: true }));
    $('snapmark-ai-settings').addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'openOptions' });
    });

    // 标注画布交互
    annotationCanvas.addEventListener('mousedown', onAnnotMouseDown);
    annotationCanvas.addEventListener('mousemove', onAnnotMouseMove);
    annotationCanvas.addEventListener('mouseup', onAnnotMouseUp);
    annotationCanvas.addEventListener('mouseleave', onAnnotMouseUp);
  }

  function updateCursor() {
    // 选区阶段尚未创建标注画布，工具切换后才需要更新画布光标。
    if (!annotationCanvas) return;
    const cursors = {
      none: 'default',
      arrow: 'crosshair',
      rect: 'crosshair',
      text: 'text',
      mosaic: 'crosshair',
      pen: 'crosshair'
    };
    annotationCanvas.style.cursor = cursors[state.currentTool] || 'crosshair';
  }

  // 画布坐标（考虑位置偏移）
  function canvasCoords(e) {
    const r = annotationCanvas.getBoundingClientRect();
    // 转换为画布内部坐标（按 dpr 缩放）
    const scaleX = annotationCanvas.width / r.width;
    const scaleY = annotationCanvas.height / r.height;
    return {
      x: (e.clientX - r.left) * scaleX,
      y: (e.clientY - r.top) * scaleY
    };
  }

  function onAnnotMouseDown(e) {
    if (state.currentTool === 'none') return;
    e.preventDefault();
    e.stopPropagation();
    state.isAnnotating = true;
    state.annotStart = canvasCoords(e);
    state.annotEnd = state.annotStart;

    if (state.currentTool === 'pen') {
      state.currentPenPath = [state.annotStart];
    } else if (state.currentTool === 'text') {
      showTextInput(e.clientX, e.clientY);
      state.isAnnotating = false;
    }
  }

  function onAnnotMouseMove(e) {
    if (!state.isAnnotating) return;
    state.annotEnd = canvasCoords(e);
    if (state.currentTool === 'pen' && state.currentPenPath) {
      state.currentPenPath.push(state.annotEnd);
    }
    drawPreview();
  }

  function onAnnotMouseUp(e) {
    if (!state.isAnnotating) return;
    state.isAnnotating = false;
    const start = state.annotStart;
    const end = state.annotEnd;
    if (!start || !end) return;

    const rect = rectFromPoints(start, end);
    if (state.currentTool === 'pen' && state.currentPenPath) {
      if (state.currentPenPath.length > 1) {
        addAnnotation({
          type: 'pen',
          color: state.settings.color,
          strokeWidth: state.settings.strokeWidth,
          path: state.currentPenPath.slice()
        });
      }
      state.currentPenPath = null;
    } else if (rect.w > 3 && rect.h > 3) {
      switch (state.currentTool) {
        case 'arrow':
          addAnnotation({
            type: 'arrow',
            color: state.settings.color,
            strokeWidth: state.settings.strokeWidth,
            start, end
          });
          break;
        case 'rect':
          addAnnotation({
            type: 'rect',
            color: state.settings.color,
            strokeWidth: state.settings.strokeWidth,
            rect
          });
          break;
        case 'mosaic':
          addAnnotation({
            type: 'mosaic',
            rect
          });
          break;
      }
    }
    drawAnnotations();
  }

  function showTextInput(clientX, clientY) {
    const input = createEl('input', {
      id: 'snapmark-text-input',
      type: 'text',
      placeholder: '输入文字...'
    });
    input.style.left = clientX + 'px';
    input.style.top = clientY + 'px';
    input.style.color = state.settings.color;
    input.style.fontSize = state.settings.fontSize + 'px';
    document.body.appendChild(input);
    input.focus();

    const finish = () => {
      const text = input.value.trim();
      input.remove();
      if (text) {
        const r = annotationCanvas.getBoundingClientRect();
        addAnnotation({
          type: 'text',
          text,
          color: state.settings.color,
          fontSize: state.settings.fontSize,
          x: (clientX - r.left) * (annotationCanvas.width / r.width),
          y: (clientY - r.top) * (annotationCanvas.height / r.height)
        });
        drawAnnotations();
      }
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish();
      else if (e.key === 'Escape') { input.remove(); }
    });
  }

  // ========== 标注存储 ==========
  function addAnnotation(annot) {
    state.history.push(state.annotations.slice());
    state.redoStack = [];
    if (state.settings.showNumbering && (annot.type === 'arrow' || annot.type === 'rect')) {
      annot.number = state.nextNumber++;
    }
    state.annotations.push(annot);
  }

  function undo() {
    if (state.history.length === 0) return;
    state.redoStack.push(state.annotations.slice());
    state.annotations = state.history.pop();
    drawAnnotations();
  }

  function redo() {
    if (state.redoStack.length === 0) return;
    state.history.push(state.annotations.slice());
    state.annotations = state.redoStack.pop();
    drawAnnotations();
  }

  // ========== 绘制 ==========
  function drawPreview() {
    // 在原始截图上叠加标注 + 预览
    drawAnnotations();
    if (state.isAnnotating && state.annotStart && state.annotEnd) {
      const previewAnnot = {
        type: state.currentTool,
        color: state.settings.color,
        strokeWidth: state.settings.strokeWidth,
        start: state.annotStart,
        end: state.annotEnd,
        rect: rectFromPoints(state.annotStart, state.annotEnd),
        path: state.currentPenPath
      };
      drawOne(previewAnnot, true);
    }
  }

  function drawAnnotations() {
    annotationCtx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
    state.annotations.forEach((a) => drawOne(a, false));
  }

  function drawOne(a, isPreview) {
    const ctx2 = annotationCtx;
    ctx2.save();
    switch (a.type) {
      case 'arrow':
        drawArrow(ctx2, a.start, a.end, a.color, a.strokeWidth);
        if (a.number) drawNumber(ctx2, a.end, a.number, a.color);
        break;
      case 'rect':
        ctx2.strokeStyle = a.color;
        ctx2.lineWidth = a.strokeWidth;
        ctx2.strokeRect(a.rect.x, a.rect.y, a.rect.w, a.rect.h);
        if (a.number) drawNumber(ctx2, { x: a.rect.x + a.rect.w, y: a.rect.y }, a.number, a.color);
        break;
      case 'text':
        ctx2.fillStyle = a.color;
        ctx2.font = `bold ${a.fontSize}px -apple-system, "Segoe UI", sans-serif`;
        ctx2.textBaseline = 'top';
        // 文字描边以保证可读
        ctx2.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx2.lineWidth = 3;
        ctx2.lineJoin = 'round';
        ctx2.strokeText(a.text, a.x, a.y);
        ctx2.fillText(a.text, a.x, a.y);
        break;
      case 'mosaic':
        drawMosaic(ctx2, a.rect);
        break;
      case 'pen':
        if (a.path && a.path.length > 1) {
          ctx2.strokeStyle = a.color;
          ctx2.lineWidth = a.strokeWidth;
          ctx2.lineCap = 'round';
          ctx2.lineJoin = 'round';
          ctx2.beginPath();
          ctx2.moveTo(a.path[0].x, a.path[0].y);
          for (let i = 1; i < a.path.length; i++) {
            ctx2.lineTo(a.path[i].x, a.path[i].y);
          }
          ctx2.stroke();
        }
        break;
    }
    ctx2.restore();
  }

  function drawArrow(ctx2, start, end, color, width) {
    ctx2.strokeStyle = color;
    ctx2.fillStyle = color;
    ctx2.lineWidth = width;
    ctx2.lineCap = 'round';
    ctx2.lineJoin = 'round';

    // 箭头主线
    ctx2.beginPath();
    ctx2.moveTo(start.x, start.y);
    ctx2.lineTo(end.x, end.y);
    ctx2.stroke();

    // 箭头头部
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const headLen = Math.max(12, width * 4);
    ctx2.beginPath();
    ctx2.moveTo(end.x, end.y);
    ctx2.lineTo(end.x - headLen * Math.cos(angle - Math.PI / 7),
                end.y - headLen * Math.sin(angle - Math.PI / 7));
    ctx2.lineTo(end.x - headLen * Math.cos(angle + Math.PI / 7),
                end.y - headLen * Math.sin(angle + Math.PI / 7));
    ctx2.closePath();
    ctx2.fill();
  }

  function drawNumber(ctx2, pt, num, color) {
    const size = 24;
    ctx2.fillStyle = color;
    ctx2.beginPath();
    ctx2.arc(pt.x, pt.y, size / 2 + 2, 0, Math.PI * 2);
    ctx2.fill();
    ctx2.fillStyle = '#fff';
    ctx2.font = `bold ${size}px -apple-system, sans-serif`;
    ctx2.textAlign = 'center';
    ctx2.textBaseline = 'middle';
    ctx2.fillText(String(num), pt.x, pt.y);
    ctx2.textAlign = 'start';
    ctx2.textBaseline = 'alphabetic';
  }

  // 马赛克实现
  function drawMosaic(ctx2, rect) {
    // 离屏画布取区域像素 -> 缩小 -> 放大回原位
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const w = Math.min(ctx2.canvas.width - x, Math.floor(rect.w));
    const h = Math.min(ctx2.canvas.height - y, Math.floor(rect.h));
    if (w <= 0 || h <= 0) return;

    // 拿到原始截图对应区域（state.screenshot 是离屏画布）
    // 我们直接在 state.screenshot 上做马赛克
    const src = state.screenshot;
    const srcCtx = src.getContext('2d');
    const blockSize = 12;
    try {
      const imageData = srcCtx.getImageData(x, y, w, h);
      const data = imageData.data;
      // 块状像素化
      for (let by = 0; by < h; by += blockSize) {
        for (let bx = 0; bx < w; bx += blockSize) {
          let r = 0, g = 0, b = 0, n = 0;
          for (let dy = 0; dy < blockSize && by + dy < h; dy++) {
            for (let dx = 0; dx < blockSize && bx + dx < w; dx++) {
              const idx = ((by + dy) * w + (bx + dx)) * 4;
              r += data[idx];
              g += data[idx + 1];
              b += data[idx + 2];
              n++;
            }
          }
          r = Math.floor(r / n);
          g = Math.floor(g / n);
          b = Math.floor(b / n);
          for (let dy = 0; dy < blockSize && by + dy < h; dy++) {
            for (let dx = 0; dx < blockSize && bx + dx < w; dx++) {
              const idx = ((by + dy) * w + (bx + dx)) * 4;
              data[idx] = r;
              data[idx + 1] = g;
              data[idx + 2] = b;
            }
          }
        }
      }
      srcCtx.putImageData(imageData, x, y);
      // 重新画到 annotation canvas（马赛克直接画原图对应区域）
      ctx2.clearRect(x, y, w, h);
      ctx2.drawImage(src, x, y, w, h, x, y, w, h);
    } catch (err) {
      console.warn('Mosaic failed (likely CORS):', err);
      // 退化为半透明色块
      ctx2.fillStyle = 'rgba(100, 100, 100, 0.9)';
      ctx2.fillRect(x, y, w, h);
    }
  }

  // ========== AI 面板 ==========
  let aiPanel = null;

  function openAIPanel(opts = {}) {
    if (aiPanel) {
      if (opts.focusInput) {
        const inp = $('snapmark-ai-input');
        if (inp) inp.focus();
      }
      return aiPanel;
    }

    aiPanel = createEl('div', { id: 'snapmark-ai-panel' });
    aiPanel.innerHTML = `
      <div class="ai-header">
        <span class="ai-title">✨ SnapMark AI</span>
        <span class="ai-model"></span>
        <div class="ai-header-actions">
          <button class="ai-icon-btn" data-act="copy" title="复制结果">📋</button>
          <button class="ai-icon-btn" data-act="insert" title="把结果作为文字标注插入图中">➕</button>
          <button class="ai-icon-btn" data-act="retry" title="重新生成">↻</button>
          <button class="ai-icon-btn" data-act="close" title="关闭面板">✕</button>
        </div>
      </div>
      <div class="ai-body">
        <div class="ai-placeholder">选一个上方的 AI 任务，或在下面直接提问。</div>
      </div>
      <div class="ai-footer">
        <textarea id="snapmark-ai-input" rows="2" placeholder="对这张截图提问…（Enter 发送 / Shift+Enter 换行）"></textarea>
        <button id="snapmark-ai-send" class="ai-send">发送</button>
      </div>
    `;
    document.body.appendChild(aiPanel);

    // 阻止面板内的按键冒泡到全局 Esc/Ctrl+Z 监听
    aiPanel.addEventListener('keydown', (e) => e.stopPropagation());

    aiPanel.querySelectorAll('.ai-icon-btn').forEach((btn) => {
      btn.addEventListener('click', () => onAIPanelAction(btn.dataset.act));
    });

    const input = $('snapmark-ai-input');
    const send = () => {
      const q = input.value.trim();
      if (!q) return;
      input.value = '';
      runAI({ question: q });
    };
    $('snapmark-ai-send').addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    if (opts.focusInput) input.focus();
    return aiPanel;
  }

  function onAIPanelAction(act) {
    switch (act) {
      case 'copy':
        if (!state.aiResultText) { showToast('还没有结果可复制'); return; }
        navigator.clipboard.writeText(state.aiResultText)
          .then(() => showToast('AI 结果已复制'))
          .catch((e) => showToast('复制失败: ' + e.message));
        break;
      case 'insert':
        if (!state.aiResultText) { showToast('还没有结果可插入'); return; }
        insertAIResultAsAnnotation(state.aiResultText);
        break;
      case 'retry':
        if (state.aiLastPreset) runAI(state.aiLastPreset);
        else showToast('没有可重试的任务');
        break;
      case 'close':
        if (aiPanel) { aiPanel.remove(); aiPanel = null; }
        break;
    }
  }

  // 把 AI 回答作为文字标注画进图里（自动换行）
  function insertAIResultAsAnnotation(text) {
    const maxChars = 42;
    const lines = [];
    text.split('\n').forEach((para) => {
      if (!para.trim()) { lines.push(''); return; }
      for (let i = 0; i < para.length; i += maxChars) {
        lines.push(para.slice(i, i + maxChars));
      }
    });

    const fontSize = state.settings.fontSize;
    const lineHeight = fontSize * 1.4;
    let y = fontSize + 10;
    lines.slice(0, 18).forEach((line) => {   // 最多插 18 行，避免糊满整图
      if (line) {
        addAnnotation({
          type: 'text',
          text: line,
          color: state.settings.color,
          fontSize: fontSize,
          x: 12,
          y: y
        });
      }
      y += lineHeight;
    });
    drawAnnotations();
    showToast('已插入 ' + Math.min(lines.length, 18) + ' 行文字标注');
  }

  // 渲染极简 Markdown（粗体 / 行内代码 / 代码块 / 列表 / 表格），不用 innerHTML 拼接模型输出
  function renderAIBody(text) {
    const body = aiPanel && aiPanel.querySelector('.ai-body');
    if (!body) return;
    body.innerHTML = '';

    const blocks = text.split(/```/);
    blocks.forEach((block, i) => {
      if (i % 2 === 1) {
        // 代码块
        const firstNl = block.indexOf('\n');
        const lang = firstNl > -1 ? block.slice(0, firstNl).trim() : '';
        const code = firstNl > -1 ? block.slice(firstNl + 1) : block;
        const wrap = createEl('div', { class: 'ai-code-wrap' }, body);
        if (lang) createEl('span', { class: 'ai-code-lang' }, wrap).textContent = lang;
        const pre = createEl('pre', { class: 'ai-code' }, wrap);
        pre.textContent = code.replace(/\n$/, '');
      } else {
        block.split('\n').forEach((line) => {
          if (!line.trim()) return;
          const p = createEl('div', { class: 'ai-line' }, body);
          // 表格行原样等宽显示，保持对齐
          if (/^\s*\|.*\|\s*$/.test(line)) {
            p.className = 'ai-line ai-table-row';
            p.textContent = line;
            return;
          }
          if (/^\s*[-*+]\s+/.test(line)) p.className = 'ai-line ai-li';
          appendInline(p, line.replace(/^\s*[-*+]\s+/, ''));
        });
      }
    });
    body.scrollTop = body.scrollHeight;
  }

  // 处理 **粗体** 和 `行内代码`
  function appendInline(parent, text) {
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const tok = m[0];
      if (tok.startsWith('**')) {
        createEl('strong', {}, parent).textContent = tok.slice(2, -2);
      } else {
        createEl('code', {}, parent).textContent = tok.slice(1, -1);
      }
      last = m.index + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function setAIStatus(cls, msg) {
    const body = aiPanel && aiPanel.querySelector('.ai-body');
    if (!body) return;
    body.innerHTML = '';
    const d = createEl('div', { class: 'ai-status ' + cls }, body);
    d.textContent = msg;
    return body;
  }

  // ========== 调用 AI ==========
  async function runAI(req) {
    openAIPanel();
    state.aiLastPreset = req;

    if (!state.aiConfig || !state.aiConfig.configured) {
      const body = setAIStatus('error', '还没配置 AI：点工具栏的 ⚙ 填入 API Key 后再试。');
      if (body) {
        const btn = createEl('button', { class: 'ai-send' }, body);
        btn.textContent = '打开设置';
        btn.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'openOptions' }));
      }
      return;
    }

    // 上一次还在流式输出，先中断
    if (state.aiPort) {
      try { state.aiPort.postMessage({ type: 'abort' }); state.aiPort.disconnect(); } catch (e) { /* ignore */ }
      state.aiPort = null;
    }

    // 把「原图 + 已有标注」一起发给 AI，这样箭头圈出的重点 AI 也能看到
    const imageDataUrl = compressForAI(composeFinalCanvas());

    state.aiResultText = '';
    state.aiStreaming = true;
    setAIStatus('loading', '正在思考…');

    const port = chrome.runtime.connect({ name: 'snapmark-ai' });
    state.aiPort = port;

    port.onMessage.addListener((msg) => {
      if (msg.type === 'start') {
        const m = aiPanel && aiPanel.querySelector('.ai-model');
        if (m) m.textContent = msg.model || '';
        state.aiResultText = '';
      } else if (msg.type === 'delta') {
        state.aiResultText += msg.text;
        renderAIBody(state.aiResultText);
      } else if (msg.type === 'done') {
        state.aiStreaming = false;
        if (msg.text) state.aiResultText = msg.text;
        if (!state.aiResultText.trim()) setAIStatus('error', '模型没有返回内容，换个模型或稍后再试。');
        else renderAIBody(state.aiResultText);
        try { port.disconnect(); } catch (e) { /* ignore */ }
        state.aiPort = null;
      } else if (msg.type === 'error') {
        state.aiStreaming = false;
        setAIStatus('error', '出错了：' + msg.message);
        state.aiPort = null;
      } else if (msg.type === 'aborted') {
        state.aiStreaming = false;
      }
    });

    port.onDisconnect.addListener(() => {
      state.aiStreaming = false;
      if (state.aiPort === port) state.aiPort = null;
    });

    port.postMessage({
      type: 'ask',
      preset: req.preset || null,
      question: req.question || null,
      imageDataUrl,
      pageContext: { title: document.title, url: location.href }
    });
  }

  // 视觉模型对超大图既慢又贵：等比缩到长边 1600 内，并转 JPEG
  function compressForAI(sourceCanvas) {
    const MAX_EDGE = 1600;
    const longest = Math.max(sourceCanvas.width, sourceCanvas.height);
    if (longest <= MAX_EDGE) {
      return sourceCanvas.toDataURL('image/jpeg', 0.9);
    }
    const scale = MAX_EDGE / longest;
    const c = document.createElement('canvas');
    c.width = Math.round(sourceCanvas.width * scale);
    c.height = Math.round(sourceCanvas.height * scale);
    const cctx = c.getContext('2d');
    cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(sourceCanvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.9);
  }

  // ========== 导出 ==========
  function composeFinalCanvas() {
    // 合成：原图 + 标注 -> 最终 canvas
    const final = document.createElement('canvas');
    final.width = state.screenshot.width;
    final.height = state.screenshot.height;
    const fctx = final.getContext('2d');
    fctx.drawImage(state.screenshot, 0, 0);
    // 标注画布内容已是透明层，叠加
    fctx.drawImage(annotationCanvas, 0, 0);
    return final;
  }

  async function exportImage(format) {
    const final = composeFinalCanvas();
    if (format === 'clipboard') {
      try {
        const blob = await new Promise((res) => final.toBlob(res, 'image/png'));
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ]);
        showToast('已复制到剪贴板');
      } catch (err) {
        console.error(err);
        showToast('复制失败: ' + err.message);
      }
      return;
    }

    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const quality = format === 'jpeg' ? state.settings.jpegQuality : undefined;
    const dataUrl = final.toDataURL(mime, quality);
    const ext = format === 'jpeg' ? 'jpg' : 'png';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const title = document.title.slice(0, 30).replace(/[\\/:*?"<>|]/g, '_');
    const filename = `snapmark_${title}_${ts}.${ext}`;

    try {
      await chrome.runtime.sendMessage({
        action: 'downloadImage',
        dataUrl,
        filename
      });
      showToast('已下载 ' + filename);
    } catch (err) {
      console.error(err);
      showToast('下载失败: ' + err.message);
    }
  }

  // ========== 提示与进度 ==========
  function showToast(msg) {
    const old = $('snapmark-toast');
    if (old) old.remove();
    const t = createEl('div', { id: 'snapmark-toast' });
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  function showProgress(msg, ratio) {
    let p = $('snapmark-progress');
    if (!p) {
      p = createEl('div', { id: 'snapmark-progress' });
      p.innerHTML = `<div class="msg"></div><div class="bar"><div class="bar-fill"></div></div>`;
      document.body.appendChild(p);
    }
    p.querySelector('.msg').textContent = msg;
    p.querySelector('.bar-fill').style.width = (Math.max(0, Math.min(1, ratio)) * 100) + '%';
  }

  function hideProgress() {
    const p = $('snapmark-progress');
    if (p) p.remove();
  }

  // ========== 清理 ==========
  function cleanup() {
    // 断开 AI 连接，停止流式输出
    if (state.aiPort) {
      try { state.aiPort.postMessage({ type: 'abort' }); state.aiPort.disconnect(); } catch (e) { /* ignore */ }
      state.aiPort = null;
    }
    state.aiStreaming = false;

    ['snapmark-overlay', 'snapmark-mask', 'snapmark-guide-canvas', 'snapmark-annot-canvas',
     'snapmark-selection', 'snapmark-size-label', 'snapmark-toolbar', 'snapmark-text-input',
     'snapmark-toast', 'snapmark-progress', 'snapmark-bg-img', 'snapmark-ai-panel']
      .forEach((id) => {
        const el = $(id);
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });
    // 移除元素高亮
    document.querySelectorAll('.snapmark-element-highlight').forEach((el) => el.remove());
    state.elementHighlight = null;
    state.phase = 'done';
    window.__snapmarkActive = false;
  }

  // ========== 启动 ==========
  async function start(mode, opts) {
    state.mode = mode || 'region';
    state.phase = 'selecting';
    state.annotations = [];
    state.history = [];
    state.redoStack = [];
    state.nextNumber = 1;
    state.currentTool = 'none';
    state.autoAI = !!(opts && opts.autoAI);
    state.aiResultText = '';
    state.aiLastPreset = null;

    await loadSettings();
    await loadAIConfig();
    buildUI();
    bindSelection();
    updateCursor();
    showToast(mode === 'fullpage' ? '准备整页截图...' : (mode === 'element' ? '鼠标悬停选择元素，点击截取' : '拖动鼠标选择截图区域'));
    if (mode === 'fullpage') {
      // 整页截图：先关掉覆盖层，再调用整页逻辑
      try {
        await captureFullPage();
      } catch (err) {
        console.error('SnapMark fullpage error', err);
        hideProgress();
        showToast('整页截图失败: ' + err.message);
        cleanup();
      }
    }
  }

  // 读取 AI 配置和预设任务列表（API Key 不会传到这里）
  async function loadAIConfig() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'getAIConfig' });
      state.aiConfig = (res && res.config) || { configured: false };
      state.aiPresets = (res && res.presets) || {};
    } catch (err) {
      state.aiConfig = { configured: false };
      state.aiPresets = {};
    }
  }

  // ========== 消息监听 ==========
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startScreenshot') {
      start(request.mode || 'region', request.opts || {});
      sendResponse({ ok: true });
    }
  });

  // 已注入过时，background 重复注入会命中顶部的早退分支，这里接住重启事件
  window.addEventListener('snapmark-restart', (e) => {
    const detail = (e && e.detail) || {};
    cleanup();
    window.__snapmarkActive = true;
    start(detail.mode || 'region', detail.opts || {});
  });

})();