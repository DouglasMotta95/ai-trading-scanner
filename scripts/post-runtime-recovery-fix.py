from pathlib import Path

p = Path('src/content/network-bridge.js')
text = p.read_text()
old = """    const resolvedAsset = focus && cleanAsset && sameAsset(cleanAsset, focus)
      ? focus
      : (!focus && allowUnfocused ? cleanAsset : '');
    if (!resolvedAsset || price == null) return;
"""
new = """    if (focus && (!cleanAsset || !sameAsset(cleanAsset, focus))) return;
    const resolvedAsset = focus || (!focus && allowUnfocused ? cleanAsset : '');
    if (!resolvedAsset || price == null) return;
"""
if old not in text:
    raise SystemExit('network focus lock anchor not found')
p.write_text(text.replace(old, new, 1))
print('explicit visual focus lock applied')
