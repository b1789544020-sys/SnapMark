#!/usr/bin/env python3
"""SnapMark v2 自检脚本
校验：JSON 合法性、括号平衡、函数定义与调用一致、manifest 引用的文件都存在、
      DOM id 在 JS 与 HTML/CSS 之间对应、AI 链路三处对齐。
用法: python tools/verify_v2.py
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

errors = []
warnings = []
passed = []


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def strip_js(src):
    """粗略移除注释、字符串、模板串、正则字面量，避免误判括号。"""
    out = []
    i, n = 0, len(src)

    def prev_significant():
        for ch in reversed(out):
            if not ch.isspace():
                return ch
        return ''

    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ''
        if c == '/' and nxt == '/':
            j = src.find('\n', i)
            if j < 0:
                break
            out.append('\n')
            i = j + 1
        elif c == '/' and nxt == '*':
            j = src.find('*/', i + 2)
            chunk = src[i:n if j < 0 else j + 2]
            out.append('\n' * chunk.count('\n'))
            i = n if j < 0 else j + 2
        elif c == '/' and prev_significant() in ('', '(', ',', '=', ':', '[',
                                                 '!', '&', '|', '?', '{', '}',
                                                 ';', '+', '~', '*', '%'):
            # 正则字面量：内部的 [ ] ( ) 和引号都不参与配对
            i += 1
            in_class = False
            while i < n:
                ch = src[i]
                if ch == '\\':
                    i += 2
                    continue
                if ch == '[':
                    in_class = True
                elif ch == ']':
                    in_class = False
                elif ch == '/' and not in_class:
                    i += 1
                    break
                elif ch == '\n':
                    break
                i += 1
            while i < n and src[i] in 'gimsuyd':   # 修饰符
                i += 1
            out.append(' ')
        elif c in '"\'`':
            quote = c
            i += 1
            while i < n:
                if src[i] == '\\':
                    i += 2
                    continue
                if src[i] == quote:
                    i += 1
                    break
                if src[i] == '\n':
                    out.append('\n')
                # 模板串里的 ${...} 需要跳过
                if quote == '`' and src[i] == '$' and i + 1 < n and src[i + 1] == '{':
                    depth = 0
                    i += 1
                    while i < n:
                        if src[i] == '{':
                            depth += 1
                        elif src[i] == '}':
                            depth -= 1
                            if depth == 0:
                                break
                        elif src[i] == '\n':
                            out.append('\n')
                        i += 1
                i += 1
            out.append(' ')
        else:
            out.append(c)
            i += 1
    return ''.join(out)


def check_balance(rel):
    code = strip_js(read(rel))
    pairs = {')': '(', ']': '[', '}': '{'}
    stack = []
    line = 1
    for ch in code:
        if ch == '\n':
            line += 1
        elif ch in '([{':
            stack.append((ch, line))
        elif ch in ')]}':
            if not stack:
                errors.append(f'{rel}: 第 {line} 行出现多余的 "{ch}"')
                return
            top, _ = stack.pop()
            if top != pairs[ch]:
                errors.append(f'{rel}: 第 {line} 行 "{ch}" 与 "{top}" 不匹配')
                return
    if stack:
        ch, ln = stack[-1]
        errors.append(f'{rel}: 第 {ln} 行的 "{ch}" 未闭合')
    else:
        passed.append(f'{rel} 括号平衡')


def check_manifest():
    raw = read('manifest.json')
    try:
        m = json.loads(raw)
    except json.JSONDecodeError as e:
        errors.append(f'manifest.json 不是合法 JSON: {e}')
        return None
    passed.append('manifest.json 是合法 JSON')

    refs = [m['background']['service_worker'],
            m['action']['default_popup'],
            m.get('options_page')]
    for cs in m.get('content_scripts', []):
        refs += cs.get('js', []) + cs.get('css', [])
    refs += list(m.get('icons', {}).values())
    refs = [r for r in refs if r]

    for r in refs:
        if not os.path.exists(os.path.join(ROOT, r)):
            errors.append(f'manifest 引用的文件不存在: {r}')
    passed.append(f'manifest 引用的 {len(refs)} 个文件均存在')
    return m


def check_commands(m):
    """快捷键定义必须与 background 的处理分支一一对应。"""
    if not m:
        return
    declared = set(m.get('commands', {}).keys())
    bg = read('background.js')
    handled = set(re.findall(r"command === '([\w-]+)'", bg))
    for c in declared - handled:
        errors.append(f'manifest 声明了快捷键 {c} 但 background.js 未处理')
    for c in handled - declared:
        errors.append(f'background.js 处理了 {c} 但 manifest 未声明')
    if declared == handled:
        passed.append(f'{len(declared)} 个快捷键定义与处理一致: {", ".join(sorted(declared))}')

    # 文档里的命令快捷键文案必须与 manifest 一致（这是 v1 的老 bug）
    combos = {v['suggested_key']['default'] for v in m['commands'].values()}
    # 这些是页面内编辑快捷键，不由 manifest 注册，不参与比对
    editing = {'Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+Y', 'Ctrl+V', 'Ctrl+C', 'Ctrl+S'}
    for doc in ('popup/popup.html', 'options/options.html', 'README.md'):
        if not os.path.exists(os.path.join(ROOT, doc)):
            continue
        text = read(doc)
        found = set(re.findall(r'(?:Ctrl|Alt|Command)\+(?:Shift\+)?[A-Z]\b', text))
        for combo in sorted(found - combos - editing):
            errors.append(f'{doc} 里的快捷键 "{combo}" 与 manifest 不一致')
    passed.append(f'文档快捷键文案与 manifest 一致: {", ".join(sorted(combos))}')


def check_actions():
    """content/popup/options 里 sendMessage 的 action 都要被 background 处理。"""
    bg = read('background.js')
    handled = set(re.findall(r"case '(\w+)':", bg))
    for rel in ('content/content.js', 'popup/popup.js', 'options/options.js'):
        src = read(rel)
        used = set(re.findall(r"action:\s*'(\w+)'", src))
        # startScreenshot 是 background -> content 方向，不需要 case
        used -= {'startScreenshot'}
        for a in used - handled:
            errors.append(f'{rel} 发送了 action "{a}"，但 background.js 没有对应 case')
    passed.append(f'所有 sendMessage action 都能被处理（background 共 {len(handled)} 个 case）')


def check_functions(rel):
    """被调用但从未定义的函数（只在同文件内判断，忽略内置和成员调用）。"""
    code = strip_js(read(rel))
    defined = set(re.findall(r'function\s+(\w+)\s*\(', code))
    defined |= set(re.findall(r'(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(', code))
    defined |= set(re.findall(r'(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?function', code))
    # 作为参数传入的回调（如 post、sendResponse、resolve、$）
    for params in re.findall(r'function\s*\w*\s*\(([^)]*)\)', code):
        defined |= {p.strip().split('=')[0].strip() for p in params.split(',') if p.strip()}
    for params in re.findall(r'\(([^()]*)\)\s*=>', code):
        defined |= {p.strip().split('=')[0].strip() for p in params.split(',') if p.strip()}
    defined |= set(re.findall(r'(\w+)\s*=>', code))                  # 单参数箭头函数
    defined |= set(re.findall(r'(\w+):\s*(?:async\s*)?(?:\(|function)', code))  # 对象方法

    builtin = {
        'setTimeout', 'clearTimeout', 'setInterval', 'parseInt', 'parseFloat',
        'decodeURIComponent', 'encodeURIComponent', 'requestAnimationFrame',
        'structuredClone', 'isFinite',
    }
    called = set(re.findall(r'(?<![.\w$])(\w+)\s*\(', code))
    missing = called - defined - builtin
    # 只报明显是自定义函数的：驼峰命名、小写开头、长度 > 3
    suspects = sorted(x for x in missing
                      if len(x) > 3 and x[0].islower() and re.search(r'[a-z][A-Z]', x))
    for s in suspects:
        errors.append(f'{rel}: 调用了未定义的函数 {s}()')
    if not suspects:
        passed.append(f'{rel} 无未定义函数调用（本文件定义 {len(defined)} 个可调用名）')


def check_dom_ids():
    """JS 里 getElementById 的 id 必须存在于对应 HTML。"""
    pairs = [('popup/popup.js', 'popup/popup.html'),
             ('options/options.js', 'options/options.html')]
    for js, html in pairs:
        jsrc, hsrc = read(js), read(html)
        ids = set(re.findall(r"getElementById\('([\w-]+)'\)", jsrc))
        ids |= set(re.findall(r"\$\('([\w-]+)'\)", jsrc))
        html_ids = set(re.findall(r'id="([\w-]+)"', hsrc))
        for i in sorted(ids - html_ids):
            errors.append(f'{js} 访问 id="{i}"，但 {html} 中不存在')
        if ids <= html_ids:
            passed.append(f'{js} 引用的 {len(ids)} 个 DOM id 均存在于 {html}')


def check_content_ids():
    """content.js 创建的元素 id 必须有样式，且必须被 cleanup 移除。"""
    js = read('content/content.js')
    css = read('content/content.css')
    created = set(re.findall(r"id:\s*'(snapmark-[\w-]+)'", js))
    for i in sorted(created):
        if f'#{i}' not in css and 'snapmark-canvas-base' not in js:
            warnings.append(f'content.css 缺少 #{i} 的样式定义')
    passed.append(f'检查了 content.js 创建的 {len(created)} 个元素 id')

    m = re.search(r'function cleanup\(\)\s*\{(.*?)\n  \}', js, re.S)
    if not m:
        errors.append('content.js 中找不到 cleanup() 函数')
        return
    body = m.group(1)
    leaked = [i for i in sorted(created) if i not in body]
    for i in leaked:
        errors.append(f'cleanup() 没有移除 #{i}，取消截图后会残留在页面上')
    if not leaked:
        passed.append('cleanup() 覆盖了所有创建的元素，无 DOM 残留')


def check_ai_wiring():
    """AI 链路完整性：预设 key、port 名称、流式消息类型三处必须对齐。"""
    bg = read('background.js')
    cs = read('content/content.js')

    block = re.search(r'const AI_PRESETS = \{(.*?)\n\};', bg, re.S)
    presets = set(re.findall(r'^  (\w+): \{', block.group(1), re.M)) if block else set()
    icons = re.search(r'const presetIcons = \{(.*?)\};', cs, re.S)
    if icons:
        iconkeys = set(re.findall(r"(\w+):\s*'", icons.group(1)))
        for p in sorted(presets - iconkeys):
            warnings.append(f'预设任务 "{p}" 在 content.js 没配图标，会退化为 ✨')
    if presets:
        passed.append(f'AI 预设任务 {len(presets)} 个: {", ".join(sorted(presets))}')
    else:
        errors.append('background.js 中未找到 AI_PRESETS 定义')

    bg_port = set(re.findall(r"port\.name !== '([\w-]+)'", bg))
    cs_port = set(re.findall(r"connect\(\{ name: '([\w-]+)' \}\)", cs))
    if bg_port != cs_port:
        errors.append(f'AI port 名称不一致: background={bg_port or "无"} content={cs_port or "无"}')
    else:
        passed.append(f'AI 长连接 port 名称一致: {", ".join(bg_port)}')

    sent = set(re.findall(r"post\(\{\s*type: '(\w+)'", bg))
    recv = set(re.findall(r"msg\.type === '(\w+)'", cs))
    for t in sorted(sent - recv):
        errors.append(f'background 发送的流式消息 "{t}" 在 content.js 未处理')
    if sent and sent <= recv:
        passed.append(f'AI 流式消息类型全部被处理: {", ".join(sorted(sent))}')

    # API Key 绝不能出现在 storage.sync 或被回传给 content script
    if re.search(r'storage\.sync\.set\([^)]*aiApiKey', bg + read('options/options.js')):
        errors.append('API Key 被写入 storage.sync（会同步上云），应使用 storage.local')
    else:
        passed.append('API Key 仅存于 storage.local，不会同步上云')
    cfg_return = re.search(r"case 'getAIConfig': \{(.*?)\n    \}", bg, re.S)
    if cfg_return and 'aiApiKey:' in cfg_return.group(1):
        errors.append('getAIConfig 把 aiApiKey 回传给了 content script，存在泄露风险')
    else:
        passed.append('getAIConfig 不回传 API Key 给页面脚本')


def check_capture_wiring():
    """captureVisibleTab 必须接收 windowId，不能把 sender.tab.id 当作窗口。"""
    bg = read('background.js')
    valid = (
        'captureThrottled(tab.windowId)' in bg
        and 'function captureThrottled(windowId)' in bg
        and 'chrome.tabs.captureVisibleTab(windowId,' in bg
        and not re.search(r'captureVisibleTab\(tabId\s*,', bg)
    )
    if valid:
        passed.append('区域截图向 captureVisibleTab 传递 windowId（不是 tabId）')
    else:
        errors.append('captureVisibleTab 参数必须来自 tab.windowId，不能使用 tabId')


def main():
    print('=' * 64)
    print(' SnapMark v2 自检')
    print('=' * 64)

    for f in ['background.js', 'content/content.js',
              'popup/popup.js', 'options/options.js']:
        check_balance(f)
        check_functions(f)

    m = check_manifest()
    check_commands(m)
    check_actions()
    check_capture_wiring()
    check_dom_ids()
    check_content_ids()
    check_ai_wiring()

    print(f'\n通过 {len(passed)} 项:')
    for p in passed:
        print(f'  [OK] {p}')

    if warnings:
        print(f'\n告警 {len(warnings)} 项:')
        for w in warnings:
            print(f'  [!]  {w}')

    if errors:
        print(f'\n错误 {len(errors)} 项:')
        for e in errors:
            print(f'  [X]  {e}')
        print('\n结果: 未通过')
        return 1

    print('\n结果: 全部通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
