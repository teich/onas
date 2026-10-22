#!/usr/bin/env python3
"""
Render the exported point cloud (model.json + points.bin) the way the dashboard will: tiny emissive
points on black, with a depth test so you see surfaces rather than the whole stack, plus a soft glow.
Pure numpy, no GPU:

  python3 model/wtr-max/preview_points.py --dir client/public/wtr-max --out <png> [--view front|rear|top|side]
         [--exploded] [--xray] [--parts] [--size 1600x1000] [--only shell,board]

--xray drops Exterior points of the shell so the interior shows; --parts colours by part kind.
"""
import argparse, json, math, os, struct, sys, zlib
import numpy as np

KIND_COL = {
    'shell': (0.62, 0.78, 1.0), 'hdd': (0.45, 0.85, 1.0), 'sled': (0.75, 0.6, 1.0), 'nvme': (0.95, 0.55, 1.0),
    'backplane': (0.4, 1.0, 0.7), 'board': (0.4, 0.95, 0.5), 'cpu': (1.0, 0.6, 0.25), 'ram': (1.0, 0.85, 0.3),
    'fan': (0.35, 1.0, 0.95), 'psu': (1, 1, 1), 'port': (1.0, 0.9, 0.4), 'io': (1.0, 0.8, 0.5), 'led': (0.4, 1.0, 0.4), 'screen': (1.0, 0.75, 0.3),
}


def write_png(path, img):
    h, w, _ = img.shape
    raw = b''.join(b'\x00' + img[y].tobytes() for y in range(h))

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + \
        chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def load(d):
    man = json.load(open(os.path.join(d, 'model.json')))
    raw = np.fromfile(os.path.join(d, 'points.bin'), dtype=np.dtype(
        [('x', '<u2'), ('y', '<u2'), ('z', '<u2'), ('nx', 'i1'), ('ny', 'i1'), ('nz', 'i1'), ('part', 'u1'), ('tone', 'u1'), ('flags', 'u1')]))
    lo, hi = np.array(man['bounds']['min']), np.array(man['bounds']['max'])
    P = np.stack([raw['x'], raw['y'], raw['z']], axis=1).astype(np.float64) / 65535.0 * (hi - lo) + lo
    N = np.stack([raw['nx'], raw['ny'], raw['nz']], axis=1).astype(np.float64) / 127.0
    return man, P, N, raw['part'].astype(int), raw['tone'].astype(np.float64) / 255.0, raw['flags'].astype(int)


def look_at_cam(pos, tgt, fov, aspect):
    pos, tgt = np.array(pos, float), np.array(tgt, float)
    f = tgt - pos
    f /= np.linalg.norm(f)
    r = np.cross(f, [0, 1, 0])
    r /= np.linalg.norm(r)
    u = np.cross(r, f)
    return pos, f, r, u, math.tan(math.radians(fov) / 2), aspect


def fit_camera(P, direction, tgt, fov, aspect, margin=0.92):
    d = np.array(direction, float)
    d /= np.linalg.norm(d)
    lo, hi = P.min(0), P.max(0)
    corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
    dist = 0.3
    for _ in range(200):
        pos, f, r, u, th, asp = look_at_cam(tgt + d * dist, tgt, fov, aspect)
        rel = corners - pos
        zc = rel @ f
        s = max((np.abs(rel @ r) / (zc * th * asp)).max(), (np.abs(rel @ u) / (zc * th)).max())
        if s <= margin:
            break
        dist *= 1.02
    return tgt + d * dist


def render(P, N, tone, color, cam, W, H, size=1.0, glow=0.18, zt=0.0012, gain=1.0, rad=4):
    pos, f, r, u, th, asp = cam
    rel = P - pos
    zc = rel @ f
    ok = zc > 0.05
    # back-face culling, as a splat renderer would: drop points whose normal faces away from the eye
    ok &= np.einsum('ij,ij->i', N, -rel) > 0.02 * np.linalg.norm(rel, axis=1)
    x = (rel @ r) / (zc * th * asp)
    y = (rel @ u) / (zc * th)
    px = ((x * 0.5 + 0.5) * W)
    py = ((0.5 - y * 0.5) * H)
    ok &= (px >= 2) & (px < W - 2) & (py >= 2) & (py < H - 2)
    idx = np.nonzero(ok)[0]
    px, py, zc = px[idx], py[idx], zc[idx]
    ix, iy = px.astype(int), py.astype(int)
    # depth buffer: every point is a small disk lying in its tangent plane, so sparse surfaces close up
    # without hiding grazing surfaces behind their own neighbours
    pc = np.stack([rel[idx] @ r, rel[idx] @ u, zc], axis=1)
    nc = np.stack([N[idx] @ r, N[idx] @ u, N[idx] @ f], axis=1)
    nd = np.einsum('ij,ij->i', nc, pc)
    zb = np.full(W * H, 1e9)
    R = rad
    for dy in range(-R, R + 1):
        for dx in range(-R, R + 1):
            if dx * dx + dy * dy > R * R + 1:
                continue
            sx = ((px + dx) / W * 2 - 1) * th * asp
            sy = (1 - (py + dy) / H * 2) * th
            den = nc[:, 0] * sx + nc[:, 1] * sy + nc[:, 2]
            ok2 = np.abs(den) > 0.15
            zh = np.where(ok2, nd / np.where(ok2, den, 1.0), 1e9)
            ok2 &= (zh > zc * 0.97) & (zh < zc * 1.03)
            jx, jy = ix + dx, iy + dy
            ok2 &= (jx >= 0) & (jx < W) & (jy >= 0) & (jy < H)
            np.minimum.at(zb, (jy * W + jx)[ok2], zh[ok2])
    vis = zc <= zb[iy * W + ix] + zt * (zc / 0.8)
    idx, ix, iy, px, py, zc = idx[vis], ix[vis], iy[vis], px[vis], py[vis], zc[vis]
    # lighting: headlight + key from the upper left, on top of the baked tone
    view = -(f)
    n = N[idx]
    l1 = np.array([-0.4, 0.8, 0.45])
    l1 /= np.linalg.norm(l1)
    lam = 0.45 + 0.55 * np.clip(n @ l1, 0, 1) + 0.25 * np.abs(n @ view)
    b = (tone[idx] * lam) ** 0.85 * 1.5 * gain
    col = color[idx] * b[:, None]
    img = np.zeros((H, W, 3))
    fx, fy = px - ix, py - iy
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            w = np.exp(-((dx - (fx - 0.5)) ** 2 + (dy - (fy - 0.5)) ** 2) / (2 * (0.55 * size) ** 2))
            np.add.at(img, ((iy + dy), (ix + dx)), col * w[:, None])
    # glow: separable box blur, twice
    g = img.copy()
    for rad in (3, 9):
        k = 2 * rad + 1
        c = np.cumsum(np.pad(g, ((0, 0), (rad + 1, rad), (0, 0)), mode='edge'), axis=1)
        g = (c[:, k:] - c[:, :-k]) / k
        c = np.cumsum(np.pad(g, ((rad + 1, rad), (0, 0), (0, 0)), mode='edge'), axis=0)
        g = (c[k:] - c[:-k]) / k
        img = img + glow * g * (rad * 0.5)
    img = 1 - np.exp(-img * 1.1)
    img = img ** (1 / 1.6)
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default='client/public/wtr-max')
    ap.add_argument('--out', required=True)
    ap.add_argument('--view', default='cam', help='cam (manifest camera) | rear | top | side | front | rearhi')
    ap.add_argument('--exploded', action='store_true')
    ap.add_argument('--xray', action='store_true', help='show interior, drop the shell exterior')
    ap.add_argument('--all', action='store_true', help='show every point (default: Exterior only = the closed case)')
    ap.add_argument('--parts', action='store_true')
    ap.add_argument('--only', default='')
    ap.add_argument('--hide', default='')
    ap.add_argument('--size', default='1600x1000')
    ap.add_argument('--fov', type=float, default=None)
    ap.add_argument('--slide', type=float, default=0.0, help='pull trays + sled out by this fraction (0..1)')
    ap.add_argument('--dot', type=float, default=1.0)
    ap.add_argument('--gain', type=float, default=1.0)
    ap.add_argument('--crop', default='', help='x0,y0,x1,y1 as fractions of the frame')
    a = ap.parse_args()
    W, H = [int(v) for v in a.size.split('x')]
    man, P, N, part, tone, flags = load(a.dir)
    P = P.copy()
    parts = man['parts']
    if a.exploded or a.slide:
        for pt in parts:
            m = part == pt['id']
            off = np.zeros(3)
            if a.exploded:
                off += np.array(pt['explode'])
            if a.slide and 'slide' in pt:
                off += np.array(pt['slide']) * a.slide
            P[m] += off
    keep = np.ones(len(P), bool)
    if not a.xray and not a.all and not a.exploded and not a.slide:
        keep &= (flags & 1) > 0
    if a.xray:
        sid = [p['id'] for p in parts if p['key'] == 'shell'][0]
        keep &= ~((part == sid) & ((flags & 1) > 0))
    if a.only:
        ids = [p['id'] for p in parts if p['key'] in a.only.split(',')]
        keep &= np.isin(part, ids)
    if a.hide:
        ids = [p['id'] for p in parts if p['key'] in a.hide.split(',')]
        keep &= ~np.isin(part, ids)
    P, N, part, tone, flags = P[keep], N[keep], part[keep], tone[keep], flags[keep]
    aspect = W / H
    cam0 = man['camera']
    fov = a.fov or cam0['fovDeg']
    tgt = np.array(cam0['target'])
    d0 = np.array(cam0['position']) - tgt
    if a.view == 'cam':
        dirv = d0
    elif a.view == 'rear':
        dirv = np.array([-0.55, 0.35, -0.8])
    elif a.view == 'rearhi':
        dirv = np.array([-0.35, 0.8, -0.6])
    elif a.view == 'top':
        dirv = np.array([0.0, 1.0, 0.001])
    elif a.view == 'side':
        dirv = np.array([1.0, 0.05, 0.0])
    elif a.view == 'under':
        dirv = np.array([0.3, -0.8, 0.5])
    else:
        dirv = np.array([0.0, 0.05, 1.0])
    if a.exploded or a.slide:
        tgt = (P.min(0) + P.max(0)) / 2
    pos = fit_camera(P, dirv, tgt, fov, aspect, margin=0.9)
    if a.view == 'cam' and not (a.exploded or a.slide):
        pos = np.array(cam0['position'])
    cam = look_at_cam(pos, tgt, fov, aspect)
    if a.parts:
        kc = np.array([KIND_COL.get(p['kind'], (1, 1, 1)) for p in parts])
        color = kc[part]
    else:
        color = np.tile(np.array([[0.70, 0.86, 1.0]]), (len(P), 1))
        edge = (flags & 2) > 0
        color[edge] = np.array([0.85, 0.95, 1.0])
    img = render(P, N, tone, color, cam, W, H, size=a.dot, gain=a.gain)
    if a.crop:
        x0, y0, x1, y1 = [float(v) for v in a.crop.split(',')]
        img = img[int(y0 * H):int(y1 * H), int(x0 * W):int(x1 * W)]
    write_png(a.out, img)
    print('wrote', a.out, len(P), 'points')


if __name__ == '__main__':
    main()
