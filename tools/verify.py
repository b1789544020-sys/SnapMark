"""Quick syntax check for SnapMark JS files (Python-based, no Node required)."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
files = [
    ROOT / 'background.js',
    ROOT / 'content' / 'content.js',
    ROOT / 'popup' / 'popup.js',
]

# 1. Validate manifest.json
import json
manifest = ROOT / 'manifest.json'
try:
    with open(manifest, 'r', encoding='utf-8') as f:
        m = json.load(f)
    print(f'[OK] manifest.json parses as JSON')
    print(f'     name:        {m.get("name")}')
    print(f'     version:     {m.get("version")}')
    print(f'     manifest_ver:{m.get("manifest_version")}')
    icons = m.get('icons', {})
    print(f'     icons:       {icons}')
    for sz, rel in icons.items():
        ip = ROOT / rel
        print(f'       {sz} -> {ip.name} {"EXISTS" if ip.exists() else "MISSING"}')
except Exception as e:
    print(f'[FAIL] manifest.json: {e}')

print()

# 2. Check JS file balance
for fp in files:
    with open(fp, 'r', encoding='utf-8') as f:
        content = f.read()
    # remove strings & line comments to count only code brackets
    # (very crude, but enough for our content)
    no_str = re.sub(r"'[^'\\\n]*(?:\\.[^'\\\n]*)*'", "''", content)
    no_str = re.sub(r'"[^"\\\n]*(?:\\.[^"\\\n]*)*"', '""', no_str)
    no_str = re.sub(r'`[^`\\]*(?:\\.[^`\\]*)*`', '``', no_str)
    # remove line comments
    no_str = re.sub(r'//[^\n]*', '', no_str)
    no_str = re.sub(r'/\*.*?\*/', '', no_str, flags=re.S)
    n_open = no_str.count('{')
    n_close = no_str.count('}')
    n_paren_o = no_str.count('(')
    n_paren_c = no_str.count(')')
    n_brack_o = no_str.count('[')
    n_brack_c = no_str.count(']')
    print(f'[CHECK] {fp.relative_to(ROOT)}')
    print(f'        braces   : {n_open}/{n_close} {"OK" if n_open==n_close else "MISMATCH"}')
    print(f'        parens   : {n_paren_o}/{n_paren_c} {"OK" if n_paren_o==n_paren_c else "MISMATCH"}')
    print(f'        brackets : {n_brack_o}/{n_brack_c} {"OK" if n_brack_o==n_brack_c else "MISMATCH"}')
    print(f'        size     : {len(content)} bytes')
    print()

# 3. Check required content features
print('=== Feature presence check ===')
content_js = (ROOT / 'content' / 'content.js').read_text(encoding='utf-8')
features = {
    'Region screenshot / selection rect': ['startSelection', 'Selection'],
    'Annotations (arrow/rect/text/pencil)': ['addAnnotation', "type: 'arrow'", "type: 'rect'", "type: 'text'", "type: 'pencil'"],
    'Mosaic': ['mosaic', 'pixelSize', 'pixelate'],
    'Numbered labels': ['numbered', 'autoNumber', '序号'],
    'Undo/Redo': ['undo', 'redo'],
    'Element-level screenshot': ['element', 'hover', 'elCapture'],
    'Long page stitching': ['captureLongPage', 'scrollTo', 'stitch'],
    'Export PNG/JPEG/Clipboard': ['exportPNG', 'exportJPEG', 'copyClipboard'],
    'chrome.storage for prefs': ['chrome.storage', 'loadSettings', 'saveSettings'],
    'Selection handles (8-way)': ['handle', 'resize'],
    'Coordinate guide lines': ['guide', 'snap'],
    'Filename w/ title + timestamp': ['title', 'timestamp', 'filename'],
}
for label, keys in features.items():
    found = sum(1 for k in keys if k in content_js)
    print(f'  {label}: {found}/{len(keys)} {"OK" if found else "MISSING"}')

# 4. Check popup
print()
print('=== Popup feature check ===')
popup_js = (ROOT / 'popup' / 'popup.js').read_text(encoding='utf-8')
popup_features = {
    'Activate region capture': ['captureRegion', 'region'],
    'Activate fullpage capture': ['captureFullPage', 'fullPage', 'fullpage'],
    'Activate element capture': ['captureElement', 'element'],
    'Long page capture': ['captureLongPage', 'longPage', 'longpage'],
    'Shortcut hint': ['shortcut', 'Ctrl', 'Shift'],
    'Persist settings': ['storage', 'save', 'load'],
}
for label, keys in popup_features.items():
    found = sum(1 for k in keys if k.lower() in popup_js.lower())
    print(f'  {label}: {found}/{len(keys)} {"OK" if found else "MISSING"}')

print()
print('=== Background feature check ===')
bg_js = (ROOT / 'background.js').read_text(encoding='utf-8')
bg_features = {
    'Command listener (toolbar)': ['chrome.commands', 'onCommand'],
    'Tab capture API': ['chrome.tabs', 'captureVisibleTab'],
    'Message routing': ['chrome.runtime', 'onMessage', 'sendMessage'],
    'Download API': ['chrome.downloads', 'download'],
}
for label, keys in bg_features.items():
    found = sum(1 for k in bg_js.split('\n') if any(k2 in k for k2 in keys))
    print(f'  {label}: lines with hits = {found}')

print()
print('=== DONE ===')