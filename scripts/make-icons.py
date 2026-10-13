#!/usr/bin/env python3
"""Write simple valid PNG icons. No third-party image library."""

import struct
import zlib
from pathlib import Path

def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

def png(size: int) -> bytes:
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            cx = x - (size - 1) / 2
            cy = y - (size - 1) / 2
            radius = size * 0.36
            if cx * cx + cy * cy <= radius * radius:
                raw.extend((31, 107, 74, 255))
            else:
                raw.extend((246, 241, 232, 255))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")

out = Path(__file__).resolve().parents[1] / "extension" / "icons"
out.mkdir(parents=True, exist_ok=True)
for size in (16, 48, 128):
    (out / f"icon-{size}.png").write_bytes(png(size))
