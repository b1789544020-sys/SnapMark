"""Confirm feature evidence in code (called by terminal)."""
import re
from pathlib import Path

ROOT = Path(r'C:\Users\86159\Desktop\SnapMark')
content = (ROOT / 'content' / 'content.js').read_text(encoding='utf-8')
popup = (ROOT / 'popup' / 'popup.js').read_text(encoding='utf-8')
bg = (ROOT / 'background.js').read_text(encoding='utf-8')
src = content + '\n' + popup + '\n' + bg

checks = {
    'PNG export':         ['png', 'image/png', 'toBlob', 'toDataURL'],
    'JPEG export':        ['jpeg', 'image/jpeg', 'quality'],
    'Clipboard copy':     ['clipboard', 'writeText', 'navigator.clipboard'],
    'Long page in popup': ['longPage', 'captureLong', 'long'],
    'Shortcuts in popup': ['shortcut', 'Ctrl', 'Alt', 'Shift'],
    'Element capture':    ['elCapture', 'Element'],
    'Numbered labels':    ['numbered', 'autoNumber', '\u5e8f\u53f7'],
    'Mosaic/pixelate':    ['pixelate', 'mosaic', 'pixelSize', 'getImageData'],
}

lines = ['=== Feature evidence ===']
for label, keys in checks.items():
    hits = [k for k in keys if re.search(re.escape(k), src, re.I)]
    lines.append(f'  {label}: hits={hits}')

lines.append('')
lines.append('=== content.js defined function names ===')
fns = re.findall(r'(?:async\s+)?function\s+(\w+)|(\w+)\s*=\s*(?:async\s+)?\(', content)
names = set()
for a, b in fns:
    if a: names.add(a)
    if b: names.add(b)
for n in sorted(names):
    lines.append(f'  - {n}')

lines.append('')
lines.append('=== popup.js defined function names ===')
fns2 = re.findall(r'(?:async\s+)?function\s+(\w+)|(\w+)\s*=\s*(?:async\s+)?\(', popup)
for a, b in fns2:
    if a: names.add(a); lines.append(f'  - {a}')
    if b: names.add(b); lines.append(f'  - {b}')

lines.append('')
lines.append('=== background.js defined function names ===')
fns3 = re.findall(r'(?:async\s+)?function\s+(\w+)|(\w+)\s*=\s*(?:async\s+)?\(', bg)
for a, b in fns3:
    if a: lines.append(f'  - {a}')
    if b: lines.append(f'  - {b}')

(ROOT / 'tools' / 'verify_result.txt').write_text('\n'.join(lines), encoding='utf-8')
print('Wrote', ROOT / 'tools' / 'verify_result.txt')