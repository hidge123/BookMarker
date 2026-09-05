"""Generate the small, code-native bookmark icon without external assets."""
import math
import struct
import zlib
from pathlib import Path

out = Path(__file__).resolve().parents[1] / 'public' / 'icons'
out.mkdir(parents=True, exist_ok=True)
def chunk(name, data):
    return struct.pack('>I', len(data)) + name + data + struct.pack('>I', zlib.crc32(name + data) & 0xffffffff)
for size in (16, 32, 48, 128):
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            px, py = (x + .5) / size, (y + .5) / size
            dx, dy = max(.20 - px, 0, px - .80), max(.20 - py, 0, py - .80)
            inside = math.hypot(dx, dy) < .18
            color = (21, 126, 104, 255) if inside else (0, 0, 0, 0)
            bookmark = .33 < px < .67 and .25 < py < .77 - .15 * (1 - abs(px - .5) / .17)
            if bookmark:
                color = (248, 255, 252, 255)
            raw.extend(color)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    (out / f'{size}.png').write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(raw))) + chunk(b'IEND', b''))
