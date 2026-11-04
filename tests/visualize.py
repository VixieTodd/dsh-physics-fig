# Visual QA: rasterize the layout plan with Pillow (same geometry as the SVG).
# Not part of the plugin; a test utility to eyeball the golden scene.
import math
import sys
sys.path.insert(0, '.')

from PIL import Image, ImageDraw

# reuse node layout by shelling out? No: reimplement minimally by reading the SVG numbers.
# Simplest robust route: parse our own SVG (we control the primitive set).

def parse_points(s):
    return [tuple(map(float, p.split(','))) for p in s.split()]

def main(svg_path, png_path):
    import xml.etree.ElementTree as ET
    ns = {'svg': 'http://www.w3.org/2000/svg'}
    tree = ET.parse(svg_path)
    root = tree.getroot()
    W, H = int(root.get('width')), int(root.get('height'))
    img = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(img)

    def fnum(el, k):
        v = el.get(k)
        return float(v) if v is not None else None

    for el in root:
        tag = el.tag.split('}')[-1]
        if tag == 'rect' and el.get('fill') in (None, '#ffffff'):
            d.rectangle([fnum(el,'x'), fnum(el,'y'), fnum(el,'x')+fnum(el,'width'), fnum(el,'y')+fnum(el,'height')], fill='#ffffff')
        elif tag == 'polygon':
            pts = parse_points(el.get('points'))
            fill = el.get('fill')
            stroke = el.get('stroke')
            if fill and fill != 'none':
                d.polygon(pts, fill=fill, outline=stroke)
            else:
                d.line(pts + [pts[0]], fill=stroke or '#000', width=2)
        elif tag == 'line':
            d.line([fnum(el,'x1'), fnum(el,'y1'), fnum(el,'x2'), fnum(el,'y2')],
                   fill=el.get('stroke') or '#000', width=int(float(el.get('stroke-width') or 2)))
        elif tag == 'path':
            # arc: M x y A r r 0 lf sf x y — approximate with a polyline
            parts = el.get('d').replace(',', ' ').split()
            if parts[0] == 'M' and 'A' in parts:
                i = parts.index('A')
                x0, y0 = float(parts[1]), float(parts[2])
                r = float(parts[i+1])
                sf = int(parts[i+5])
                x1, y1 = float(parts[i+6]), float(parts[i+7])
                cx, cy = x0 + r, y0  # good enough for our small angle arcs at axis-aligned start
                a0 = math.atan2(y0 - cy, x0 - cx)
                a1 = math.atan2(y1 - cy, x1 - cx)
                if sf == 1 and a1 < a0: a1 += 2*math.pi
                if sf == 0 and a1 > a0: a1 -= 2*math.pi
                pts = [(cx + r*math.cos(a0 + (a1-a0)*t/20), cy + r*math.sin(a0 + (a1-a0)*t/20)) for t in range(21)]
                d.line(pts, fill=el.get('stroke') or '#000', width=int(float(el.get('stroke-width') or 1.5)))
        elif tag == 'text':
            x, y = fnum(el,'x'), fnum(el,'y')
            txt = el.text or ''
            color = el.get('fill') or '#111'
            try:
                from PIL import ImageFont
                font = ImageFont.load_default(size=int(float(el.get('font-size') or 14)))
            except Exception:
                font = None
            d.text((x, y), txt, fill=color, font=font, anchor='mm')
    img.save(png_path)
    print('saved', png_path)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
