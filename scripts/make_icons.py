"""Rasterize the Big Dog favicon geometry (public/favicon.svg) to touch-icon
PNGs, stdlib only. The glyph is pure polygons and butt-capped lines, so exact
coverage comes from 4x4 subpixel sampling — no SVG renderer needed.

Apple touch icons must be opaque (iOS floods transparency with black and
rounds corners itself), so these carry the board field the SVG favicon
deliberately dropped.
"""
import struct, sys, zlib

BG = (0x0C, 0x0F, 0x13)
ACC = (0xF5, 0xC5, 0x18)
DY = 0.7  # the favicon's vertical recentre of the 24-unit glyph

HEAD = [(4, 5.5), (6.8, 3), (9.4, 6), (14.6, 6), (17.2, 3), (20, 5.5),
        (20, 12.5), (17.2, 15.5), (17.2, 19.5), (6.8, 19.5), (6.8, 15.5),
        (4, 12.5)]
NOSE = [(11, 16.6), (13, 16.6), (12.65, 18.2), (11.35, 18.2)]
# (x1, y1, x2, y2, stroke-width) — the hm-dog mask's ear notches and mouth
CUTS = [(7, 4.3, 8.5, 6.1, 1.05), (17, 4.3, 15.5, 6.1, 1.05),
        (7.4, 15.2, 16.6, 15.2, 1.05)]


def in_poly(pts, x, y):
    inside = False
    for i in range(len(pts)):
        (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % len(pts)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def on_line(x1, y1, x2, y2, w, x, y):
    dx, dy = x2 - x1, y2 - y1
    t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)
    if not 0 <= t <= 1:  # butt caps: nothing past the endpoints
        return False
    px, py = x1 + t * dx, y1 + t * dy
    return (x - px) ** 2 + (y - py) ** 2 <= (w / 2) ** 2


def dog_coverage(x, y):
    """Subpixel test in 24-unit glyph space: yellow iff inside the head and
    outside every negative-space detail."""
    y -= DY
    if not in_poly(HEAD, x, y):
        return False
    if in_poly(NOSE, x, y):
        return False
    return not any(on_line(*c, x, y) for c in CUTS)


def render(size):
    rows, s = [], 24 / size
    sub = [(i + 0.5) / 4 for i in range(4)]
    for py in range(size):
        row = bytearray([0])  # filter byte: None
        for px in range(size):
            hits = sum(dog_coverage((px + sx) * s, (py + sy) * s)
                       for sx in sub for sy in sub)
            a = hits / 16
            row += bytes(round(b * (1 - a) + f * a) for b, f in zip(BG, ACC))
        rows.append(bytes(row))
    return b"".join(rows)


def chunk(typ, data):
    return (struct.pack(">I", len(data)) + typ + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))


def png(size):
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(render(size), 9))
            + chunk(b"IEND", b""))


if __name__ == "__main__":
    out = sys.argv[1]
    for name, size in (("apple-touch-icon.png", 180), ("icon-192.png", 192),
                       ("icon-512.png", 512)):
        data = png(size)
        with open(f"{out}/{name}", "wb") as f:
            f.write(data)
        print(name, size, f"{len(data)} bytes")
