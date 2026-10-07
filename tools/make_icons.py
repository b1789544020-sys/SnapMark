"""Generate SnapMark extension icons (PNG, RGBA, no external deps)."""
import struct, zlib, os

def make_png(path, size, fill=(26, 115, 232, 255)):
    w = h = size
    pixels = bytearray()
    for y in range(h):
        pixels.append(0)  # filter byte
        for x in range(w):
            r = int(fill[0] * (1 - y/h*0.3) + 66 * (y/h*0.3))
            g = int(fill[1] * (1 - y/h*0.3) + 133 * (y/h*0.3))
            b = int(fill[2] * (1 - y/h*0.3) + 244 * (y/h*0.3))
            a = 255
            cx, cy = w/2, h/2 + h*0.1
            rw, rh = w*0.5, h*0.4
            in_rect = abs(x - cx) < rw and abs(y - cy) < rh
            in_lens = ((x - cx)**2 + (y - cy)**2) < (h*0.18)**2
            if in_lens:
                r, g, b, a = 255, 255, 255, 255
                if ((x - cx)**2 + (y - cy)**2) < (h*0.12)**2:
                    r, g, b, a = 26, 115, 232, 255
            elif in_rect:
                r, g, b, a = 255, 255, 255, 255
            pixels.extend([r, g, b, a])

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(pixels), 9)
    png = sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)
    print(f'Wrote {path} ({size}x{size}, {len(png)} bytes)')

if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    icons_dir = os.path.join(os.path.dirname(here), 'icons')
    os.makedirs(icons_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        make_png(os.path.join(icons_dir, f'icon-{size}.png'), size)
    print('All icons created.')