#!/usr/bin/env python3
"""Wireframe PNG of a dumped Layout JSON (tools/score.mjs --dump DIR): boxes, edges, labels."""
import json, sys, math
from PIL import Image, ImageDraw, ImageFont

src, dst = sys.argv[1], sys.argv[2]
scale = float(sys.argv[3]) if len(sys.argv) > 3 else 0.6
l = json.load(open(src))
xs = [n['x'] for n in l['nodes']] + [p['x'] for e in l['edges'] for p in e['points']]
ys = [n['y'] for n in l['nodes']] + [p['y'] for e in l['edges'] for p in e['points']]
xe = [n['x'] + n['w'] for n in l['nodes']]; ye = [n['y'] + n['h'] for n in l['nodes']]
minx, miny = min(xs) - 20, min(ys) - 20
W = int((max(xe + xs) - minx + 20) * scale); H = int((max(ye + ys) - miny + 20) * scale)
im = Image.new('RGB', (W, H), (12, 16, 22)); d = ImageDraw.Draw(im)
try: font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', max(7, int(11 * scale)))
except Exception: font = ImageFont.load_default()
T = lambda x, y: ((x - minx) * scale, (y - miny) * scale)
COL = {'actor': (120, 170, 230), 'external': (140, 140, 150), 'datastore': (200, 160, 90), 'cache': (200, 160, 90), 'system': (90, 110, 140)}
for n in sorted(l['nodes'], key=lambda n: -n['w'] * n['h']):
    c = COL.get(n['kind'], (110, 180, 150))
    x0, y0 = T(n['x'], n['y']); x1, y1 = T(n['x'] + n['w'], n['y'] + n['h'])
    if n['isBoundary']:
        d.rectangle([x0, y0, x1, y1], outline=c, width=1, fill=(18, 24, 32))
        d.text((x0 + 4, y0 + 3), n['label'] + ' [' + n['kind'] + ']', fill=c, font=font)
    else:
        d.rectangle([x0, y0, x1, y1], outline=c, width=2, fill=(24, 34, 46))
        d.text((x0 + 4, y0 + 4), n['label'][:26], fill=(220, 225, 230), font=font)
        d.text((x0 + 4, y0 + 4 + 12 * scale), '[' + n['kind'] + ']', fill=c, font=font)
for e in l['edges']:
    pts = [T(p['x'], p['y']) for p in e['points']]
    if len(pts) < 2: continue
    col = (80, 200, 180) if e.get('derived') else (100, 150, 200)
    d.line(pts, fill=col, width=1)
    ax, ay = pts[-1]; bx, by = pts[-2]
    ang = math.atan2(ay - by, ax - bx)
    d.polygon([(ax, ay), (ax - 6 * math.cos(ang - 0.4), ay - 6 * math.sin(ang - 0.4)), (ax - 6 * math.cos(ang + 0.4), ay - 6 * math.sin(ang + 0.4))], fill=col)
    if e.get('label'):
        # midpoint by length, like the renderer
        seg = [math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]; tot = sum(seg); w = 0
        for i, s in enumerate(seg):
            if w + s >= tot / 2 or i == len(seg) - 1:
                t = 0 if s == 0 else (tot / 2 - w) / s
                mx = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t; my = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t
                break
            w += s
        tw = d.textlength(e['label'], font=font)
        d.rectangle([mx - tw / 2 - 2, my - 12 * scale - 2, mx + tw / 2 + 2, my + 2], fill=(10, 15, 22))
        d.text((mx - tw / 2, my - 12 * scale), e['label'], fill=(160, 180, 200), font=font)
im.save(dst)
print(dst, W, H)
