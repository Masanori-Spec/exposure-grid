"""Original 16×16 artwork. Standard library only. Not a converter oracle."""
from pathlib import Path
import struct, zlib, json, hashlib
ROOT = Path(__file__).resolve().parents[1] / 'fixtures'
def chunk(kind, value):
    return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', zlib.crc32(kind + value) & 0xffffffff)
def image(rgb, box):
    rows = []
    for y in range(16):
        row = bytearray([0])
        for x in range(16):
            row += bytes((*rgb, 255) if x < box and y < box else (0, 0, 0, 0))
        rows.append(row)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 16, 16, 8, 6, 0, 0, 0)) + chunk(b'sRGB', b'\0') + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')
images = {'A.png': ((255,0,0),10),'B.png':((0,0,255),10),'C.png':((255,0,255),10),'X.png':((0,255,0),16),'Y.png':((255,255,0),16)}
for name, (rgb, box) in images.items():
    (ROOT/'source.frames'/name).write_bytes(image(rgb, box))
rows = ['UTF-8, TVPaint, "CSV 1.0"','Project Name, Width, Height, Frame Count, Layer Count, Frame Rate, Pixel Aspect Ratio, Field Mode','"Original two-layer timing study", 16, 16, 24, 2, 12.000000, 1.000000, Progressive','#Layers, "Layer A", "Layer B"','#Density, 1.000000, 1.000000','#Blending, "Color", "Color"','#Visible, 1, 1']
for frame in range(24):
    a = 'A.png' if frame < 6 else 'B.png' if frame < 12 else 'C.png'
    b = '' if frame < 3 else 'X.png' if frame < 9 else '' if frame < 15 else 'Y.png'
    rows.append(f'#{frame:05d}, "{a}", "{b}"')
(ROOT/'source.csv').write_bytes(('\r\n'.join(rows)+'\r\n').encode())
(ROOT/'png-sha256.json').write_text(json.dumps({name:hashlib.sha256((ROOT/'source.frames'/name).read_bytes()).hexdigest() for name in images},indent=2)+'\n')
