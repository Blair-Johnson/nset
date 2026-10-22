"""Generate deterministic native-resolution PNG frames using only the standard library."""
import math
import struct
import zlib


def frame_png(frame, run=0, width=480, height=320):
    def chunk(kind, data):
        crc = zlib.crc32(kind + data) & 0xffffffff
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)

    rows = bytearray()
    cx = width * (0.25 + 0.5 * frame)
    cy = height * (0.5 + 0.2 * math.sin(frame * math.tau))
    for y in range(height):
        rows.append(0)
        for x in range(width):
            distance = math.hypot(x - cx, y - cy)
            wave = (math.sin(distance / (10 + 2 * run) - frame * 8) + 1) / 2
            inside = distance < 30 + frame * 20
            grid = x % 40 == 0 or y % 40 == 0
            if grid:
                color = (100, 115, 140)
            elif inside:
                color = (245, 185 + run * 15, 70)
            else:
                color = (int(15 + 25 * wave), int(30 + 110 * wave), int(70 + 130 * wave))
            rows.extend(color)
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(rows), 6)) + chunk(b"IEND", b""))
