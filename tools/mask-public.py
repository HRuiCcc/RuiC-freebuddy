#!/usr/bin/env python3
"""公开页配图打码：按 shot-public.mjs 量出的矩形，把「账号名字 / 手机号」马赛克掉。

用法：python3 tools/mask-public.py <原始图.png> <masks.json> <输出.png>
块大小 8 CSS 像素、四周各留 2 CSS 像素盖住文字抗锯齿——与 2026-10-12 之前的公开图同款。
"""
import json
import sys

from PIL import Image

raw, mask_json, out = sys.argv[1], sys.argv[2], sys.argv[3]
im = Image.open(raw).convert('RGB')
spec = json.load(open(mask_json))
scale = spec['scale']
BLOCK = 8  # CSS 像素，输出图上按 scale 换算
PAD = 2    # CSS 像素

masked = 0
for m in spec['masks']:
    r = m['rect']
    x0 = max(0, int((r['x'] - PAD) * scale))
    y0 = max(0, int((r['y'] - PAD) * scale))
    x1 = min(im.width, int((r['x'] + r['w'] + PAD) * scale + 0.5))
    y1 = min(im.height, int((r['y'] + r['h'] + PAD) * scale + 0.5))
    if x1 <= x0 or y1 <= y0:  # 在可视区外（例如被面板滚动裁掉的账号行）
        continue
    b = max(1, int(round(BLOCK * scale)))
    tile = im.crop((x0, y0, x1, y1))
    small = tile.resize((max(1, (x1 - x0) // b), max(1, (y1 - y0) // b)), Image.BOX)
    im.paste(small.resize((x1 - x0, y1 - y0), Image.NEAREST), (x0, y0))
    masked += 1

im.save(out)
print('已打码', masked, '/', len(spec['masks']), '块 →', out)
