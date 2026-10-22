"""
AOOSTAR WTR MAX -> sampled point cloud for the onas Machine view.

Run headless:
  blender -b --factory-startup --python model/wtr-max/build.py -- \
      --out client/public/wtr-max --points 200000 --blend <scratch>/wtr-max.blend

Builds the machine in Blender's native Z-up frame (front faces -Y), in metres at real size,
one collection per part key from client/src/viz/machine/types.ts. It then samples the final
meshes (after booleans) into an even, area-weighted point cloud with sharp-edge points, bakes
tone = albedo x ambient occlusion and the Exterior/Interior/Edge flags, and writes
model.json + points.bin in the contract frame (+y up, front +z, origin = footprint centre
on the floor):  model x = bx,  y = bz,  z = -by.

All dimensions below are millimetres in the *Blender* frame: X to the machine's right as seen
from the front, Y toward the rear (the front face is at -Y), Z up.  See README.md for which
numbers are measured from photos and which are inferred.
"""
import bpy, bmesh, math, sys, os, json, time, argparse
import numpy as np
from mathutils import Vector, Matrix
from mathutils import kdtree as mkd
from mathutils.bvhtree import BVHTree

MM = 0.001
T0 = time.time()


def log(*a):
    print('[wtr %6.1fs]' % (time.time() - T0), *a, flush=True)


def parse_args():
    argv = sys.argv
    argv = argv[argv.index('--') + 1:] if '--' in argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='client/public/wtr-max')
    ap.add_argument('--points', type=int, default=400000)
    ap.add_argument('--blend', default=None)
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--stage', default='all', help='all | model (build only, no sampling)')
    return ap.parse_args(argv)


# ----------------------------------------------------------------------------------------
# materials: tone = how bright the finish is under even light (0..1), plus a display colour
# ----------------------------------------------------------------------------------------
MATS = {
    #  name        tone   display rgb (linear-ish)        rough metal
    'anod':      (0.58, (0.30, 0.31, 0.34), 0.42, 0.85),   # grey anodised aluminium shell
    'bezel':     (0.33, (0.07, 0.07, 0.08), 0.50, 0.60),   # darker front plate
    'black':     (0.26, (0.02, 0.02, 0.025), 0.60, 0.00),  # black plastic / powder coat
    'tray':      (0.74, (0.36, 0.38, 0.43), 0.40, 0.90),   # tray front plates (lighter anodised)
    'steel':     (0.48, (0.28, 0.28, 0.30), 0.45, 0.90),
    'alu':       (0.68, (0.62, 0.62, 0.64), 0.35, 1.00),   # bare aluminium / chrome feet
    'copper':    (0.62, (0.80, 0.38, 0.20), 0.30, 1.00),
    'gold':      (0.80, (0.90, 0.62, 0.18), 0.30, 1.00),
    'pcb':       (0.30, (0.015, 0.035, 0.03), 0.55, 0.00),
    'chip':      (0.18, (0.015, 0.015, 0.016), 0.50, 0.00),
    'label':     (0.86, (0.85, 0.85, 0.82), 0.80, 0.00),
    'labeldark': (0.34, (0.06, 0.06, 0.05), 0.80, 0.00),
    'orange':    (0.70, (0.80, 0.35, 0.02), 0.60, 0.00),
    'yellow':    (0.72, (0.80, 0.70, 0.02), 0.60, 0.00),
    'blue':      (0.55, (0.02, 0.18, 0.75), 0.60, 0.00),
    'glass':     (0.07, (0.005, 0.005, 0.008), 0.08, 0.00),
    'rubber':    (0.09, (0.012, 0.012, 0.012), 0.80, 0.00),
    'led':       (0.95, (0.10, 1.00, 0.30), 0.30, 0.00),
    'ledamber':  (0.92, (1.00, 0.55, 0.05), 0.30, 0.00),
    'blade':     (0.15, (0.03, 0.03, 0.032), 0.55, 0.00),
    'drive':     (0.60, (0.50, 0.50, 0.52), 0.40, 1.00),
    'red':       (0.40, (0.55, 0.03, 0.03), 0.60, 0.00),
}


def get_mat(name):
    m = bpy.data.materials.get(name)
    if m:
        return m
    tone, rgb, rough, metal = MATS[name]
    m = bpy.data.materials.new(name)
    m['tone'] = tone
    m.diffuse_color = (rgb[0], rgb[1], rgb[2], 1.0)
    try:
        m.use_nodes = True
    except Exception:
        pass
    if m.node_tree:
        b = m.node_tree.nodes.get('Principled BSDF')
        if b:
            b.inputs['Base Color'].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
            b.inputs['Roughness'].default_value = rough
            b.inputs['Metallic'].default_value = metal
            if name.startswith('led'):
                try:
                    b.inputs['Emission Color'].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
                    b.inputs['Emission Strength'].default_value = 3.0
                except Exception:
                    pass
    return m


# ----------------------------------------------------------------------------------------
# geometry builder: boxes (optionally chamfered), cylinders, polygon prisms, rounded-rect prisms
# all coordinates in millimetres, Blender frame
# ----------------------------------------------------------------------------------------
def make_xf(c=(0, 0, 0), rot=None):
    M = Matrix.Translation(Vector(c))
    if rot:
        rx, ry, rz = rot
        M = M @ Matrix.Rotation(math.radians(rz), 4, 'Z') @ Matrix.Rotation(math.radians(ry), 4, 'Y') \
            @ Matrix.Rotation(math.radians(rx), 4, 'X')
    return M


def arc_pts(cx, cy, r, a0, a1, seg):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / seg)),
             cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / seg))) for i in range(seg + 1)]


def rrect_pts(cu, cv, w, h, r, seg=6, inset=0.0):
    """counter-clockwise rounded rectangle polygon, optionally inset"""
    w2, h2 = w / 2 - inset, h / 2 - inset
    r = max(0.0, min(r - inset, w2, h2))
    if r <= 1e-6:
        return [(cu - w2, cv - h2), (cu + w2, cv - h2), (cu + w2, cv + h2), (cu - w2, cv + h2)]
    pts = []
    pts += arc_pts(cu + w2 - r, cv - h2 + r, r, -90, 0, seg)
    pts += arc_pts(cu + w2 - r, cv + h2 - r, r, 0, 90, seg)
    pts += arc_pts(cu - w2 + r, cv + h2 - r, r, 90, 180, seg)
    pts += arc_pts(cu - w2 + r, cv - h2 + r, r, 180, 270, seg)
    return pts


class Geo:
    """a bmesh under construction; add primitives, then make_obj()"""

    def __init__(self):
        self.bm = bmesh.new()

    def _v(self, p):
        return self.bm.verts.new((p[0] * MM, p[1] * MM, p[2] * MM))

    def _f(self, vs):
        try:
            return self.bm.faces.new(vs)
        except ValueError:
            return None

    # ---- box with optional chamfer ----
    def box(self, c, s, ch=0.0, rot=None, skip=()):
        h = (s[0] / 2, s[1] / 2, s[2] / 2)
        M = make_xf(c, rot)
        ch = min(ch, min(h) * 0.9)
        P = lambda p: M @ Vector(p)
        names = {('x', -1): '-x', ('x', 1): '+x', ('y', -1): '-y', ('y', 1): '+y', ('z', -1): '-z', ('z', 1): '+z'}
        ax = 'xyz'
        if ch <= 1e-9:
            vs = {}
            for sx in (-1, 1):
                for sy in (-1, 1):
                    for sz in (-1, 1):
                        vs[(sx, sy, sz)] = self._v(P((sx * h[0], sy * h[1], sz * h[2])))
            for a in range(3):
                for sa in (-1, 1):
                    if names[(ax[a], sa)] in skip:
                        continue
                    b, c2 = [i for i in range(3) if i != a]
                    quad = []
                    for (sb, sc) in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                        k = [0, 0, 0]
                        k[a], k[b], k[c2] = sa, sb, sc
                        quad.append(vs[tuple(k)])
                    self._f(quad)
            return
        cache = {}

        def vid(a, sa, signs):
            o = [i for i in range(3) if i != a]
            key = (a, sa, signs[o[0]], signs[o[1]])
            if key not in cache:
                p = [0, 0, 0]
                p[a] = sa * h[a]
                p[o[0]] = signs[o[0]] * (h[o[0]] - ch)
                p[o[1]] = signs[o[1]] * (h[o[1]] - ch)
                cache[key] = self._v(P(p))
            return cache[key]

        for a in range(3):
            for sa in (-1, 1):
                if names[(ax[a], sa)] in skip:
                    continue
                b, c2 = [i for i in range(3) if i != a]
                self._f([vid(a, sa, {b: sb, c2: sc}) for (sb, sc) in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
        for a in range(3):
            for b in range(a + 1, 3):
                c2 = 3 - a - b
                for sa in (-1, 1):
                    for sb in (-1, 1):
                        self._f([vid(a, sa, {b: sb, c2: -1}), vid(a, sa, {b: sb, c2: 1}),
                                 vid(b, sb, {a: sa, c2: 1}), vid(b, sb, {a: sa, c2: -1})])
        for sx in (-1, 1):
            for sy in (-1, 1):
                for sz in (-1, 1):
                    self._f([vid(0, sx, {1: sy, 2: sz}), vid(1, sy, {0: sx, 2: sz}), vid(2, sz, {0: sx, 1: sy})])

    # ---- cylinder / cone along a local axis ----
    def cyl(self, c, r, h, axis='z', seg=24, r2=None, ch=0.0, rot=None, caps=(True, True), phase=0.0):
        r2 = r if r2 is None else r2
        if axis == 'x':
            base = Matrix.Rotation(math.radians(90), 4, 'Y')
        elif axis == 'y':
            base = Matrix.Rotation(math.radians(-90), 4, 'X')
        else:
            base = Matrix.Identity(4)
        M = make_xf(c, rot) @ base
        ch = min(ch, r * 0.45, h * 0.45)
        rings = []
        rr = lambda t: r + (r2 - r) * t
        if ch > 0:
            rings = [(-h / 2, rr(0) - ch), (-h / 2 + ch, rr(ch / h)), (h / 2 - ch, rr(1 - ch / h)), (h / 2, rr(1) - ch)]
        else:
            rings = [(-h / 2, r), (h / 2, r2)]
        vr = []
        for (z, rad) in rings:
            ring = []
            for i in range(seg):
                a = 2 * math.pi * i / seg + math.radians(phase)
                ring.append(self._v(M @ Vector((rad * math.cos(a), rad * math.sin(a), z))))
            vr.append(ring)
        for k in range(len(vr) - 1):
            for i in range(seg):
                j = (i + 1) % seg
                self._f([vr[k][i], vr[k][j], vr[k + 1][j], vr[k + 1][i]])
        if caps[0]:
            self._f(vr[0][::-1])
        if caps[1]:
            self._f(vr[-1])

    # ---- extruded polygon (concave ok), plane coords -> axis ----
    def prism(self, pts, axis, a0, a1, caps=True):
        def P(u, v, a):
            if axis == 'y':
                return (u, a, v)
            if axis == 'z':
                return (u, v, a)
            return (a, u, v)
        r0 = [self._v(P(u, v, a0)) for (u, v) in pts]
        r1 = [self._v(P(u, v, a1)) for (u, v) in pts]
        n = len(pts)
        for i in range(n):
            j = (i + 1) % n
            self._f([r0[i], r0[j], r1[j], r1[i]])
        if caps:
            self._f(r0[::-1])
            self._f(r1)

    def rrect_prism(self, c2, axis, w, h, r, a0, a1, seg=6, ch0=0.0, ch1=0.0):
        """rounded-rect (centred c2=(u,v), size w x h) extruded a0->a1 with optional end chamfers"""
        def P(u, v, a):
            if axis == 'y':
                return (u, a, v)
            if axis == 'z':
                return (u, v, a)
            return (a, u, v)
        spec = []
        if ch0 > 0:
            spec.append((a0, ch0))
        spec.append((a0 + ch0, 0.0))
        spec.append((a1 - ch1, 0.0))
        if ch1 > 0:
            spec.append((a1, ch1))
        rings = []
        for (a, ins) in spec:
            pts = rrect_pts(c2[0], c2[1], w, h, r, seg, inset=ins)
            rings.append([self._v(P(u, v, a)) for (u, v) in pts])
        n = len(rings[0])
        for k in range(len(rings) - 1):
            for i in range(n):
                j = (i + 1) % n
                self._f([rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]])
        self._f(rings[0][::-1])
        self._f(rings[-1])

    def grid_surface(self, G0, G1=None):
        """G0, G1: lists of rows of (x,y,z) mm points; builds a thin solid between two offset grids"""
        def mk(G):
            return [[self._v(p) for p in row] for row in G]
        A = mk(G0)
        B = mk(G1) if G1 is not None else None
        nr, nc = len(G0), len(G0[0])
        for i in range(nr - 1):
            for j in range(nc - 1):
                self._f([A[i][j], A[i][j + 1], A[i + 1][j + 1], A[i + 1][j]])
                if B:
                    self._f([B[i][j], B[i + 1][j], B[i + 1][j + 1], B[i][j + 1]])
        if B:
            for i in range(nr - 1):
                self._f([A[i][0], A[i + 1][0], B[i + 1][0], B[i][0]])
                self._f([A[i][nc - 1], B[i][nc - 1], B[i + 1][nc - 1], A[i + 1][nc - 1]])
            for j in range(nc - 1):
                self._f([A[0][j], B[0][j], B[0][j + 1], A[0][j + 1]])
                self._f([A[nr - 1][j], A[nr - 1][j + 1], B[nr - 1][j + 1], B[nr - 1][j]])


# ----------------------------------------------------------------------------------------
# parts registry and object creation
# ----------------------------------------------------------------------------------------
COLL = {}


def part_collection(key):
    if key not in COLL:
        c = bpy.data.collections.new(key)
        bpy.context.scene.collection.children.link(c)
        COLL[key] = c
    return COLL[key]


def make_obj(part, name, geo, mat, dens=1.0, fix_normals=True):
    bm = geo.bm
    if len(bm.faces) == 0:
        bm.free()
        return None
    if fix_normals:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(part + '.' + name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(part + '.' + name, me)
    part_collection(part).objects.link(ob)
    ob['mat'] = mat
    ob['dens'] = float(dens)
    ob.data.materials.append(get_mat(mat))
    return ob


_cutter_coll = None


def apply_mods(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    if not me.materials:
        me.materials.append(get_mat(ob['mat']))
    bpy.data.meshes.remove(old)


def boolean(ob, geo, op='DIFFERENCE'):
    """cut (or union) a Geo into object ob using the exact solver"""
    global _cutter_coll
    if ob is None:
        geo.bm.free()
        return
    if _cutter_coll is None:
        _cutter_coll = bpy.data.collections.new('_cutters')
        bpy.context.scene.collection.children.link(_cutter_coll)
    bm = geo.bm
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new('_cut')
    bm.to_mesh(me)
    bm.free()
    cob = bpy.data.objects.new('_cut', me)
    _cutter_coll.objects.link(cob)
    mod = ob.modifiers.new('bool', 'BOOLEAN')
    mod.operation = op
    mod.object = cob
    mod.solver = 'EXACT'
    mod.use_self = True
    apply_mods(ob)
    bpy.data.objects.remove(cob)
    bpy.data.meshes.remove(me)


# part registry: key, kind, label, budget weight; filled in by the build_* functions
PARTS = {}
ORDER = []


def declare(key, kind, label, w, **kw):
    PARTS[key] = dict(key=key, kind=kind, label=label, w=w, **kw)
    ORDER.append(key)
    part_collection(key)


# ----------------------------------------------------------------------------------------
# machine constants (mm, Blender frame: +X right of the front view, +Y to the rear, +Z up)
# ----------------------------------------------------------------------------------------
X0 = 124.5            # half width  (249 mm overall)
YF, YR = -122.5, 122.5  # front / rear faces (245 mm deep)
ZB, ZT = 8.0, 195.0   # body bottom (feet are 8 mm) and top (195 mm overall height)
ZS = 68.0             # seam between the drive-cage tier and the board tier
TX = [-93.0, -62.0, -31.0, 0.0, 31.0, 62.0, 93.0]   # tray centres: [0] = M.2 sled, [1..6] = bays
TRAY_FRONT = -116.0   # front face of the tray plates (recessed behind the bezel)
TRAY_Z0, TRAY_Z1 = 68.4, 174.4
DRIVE_Y0, DRIVE_Y1 = -108.0, 39.0   # 147 mm long 3.5" drive
BP_Y = 52.0           # backplane PCB front face
FAN_Z = 133.2
FAN_X = (53.1, -53.1)   # fan1 (machine right), fan2 (machine left)
BOARD_Z0, BOARD_Z1 = 33.0, 34.6   # main board PCB (components below and above)
PORT_Z = 30.9


# Front LCD: glass 91.5 x 40 mm (measured from p/32 against the 249 mm case width). The panel is 960 x 376 pixels
# (community protocol notes for the AOOSTAR-X screen, see README); the model carries it as a quarter-resolution
# 240 x 94 dot grid, which keeps the dot pitch square at the panel's 2.553 aspect. The active area is inset in the glass.
LCD_C = (-69.5, 40.1)        # glass centre (x, z), mm
LCD_GLASS = (91.5, 40.0, 6.5)  # width, height, corner radius
LCD_COLS, LCD_ROWS = 240, 94
LCD_W = 86.0                 # active width, mm
LCD_H = LCD_W * LCD_ROWS / LCD_COLS
LCD_Y = -121.95              # front face of the glass (Blender y)
LCD_TONE = 0.9


def u_shell(z_open, z_far, r, wall, up):
    """(x,z) polygon of a U-shaped wrap: closed at z_far (top if up else bottom), open at z_open"""
    s = 1 if up else -1
    cz = z_far - s * r
    a_out_l = (180, 90) if up else (180, 270)
    a_out_r = (90, 0) if up else (270, 360)
    a_in_r = (0, 90) if up else (360, 270)
    a_in_l = (90, 180) if up else (270, 180)
    cl, cr = (-X0 + r, cz), (X0 - r, cz)
    seg = 8
    P = [(-X0, z_open)]
    P += arc_pts(cl[0], cl[1], r, a_out_l[0], a_out_l[1], seg)
    P += arc_pts(cr[0], cr[1], r, a_out_r[0], a_out_r[1], seg)
    P += [(X0, z_open), (X0 - wall, z_open)]
    P += arc_pts(cr[0], cr[1], r - wall, a_in_r[0], a_in_r[1], seg)
    P += arc_pts(cl[0], cl[1], r - wall, a_in_l[0], a_in_l[1], seg)
    P += [(-X0 + wall, z_open)]
    return P


def text_obj(part, name, txt, size, depth, c, mat, width=None, dens=1.0, rotz=0.0):
    """flat text on a front-facing plane (reads correctly from the front), centred at c (mm)"""
    cu = bpy.data.curves.new('_t', 'FONT')
    cu.body = txt
    cu.size = size * MM
    cu.extrude = depth * 0.5 * MM
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    tob = bpy.data.objects.new('_t', cu)
    bpy.context.scene.collection.objects.link(tob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(tob.evaluated_get(dg))
    bpy.data.objects.remove(tob)
    bpy.data.curves.remove(cu)
    xs = [v.co.x for v in me.vertices]
    sx = 1.0
    if width and xs:
        sx = width * MM / max(1e-9, (max(xs) - min(xs)))
    M = Matrix.Translation(Vector((c[0] * MM, c[1] * MM, c[2] * MM))) @ Matrix.Rotation(math.radians(90), 4, 'X') \
        @ Matrix.Scale(sx, 4, Vector((1, 0, 0)))
    me.transform(M)
    ob = bpy.data.objects.new(part + '.' + name, me)
    part_collection(part).objects.link(ob)
    ob['mat'] = mat
    ob['dens'] = float(dens)
    me.materials.append(get_mat(mat))
    return ob


# ----------------------------------------------------------------------------------------
# SHELL: case, bezel, rear plates, cage, feet, front-panel details
# ----------------------------------------------------------------------------------------
def build_shell():
    P = 'shell'
    declare('shell', 'shell', 'Case', 0.30, explode=(0.0, 0.26, 0.0))

    # -- front bezel: anodised rim + darker front plate with the tray opening --
    zc = (ZB + ZT) / 2
    g = Geo()
    g.rrect_prism((0, zc), 'y', 2 * X0, ZT - ZB, 20, YF, YF + 10, seg=8, ch0=1.0)
    ring = make_obj(P, 'bezel_ring', g, 'anod')
    c = Geo()
    c.rrect_prism((0, zc), 'y', 2 * X0 - 6, ZT - ZB - 6, 17, YF - 1, YF + 12, seg=8)
    boolean(ring, c)

    g = Geo()
    g.rrect_prism((0, zc), 'y', 2 * X0 - 6, ZT - ZB - 6, 17, -121.6, -113.0, seg=8, ch0=0.6)
    plate = make_obj(P, 'bezel_plate', g, 'bezel')
    c = Geo()
    c.rrect_prism((0, 124.05), 'y', 221, 117.3, 4.0, -125, -110, seg=5)      # tray opening
    c.rrect_prism((14.4, 24.6), 'y', 29.0, 2.8, 1.0, -125, -110, seg=4)      # SD slot
    c.rrect_prism((45.9, 26.0), 'y', 14.4, 6.2, 0.6, -125, -110, seg=3)      # USB-A
    c.rrect_prism((72.0, 25.5), 'y', 8.8, 3.2, 1.6, -125, -110, seg=5)       # USB-C
    boolean(plate, c)

    # receptacles behind the front-panel ports
    g = Geo()
    g.box((14.4, -108.0, 24.6), (31, 10, 5.6), ch=0.3)
    g.box((45.9, -107.5, 26.0), (15.4, 11, 7.2), ch=0.3)
    g.box((72.0, -107.5, 25.5), (9.8, 11, 4.2), ch=0.3)
    make_obj(P, 'front_receptacles', g, 'steel')
    g = Geo()
    g.box((45.9, -110.6, 24.9), (12.0, 7.0, 1.8))          # USB 3.0 blue tongue
    make_obj(P, 'front_usb_tongue', g, 'blue')
    g = Geo()
    g.box((72.0, -110.2, 25.5), (6.6, 6.0, 1.0))           # USB-C tongue
    make_obj(P, 'front_usbc_tongue', g, 'black')

    # LCD (secondary display): the dark glass border stays in the shell; the active area is its own part `lcd`
    g = Geo()
    g.rrect_prism(LCD_C, 'y', LCD_GLASS[0], LCD_GLASS[1], LCD_GLASS[2], LCD_Y, -121.0, seg=6, ch0=0.15)
    border = make_obj(P, 'lcd_border', g, 'glass', dens=0.8)
    c = Geo()
    c.box((LCD_C[0], -121.5, LCD_C[1]), (LCD_W, 1.6, LCD_H))
    boolean(border, c)
    declare('lcd', 'screen', 'Front LCD', 0.0, socket=C(LCD_C[0], LCD_Y, LCD_C[1]), explode=(0.0, 0.26, 0.0))
    g = Geo()
    g.box((LCD_C[0], (LCD_Y - 121.0) / 2, LCD_C[1]), (LCD_W, -121.0 - LCD_Y, LCD_H))
    make_obj('lcd', 'screen', g, 'glass', dens=0.0)
    g = Geo()
    g.cyl((95.7, -122.0, 26.0), 4.8, 1.6, axis='y', seg=28, ch=0.45)
    make_obj(P, 'power_button', g, 'black', dens=1.2)
    # gold logo and model plate
    g = Geo()
    g.box((101.4, -121.75, 48.6), (21.7, 0.4, 5.0), ch=0.1)
    make_obj(P, 'model_plate', g, 'gold', dens=2.0)
    text_obj(P, 'logo_aoostar', 'AOOSTAR', 5.2, 0.5, (89.0, -122.2, 55.5), 'gold', width=46.0, dens=6.0)
    text_obj(P, 'logo_model', 'WTR MAX', 3.0, 0.5, (101.4, -122.1, 48.6), 'labeldark', width=18.5, dens=6.0)

    # -- top shell: inverted U (top + both sides), rounded top edges --
    g = Geo()
    g.prism(u_shell(ZS + 0.3, ZT, 16, 2.0, True), 'y', YF + 10, YR)
    top = make_obj(P, 'top_shell', g, 'anod')

    # -- base: U with rounded bottom edges; triangle vents in both side walls, slots in the bottom --
    g = Geo()
    g.prism(u_shell(ZS - 0.3, ZB, 12, 2.0, False), 'y', YF + 10, 120.0)
    base = make_obj(P, 'base', g, 'anod')
    c = Geo()
    b, h = 8.5, 7.36
    y_start, n = -47.0, 35
    for side in (-1, 1):
        for r in range(2):
            zb = 43.0 + r * h
            for i in range(n):
                yc = y_start + i * b / 2
                k = 0.80 * min(1.0, 0.30 + 0.24 * min(i, n - 1 - i))
                up = (i + r) % 2 == 0
                if up:
                    tri = [(yc - b / 2, zb), (yc + b / 2, zb), (yc, zb + h)]
                    cen = (yc, zb + h / 3)
                else:
                    tri = [(yc - b / 2, zb + h), (yc + b / 2, zb + h), (yc, zb)]
                    cen = (yc, zb + 2 * h / 3)
                tri = [(cen[0] + (p[0] - cen[0]) * k, cen[1] + (p[1] - cen[1]) * k) for p in tri]
                c.prism(tri, 'x', side * (X0 - 5), side * (X0 + 2))
    cols = [-48.0, -16.0, 16.0, 48.0]
    for xcen in cols:
        for i in range(18):
            c.rrect_prism((xcen, -19.4 + i * 6.2), 'z', 28.0, 3.2, 1.6, ZB - 1, ZB + 3, seg=4)
    boolean(base, c)

    # -- rear: lower I/O panel (port cut-outs) and upper fan plate (louvres) --
    pts = [(-X0, ZS - 0.3)] + arc_pts(-X0 + 12, ZB + 12, 12, 180, 270, 8) + arc_pts(X0 - 12, ZB + 12, 12, 270, 360, 8) + [(X0, ZS - 0.3)]
    g = Geo()
    g.prism(pts, 'y', 120.0, YR)
    io = make_obj(P, 'rear_io_panel', g, 'black')
    c = Geo()
    for (x, z, w, h2, r) in rear_port_holes():
        c.rrect_prism((x, z), 'y', w, h2, r, 118.5, YR + 1, seg=4)
    boolean(io, c)
    # printed warning labels on the I/O panel
    g = Geo()
    g.box((7.7, 122.1, 46.3), (29.0, 0.3, 9.6))
    make_obj(P, 'label_oculink', g, 'labeldark')
    g = Geo()
    g.box((-69.0, 122.1, 19.5), (52.0, 0.3, 8.0))
    make_obj(P, 'label_poweroff', g, 'yellow')

    pts = [(-122.5, ZS + 0.5), (122.5, ZS + 0.5)] + arc_pts(122.5 - 14, ZT - 2 - 14, 14, 0, 90, 8) + arc_pts(-122.5 + 14, ZT - 2 - 14, 14, 90, 180, 8)
    g = Geo()
    g.prism(pts, 'y', 118.5, 121.0)
    fp = make_obj(P, 'rear_fan_plate', g, 'black')
    c = Geo()
    for fx in FAN_X:
        for i in range(10):
            dz = (i - 4.5) * 8.9
            L = math.sqrt(max(100.0, 46.0 ** 2 - (abs(dz) + 2.3) ** 2)) * 0.96
            colw = L - 1.5
            for s in (-1, 1):
                c.rrect_prism((fx + s * (1.5 + colw / 2), FAN_Z + dz), 'y', colw, 4.6, 2.3, 117.0, 123, seg=4)
    boolean(fp, c)
    g = Geo()
    for fx in FAN_X:
        for sx in (-1, 1):
            for sz in (-1, 1):
                g.cyl((fx + sx * 41.25, 121.0, FAN_Z + sz * 41.25), 4.6, 3.0, axis='y', seg=14, ch=0.5)
    make_obj(P, 'rear_fan_bosses', g, 'black')
    g = Geo()
    for sx in (-1, 1):
        g.cyl((sx * 117.5, 121.0, 141.0), 3.6, 3.0, axis='y', seg=12, ch=0.5)             # thumbscrews
        g.box((sx * 118.5, 122.0, 108.0), (3.4, 2.4, 14.0), ch=0.6)                      # pull tabs
    make_obj(P, 'rear_thumbscrews', g, 'black')

    # -- drive cage (sheet metal): side walls with ovals, ceiling with grommets, floor with rail slots --
    g = Geo()
    for s in (-1, 1):
        g.box((s * 111.25, (YF + 10 + 46) / 2, 124.05), (1.5, 46 - (YF + 10), 118.8))
    wall = make_obj(P, 'cage_walls', g, 'black')
    c = Geo()
    for s in (-1, 1):
        for y in (-72.0, -42.0, -12.0):
            c.rrect_prism((y, 124.0), 'x', 9.0, 34.0, 4.5, s * 108, s * 114, seg=5)
    boolean(wall, c)
    g = Geo()
    g.box((0, (YF + 10 + 46) / 2, 183.45), (225.0, 46 - (YF + 10), 1.5))
    make_obj(P, 'cage_ceiling', g, 'black')
    g = Geo()
    g.box((0, (YF + 10 + 46) / 2, 64.65), (225.0, 46 - (YF + 10), 1.5))
    floor = make_obj(P, 'cage_floor', g, 'black')
    c = Geo()
    for tx in TX:
        for y in (-92.0, -48.0):
            c.rrect_prism((tx, y), 'z', 11.0, 4.5, 2.2, 62, 67, seg=4)
    boolean(floor, c)
    g = Geo()
    for tx in TX:
        for y in (-99.0, -57.0):
            g.cyl((tx, y, 181.2), 6.2, 3.0, axis='z', seg=16, ch=0.6)
    make_obj(P, 'cage_grommets', g, 'rubber')

    # inner chassis plate with the board window (visible when the bottom cover is off)
    g = Geo()
    g.box((0, 4.0, 18.2), (240.0, 232.0, 1.5))
    plt = make_obj(P, 'chassis_plate', g, 'black')
    c = Geo()
    c.rrect_prism((0, 19.5), 'z', 162.0, 157.0, 6.0, 15, 22, seg=4)
    for (x, y) in ((-100, -95), (100, -95), (-100, 105), (100, 105), (-100, 5), (100, 5)):
        c.cyl((x, y, 18.2), 3.5, 4.0, axis='z', seg=10)
    boolean(plt, c)

    # feet and side screws
    g = Geo()
    for (x, y) in ((-84.0, 75.5), (84.0, 75.5), (-84.0, -81.5), (84.0, -81.5)):
        g.cyl((x, y, 4.75), 21.0, 6.5, axis='z', seg=36, ch=1.2)
    make_obj(P, 'feet', g, 'alu', dens=0.7)
    g = Geo()
    for (x, y) in ((-84.0, 75.5), (84.0, 75.5), (-84.0, -81.5), (84.0, -81.5)):
        g.cyl((x, y, 0.75), 19.0, 1.5, axis='z', seg=36)
        g.cyl((x, y, 1.4), 5.5, 0.4, axis='z', seg=12)
    make_obj(P, 'foot_pads', g, 'rubber', dens=0.6)
    g = Geo()
    for s in (-1, 1):
        for y in (-54.0, 105.0):
            g.cyl((s * (X0 + 0.15), y, 48.0), 1.7, 0.8, axis='x', seg=10)
    make_obj(P, 'side_screws', g, 'steel', dens=2.0)


# rear I/O: centre x (front-view coords), centre z, mouth w, h, corner radius (from the rear photo)
def rear_port_holes():
    return [
        (70.5, 30.9, 7.0, 7.0, 3.5),      # 3.5 mm audio
        (53.6, 31.0, 16.0, 6.8, 1.0),     # HDMI
        (53.6, 19.5, 17.5, 7.4, 1.0),     # DisplayPort
        (33.9, 30.6, 14.8, 6.8, 0.5),     # USB-A upper
        (33.9, 22.0, 14.8, 6.8, 0.5),     # USB-A lower
        (16.3, 32.6, 12.8, 5.2, 1.0),     # OCuLink
        (4.2, 29.6, 3.8, 9.4, 1.9),       # USB4 (Type-C, shown vertical)
        (-10.5, 30.9, 16.2, 14.0, 0.8),   # 2.5GbE 2
        (-30.6, 30.9, 16.2, 14.0, 0.8),   # 2.5GbE 1
        (-50.4, 30.9, 14.0, 8.9, 0.6),    # SFP+ 1
        (-68.6, 30.9, 14.0, 8.9, 0.6),    # SFP+ 2
        (-86.7, 30.9, 8.2, 8.2, 4.1),     # DC jack
        (-38.5, 38.8, 1.5, 1.5, 0.75), (-41.0, 38.8, 1.5, 1.5, 0.75),   # SFP1 ACT/Link LEDs
        (-79.0, 38.8, 1.5, 1.5, 0.75), (-81.5, 38.8, 1.5, 1.5, 0.75),   # SFP2 ACT/Link LEDs
    ]


# ----------------------------------------------------------------------------------------
# helpers shared by the component builders
# ----------------------------------------------------------------------------------------
def C(x, y, z):
    """Blender-frame millimetres -> contract-frame metres (x right, y up, z toward the front)"""
    return [round(x * MM, 5), round(z * MM, 5), round(-y * MM, 5)]


class PB:
    """per-part builder: one Geo per material, flushed into objects named <part>.<name>_<mat>"""

    def __init__(self, part, name=None):
        self.part, self.name, self.geos, self.dens = part, name or part, {}, {}

    def g(self, mat, dens=1.0):
        if mat not in self.geos:
            self.geos[mat] = Geo()
            self.dens[mat] = dens
        return self.geos[mat]

    def done(self, cuts=None):
        out = {}
        for mat, g in self.geos.items():
            ob = make_obj(self.part, '%s_%s' % (self.name, mat), g, mat, self.dens[mat])
            out[mat] = ob
            if cuts and mat in cuts:
                boolean(ob, cuts[mat])
        self.geos = {}
        return out


class Frame:
    """local (u,v,w) -> Blender xyz; U,V,W are signed unit axes; used for M.2 sticks in any orientation"""

    def __init__(self, origin, U, V, W):
        self.o, self.U, self.V, self.W = origin, U, V, W

    def c(self, u, v, w):
        return tuple(self.o[i] + u * self.U[i] + v * self.V[i] + w * self.W[i] for i in range(3))

    def sz(self, su, sv, sw):
        return tuple(abs(su * self.U[i] + sv * self.V[i] + sw * self.W[i]) for i in range(3))

    def box(self, pb, mat, c, s, ch=0.0, dens=1.0):
        pb.g(mat, dens).box(self.c(*c), self.sz(*s), ch=ch)

    def cyl(self, pb, mat, c, r, h, axis='w', seg=14, ch=0.0, dens=1.0):
        d = {'u': self.U, 'v': self.V, 'w': self.W}[axis]
        wa = 'xyz'[[i for i in range(3) if abs(d[i]) > 0.5][0]]
        pb.g(mat, dens).cyl(self.c(*c), r, h, axis=wa, seg=seg, ch=ch)


# ----------------------------------------------------------------------------------------
# DRIVE TRAYS: six 3.5" bays with WD Red Plus 6TB inside, plus the M.2 sled carrier
# ----------------------------------------------------------------------------------------
LED_POS = {}      # name -> Blender mm point (centre of a tray's LED pair)


def tray_front(pb, tx, tag):
    zc_plate = (94.2 + 173.4) / 2
    pb.g('tray', 4.0).box((tx, TRAY_FRONT + 1.5, zc_plate), (26.6, 3.0, 79.2), ch=0.8)
    pb.g('black', 3.5).box((tx, TRAY_FRONT + 4.5, (TRAY_Z0 + 93.2) / 2), (24.0, 9.0, 24.8), ch=1.0)       # latch housing
    pb.g('black', 3.5).box((tx, TRAY_FRONT - 0.35, 82.0), (17.0, 0.9, 14.0), ch=0.4)               # latch button
    pb.g('led', 6.0).box((tx - 5.0, TRAY_FRONT + 0.1, 71.0), (4.8, 0.7, 2.0), ch=0.2)              # two LED light pipes
    pb.g('ledamber', 6.0).box((tx + 5.2, TRAY_FRONT + 0.1, 71.0), (3.6, 0.7, 2.0), ch=0.2)
    LED_POS[tag] = (tx, TRAY_FRONT, 71.0)
    # sheet-metal rails above and below the drive
    pb.g('steel').box((tx, (TRAY_FRONT + 3 + 38) / 2, TRAY_Z1 - 0.7), (23.0, 38 - TRAY_FRONT - 3, 1.2))
    pb.g('steel').box((tx, (TRAY_FRONT + 3 + 38) / 2, TRAY_Z0 + 0.7), (23.0, 38 - TRAY_FRONT - 3, 1.2))


def hdd(pb, tx):
    zc = (TRAY_Z0 + TRAY_Z1) / 2
    ycen = (DRIVE_Y0 + DRIVE_Y1) / 2
    pb.g('drive', 0.45).box((tx, ycen, zc), (26.1, DRIVE_Y1 - DRIVE_Y0, 101.6), ch=1.0)
    pb.g('label', 0.6).box((tx + 13.15, ycen + 12, zc - 8), (0.2, 88.0, 70.0))
    pb.g('red', 0.6).box((tx + 13.15, ycen + 12, zc + 28), (0.2, 88.0, 9.0))
    pb.g('pcb', 0.5).box((tx - 13.5, ycen + 3, zc), (0.9, 139.0, 94.0))
    for (y, z, sy, sz, m) in ((-70, 100, 17, 17, 'chip'), (-40, 100, 12, 12, 'chip'), (-95, 150, 9, 14, 'chip'),
                              (-25, 145, 8, 8, 'chip'), (-55, 150, 6, 6, 'chip'), (-10, 105, 7, 5, 'chip')):
        pb.g('chip', 0.6).box((tx - 14.3, y, z), (0.8, sy, sz), ch=0.15)
    pb.g('black').box((tx - 7.5, 43.0, 138.5), (7.0, 8.0, 37.5), ch=0.3)          # SATA data+power plug on the drive
    pb.g('gold', 1.0).box((tx - 7.5, 47.2, 143.0), (3.0, 0.4, 22.0))


def build_bays():
    for i in range(1, 7):
        tx = TX[i]
        key = 'bay%d' % i
        declare(key, 'hdd', 'Bay %d' % i, 0.05,
                socket=C(tx - 7.5, 47.2, 138.5),
                slide=[0.0, 0.0, 0.093],
                explode=[round(0.40 * tx * MM, 4), 0.0, 0.16])
        pb = PB(key)
        tray_front(pb, tx, key)
        hdd(pb, tx)
        pb.done()


# --------------------------- M.2 sticks (used by the sled slots and the board slot) -----------------------
def m2_stick(pb, F, kind):
    """a 2280 stick in frame F: u along its length (0 = connector end), v across, w away from the board"""
    w0 = 2.5
    F.box(pb, 'pcb', (40.0, 0, w0 + 0.4), (80.0, 22.0, 0.8))
    if kind == 'bare':
        F.box(pb, 'chip', (14.0, 0, w0 + 1.25), (12.0, 12.0, 0.9), ch=0.2)
        F.box(pb, 'chip', (37.0, 0, w0 + 1.25), (13.0, 14.0, 0.9), ch=0.2)
        F.box(pb, 'chip', (60.0, 0, w0 + 1.25), (13.0, 14.0, 0.9), ch=0.2)
        for u in (6.0, 24.0, 28.0, 71.0, 75.0):
            F.box(pb, 'chip', (u, 7.0, w0 + 1.0), (1.6, 1.0, 0.5))
        F.box(pb, 'label', (74.0, 0, w0 + 1.3), (9.0, 17.0, 0.15), dens=1.4)
    elif kind == 'sticker':
        F.box(pb, 'labeldark', (43.0, 0, w0 + 1.1), (68.0, 20.0, 0.2), dens=1.2)
        F.box(pb, 'chip', (6.0, 0, w0 + 0.9), (5.0, 12.0, 0.4))
        F.box(pb, 'label', (30.0, 0, w0 + 1.25), (18.0, 6.0, 0.1), dens=1.5)
    elif kind == 'heatsink':
        F.box(pb, 'blade', (43.0, 0, w0 + 4.6), (74.0, 22.0, 7.4), ch=0.9, dens=1.0)
        for u in range(12, 72, 8):
            F.box(pb, 'blade', (float(u), 0, w0 + 8.6), (2.0, 22.0, 1.4), ch=0.3)
        F.box(pb, 'label', (50.0, 0, w0 + 8.4), (26.0, 10.0, 0.1), dens=1.5)
    # standoff + screw at the free end
    F.cyl(pb, 'gold', (82.5, 0, w0 / 2 - 0.2), 2.4, w0 + 0.4, axis='w', seg=10)
    F.cyl(pb, 'steel', (80.8, 0, w0 + 1.0), 1.7, 0.8, axis='w', seg=8)


M2_SLOTS = [
    # key, label, location, lanes, populated stick (kind, model), Blender-frame y of the slot on the sled
    ('m2s1', 'M.2 slot 1 (sled, x1)', 'sled', 1, None),
    ('m2s2', 'M.2 slot 2 (sled, x1)', 'sled', 1, None),
    ('m2s3', 'M.2 slot 3 (sled, x2)', 'sled', 2, ('heatsink', 'WD_BLACK SN850X HS 2TB')),
    ('m2s4', 'M.2 slot 4 (sled, x2)', 'sled', 2, ('sticker', 'WD_BLACK SN850X 2TB')),
    ('m2s5', 'M.2 slot 5 (board, x2)', 'board', 2, ('bare', 'SPCC 256GB')),
]
SLED_PITCH, SLED_Y0 = 28.0, -76.0
SLED_X = TX[0]
SLED_PCB_TOP = SLED_X - 10.1
BOARD_M2 = dict(x0=-29.0, y=74.5)      # socket end x and row y of the internal slot


def build_sled():
    tx = SLED_X
    declare('m2sled', 'sled', 'M.2 sled', 0.035,
            socket=C(tx - 10.9, 42.0, 138.5), slide=[0.0, 0.0, 0.093],
            explode=[round(0.40 * tx * MM, 4), 0.0, 0.16])
    pb = PB('m2sled')
    tray_front(pb, tx, 'm2sled')
    # warning label on the front plate: "4SSD bracket - this position only"
    pb.g('labeldark', 1.2).box((tx, TRAY_FRONT - 0.1, 116.0), (14.4, 0.25, 39.6))
    pb.g('orange', 2.0).cyl((tx, TRAY_FRONT - 0.3, 129.5), 4.0, 0.2, axis='y', seg=24)
    pb.g('labeldark', 2.0).cyl((tx, TRAY_FRONT - 0.5, 129.5), 2.9, 0.2, axis='y', seg=24)
    pb.done()
    # carrier plate with lightening holes, carrier PCB, PCIe-style edge connector
    cp = PB('m2sled', 'carrier')
    cp.g('black', 0.8).box((tx - 12.1, -33.0, 121.4), (1.2, 157.0, 100.0))
    cp.g('pcb', 0.9).box((tx - 10.9, -23.75, 121.4), (1.6, 136.5, 101.0))
    for s_ in (-1, 1):
        cp.g('gold', 1.2).box((tx - 10.9 + s_ * 0.95, 42.0, 138.5), (0.12, 6.5, 38.5))
    for u in range(4):
        y = SLED_Y0 + SLED_PITCH * u
        cp.g('chip').box((tx - 9.7, y + 14.2, 98.0), (1.0, 1.4, 1.4))             # tiny resistors by each socket
    cuts = Geo()
    for iy in range(3):
        for iz in range(5):
            cuts.cyl((tx - 12.1, -105.0 + iy * 9.0, 84.0 + iz * 17.0), 3.0, 4.0, axis='x', seg=10)
    cp.done(cuts={'black': cuts})
    # four slots on the carrier
    for k in range(4):
        key, label, loc, lanes, stick = M2_SLOTS[k]
        y = SLED_Y0 + SLED_PITCH * k
        F = Frame((SLED_PCB_TOP, y, 76.0), (0, 0, 1), (0, 1, 0), (1, 0, 0))   # u up the carrier, v along y, w away from the PCB
        declare(key, 'nvme', label, 0.012 if stick else 0.007, location='sled',
                socket=C(SLED_PCB_TOP + 1.5, y, 76.0),
                explode=[round(0.40 * SLED_X * MM, 4) + (0.0 if stick else 0.03), 0.11 if stick else 0.0, 0.16])
        sp = PB(key)
        F.box(sp, 'black', (3.0, 0, 1.4), (7.0, 22.5, 2.8), ch=0.3)            # M.2 connector
        F.cyl(sp, 'gold', (82.5, 0, 1.2), 2.4, 2.4, axis='w', seg=10)          # standoff
        if stick:
            m2_stick(sp, F, stick[0])
        sp.done()


def build_slot5():
    key, label, loc, lanes, stick = M2_SLOTS[4]
    # stick hangs under the board: u -> +x (away from the socket at x0), v -> +y, w -> -z (down)
    F = Frame((BOARD_M2['x0'], BOARD_M2['y'], BOARD_Z0), (1, 0, 0), (0, 1, 0), (0, 0, -1))
    declare(key, 'nvme', label, 0.012, location='board',
            socket=C(BOARD_M2['x0'] + 2.0, BOARD_M2['y'], BOARD_Z0 - 1.5),
            explode=[0.10, -0.15, 0.0])
    sp = PB(key)
    F.box(sp, 'black', (3.0, 0, 1.4), (7.0, 22.5, 2.8), ch=0.3)
    F.cyl(sp, 'gold', (82.5, 0, 1.2), 2.4, 2.4, axis='w', seg=10)
    m2_stick(sp, F, stick[0])
    sp.done()


# ----------------------------------------------------------------------------------------
# BACKPLANE: vertical PCB behind the trays with 6 SATA receptacles + the sled's PCIe receptacle
# ----------------------------------------------------------------------------------------
def build_backplane():
    declare('backplane', 'backplane', 'SATA backplane', 0.04, socket=C(0.0, BP_Y, 140.0), explode=[0.0, 0.0, -0.12])
    pb = PB('backplane')
    zc = (66.0 + 176.5) / 2
    pb.g('pcb').box((0, BP_Y + 0.8, zc), (218.0, 1.6, 110.5))
    cut = Geo()
    for tx in TX:
        cut.rrect_prism((tx + 15.0, 146.0), 'y', 17.0, 30.0, 2.0, BP_Y - 2, BP_Y + 4, seg=3)       # upper airflow windows
        cut.rrect_prism((tx + 2.0, 91.0), 'y', 24.0, 34.0, 2.0, BP_Y - 2, BP_Y + 4, seg=3)         # lower airflow windows
    for tx in TX[1:]:
        pb.g('black').box((tx - 7.5, BP_Y - 5.0, 138.5), (8.8, 10.0, 37.5), ch=0.4)               # SATA receptacle
        pb.g('gold', 0.8).box((tx - 7.5, BP_Y - 9.9, 142.0), (3.2, 0.3, 28.0))
    pb.g('black').box((TX[0] - 10.9, BP_Y - 6.0, 138.5), (5.2, 12.0, 41.0), ch=0.4)              # PCIe-style receptacle
    pb.g('gold', 0.8).box((TX[0] - 10.9, BP_Y - 11.9, 138.5), (2.4, 0.3, 36.0))
    # components on the back side
    for i in range(9):
        x = -96.0 + i * 14.0
        pb.g('alu', 1.0).cyl((x, BP_Y + 7.4, 76.0), 3.2, 11.0, axis='y', seg=14, ch=0.4)
        pb.g('black').cyl((x, BP_Y + 12.7, 76.0), 3.15, 0.4, axis='y', seg=14)
    for (x, z, sx, sz) in ((40, 160, 8, 6), (60, 160, 6, 6), (-30, 165, 7, 7), (100, 100, 5, 5), (-100, 105, 5, 5)):
        pb.g('chip').box((x, BP_Y + 2.2, z), (sx, 1.2, sz), ch=0.2)
    pb.g('label', 1.0).box((20.0, BP_Y + 1.7, 168.0), (24.0, 0.15, 6.0))
    pb.g('steel').box((100.0, BP_Y + 3.0, 72.0), (6.0, 4.0, 4.0))
    pb.done(cuts={'pcb': cut})


# ----------------------------------------------------------------------------------------
# axial fans (92 mm rear exhausts, 80 mm base intake) and the CPU blower
# ----------------------------------------------------------------------------------------
MATS['green'] = (0.42, (0.05, 0.40, 0.12), 0.6, 0.0)


def blade_solid(pb, F, mat, r0, r1, a_mid, chord, th0, sweep, dtan, nr=6, nt=3, thick=0.8):
    """one helicoidal fan blade in frame F (axis = local w). th0 = angular position of the blade root (deg)."""
    G0, G1 = [], []
    for i in range(nr):
        t = i / (nr - 1)
        r = r0 + (r1 - r0) * t
        th = math.radians(th0 + sweep * (t ** 1.3))
        d = dtan * (0.5 + 0.5 * (1 - t)) * (r0 + 4) / r             # angular extent of the chord shrinks with radius
        c = chord * (0.85 + 0.2 * t)
        row0, row1 = [], []
        for j in range(nt):
            s = j / (nt - 1)
            ang = th + d * s
            w = a_mid - c / 2 + c * s
            row0.append(F.c(r * math.cos(ang), r * math.sin(ang), w))
            ang2 = ang + thick / r
            row1.append(F.c(r * math.cos(ang2), r * math.sin(ang2), w))
        G0.append(row0)
        G1.append(row1)
    pb.g(mat).grid_surface(G0, G1)


def axial_fan(key, F, size, depth, bore, hub_r, nblades, chord, sweep, dtan, hub_depth, label=None):
    pb = PB(key)
    h = size / 2
    # square frame with round bore and corner mounting holes (boolean)
    fr = pb.g('black', 1.0)
    fr.box(F.c(0, 0, depth / 2), F.sz(size, size, depth), ch=1.0)
    cut = Geo()
    wa = 'xyz'[[i for i in range(3) if abs(F.W[i]) > 0.5][0]]
    cut.cyl(F.c(0, 0, depth / 2), bore / 2, depth + 2, axis=wa, seg=40)
    for sx in (-1, 1):
        for sy in (-1, 1):
            cut.cyl(F.c(sx * (h - 4.7), sy * (h - 4.7), depth / 2), 2.2, depth + 2, axis=wa, seg=10)
    objs = pb.done(cuts={'black': cut})
    # motor hub, struts, blades
    F.cyl(pb, 'blade', (0, 0, depth * 0.52), hub_r, hub_depth, axis='w', seg=28, ch=1.2)
    if label:
        F.cyl(pb, label, (0, 0, depth * 0.52 + hub_depth / 2 + 0.05), hub_r * 0.78, 0.15, axis='w', seg=24, dens=1.0)
    for k in range(4):
        deg = 45 + 90 * k
        a = math.radians(deg)
        L = bore / 2 - hub_r + 2
        mid = hub_r + L / 2 - 1
        c = F.c(math.cos(a) * mid, math.sin(a) * mid, depth * 0.12)
        if abs(F.W[2]) > 0.5:      # axis along Z
            pb.g('black').box(c, (L, 1.4, 2.2), rot=(0, 0, deg), ch=0.3)
        else:                      # axis along Y: local (u, v) = world (x, z)
            pb.g('black').box(c, (L, 2.2, 1.4), rot=(0, -deg, 0), ch=0.3)
    for b in range(nblades):
        blade_solid(pb, F, 'blade', hub_r - 0.5, bore / 2 - 1.2, depth * 0.52, chord, 360.0 * b / nblades, sweep, dtan)
    pb.done()


def build_fans():
    # rear exhaust fans: 92 x 92 x 25, axis along Y, behind the louvred rear plate
    for key, label, fx in (('fan1', 'Rear fan 1', FAN_X[0]), ('fan2', 'Rear fan 2', FAN_X[1])):
        declare(key, 'fan', label, 0.017, socket=C(fx, 100.0, FAN_Z),
                explode=[round(0.35 * fx * MM, 4), 0.0, -0.13])
        F = Frame((fx, 93.5, FAN_Z), (1, 0, 0), (0, 0, 1), (0, 1, 0))
        axial_fan(key, F, 92.0, 25.0, 88.0, 19.0, 9, 17.0, 52.0, 0.62, 21.0)
    # base intake fan: slim 80 x 80 x 12 on the bottom cover, blowing up through the board
    declare('fan3', 'fan', 'Base fan', 0.008, socket=C(0.0, 40.0, 16.0), explode=[0.0, -0.23, 0.0])
    F = Frame((0.0, 40.0, 10.0), (1, 0, 0), (0, 1, 0), (0, 0, 1))
    axial_fan('fan3', F, 80.0, 12.0, 76.0, 15.0, 7, 9.0, 46.0, 0.55, 10.0, label='green')


def build_blower():
    declare('fan4', 'fan', 'CPU blower', 0.008, socket=C(-5.0, 18.0, 46.0), explode=[-0.02, 0.05, 0.0])
    pb = PB('fan4')
    cx, cy, z0, z1 = -5.0, 18.0, 39.6, 53.6
    # scroll housing: bottom plate, outer wall, top plate with the round intake, discharge duct toward -X
    g = pb.g('black', 1.0)
    g.cyl((cx, cy, z0 + 0.5), 24.0, 1.0, axis='z', seg=40)
    g.box((cx - 24.0, cy, z0 + 0.5), (24.0, 22.0, 1.0))
    # top plate as an annulus (outer 24, intake bore 15)
    for (r_out, r_in, zc) in ((24.0, 15.0, z1 - 0.5),):
        n = 40
        top, bot, inn, out = [], [], [], []
        for i in range(n):
            a = 2 * math.pi * i / n
            ca, sa = math.cos(a), math.sin(a)
            out.append((cx + r_out * ca, cy + r_out * sa))
            inn.append((cx + r_in * ca, cy + r_in * sa))
        zt, zb = zc + 0.5, zc - 0.5
        v = lambda p, z: g._v((p[0], p[1], z))
        ot = [v(p, zt) for p in out]; ob = [v(p, zb) for p in out]
        it = [v(p, zt) for p in inn]; ib = [v(p, zb) for p in inn]
        for i in range(n):
            j = (i + 1) % n
            g._f([ot[i], ot[j], it[j], it[i]])
            g._f([ib[i], ib[j], ob[j], ob[i]])
            g._f([ob[i], ob[j], ot[j], ot[i]])
            g._f([it[i], it[j], ib[j], ib[i]])
    g.box((cx - 24.0, cy, z1 - 0.5), (24.0, 22.0, 1.0))
    for sy in (-1, 1):
        g.box((cx - 24.0, cy + sy * 11.5, (z0 + z1) / 2), (24.0, 1.0, z1 - z0))
    # scroll wall (approximate: a ring wall that leaves the discharge side open)
    for i in range(36):
        a0 = math.radians(i * 360 / 36)
        if 150 < math.degrees(a0) < 210:          # leave the discharge side (toward -X) open
            continue
        g.box((cx + 23.5 * math.cos(a0), cy + 23.5 * math.sin(a0), (z0 + z1) / 2), (1.0, 4.8, z1 - z0), rot=(0, 0, math.degrees(a0)))
    # impeller: hub + 13 backward-curved blades
    pb.g('blade').cyl((cx, cy, (z0 + z1) / 2), 7.0, z1 - z0 - 3, axis='z', seg=24, ch=0.8)
    pb.g('steel').cyl((cx, cy, z1 - 1.8), 3.0, 0.6, axis='z', seg=14)
    for k in range(13):
        a = 360.0 * k / 13
        pb.g('blade').box((cx + 11.0 * math.cos(math.radians(a + 18)), cy + 11.0 * math.sin(math.radians(a + 18)), (z0 + z1) / 2),
                          (7.2, 0.5, z1 - z0 - 3.2), rot=(0, 0, a + 18 + 25))
    pb.done()


# ----------------------------------------------------------------------------------------
# CPU + cooler (Ryzen 7 PRO 8845HS on the top of the board, vapour-chamber plate, fin stack)
# ----------------------------------------------------------------------------------------
CPU_C = (-8.0, 18.0)


def build_cpu():
    cx, cy = CPU_C
    declare('cpu', 'cpu', 'Ryzen 7 PRO 8845HS', 0.045, socket=C(cx, cy, BOARD_Z1 + 1.5), explode=[0.0, -0.01, 0.0])
    pb = PB('cpu')
    pb.g('pcb', 1.2).box((cx, cy, BOARD_Z1 + 0.6), (40.0, 25.0, 1.2), ch=0.2)                  # FP7 BGA substrate
    pb.g('chip', 1.4).box((cx, cy, BOARD_Z1 + 1.55), (15.0, 18.0, 0.7), ch=0.15)             # die
    for i in range(10):
        pb.g('chip', 1.2).box((cx - 17.0 + i * 3.8, cy + 14.5, BOARD_Z1 + 0.5), (1.6, 1.0, 0.8))
        pb.g('chip', 1.2).box((cx - 17.0 + i * 3.8, cy - 14.5, BOARD_Z1 + 0.5), (1.6, 1.0, 0.8))
    vz = BOARD_Z1 + 3.4
    pb.g('copper', 1.0).box((cx - 14.0, cy + 2.0, vz + 0.8), (90.0, 54.0, 3.0), ch=0.6)       # vapour-chamber plate
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = cx - 14.0 + sx * 40.0, cy + 2.0 + sy * 23.0
            pb.g('steel', 1.2).cyl((x, y, vz + 3.2), 3.2, 1.6, axis='z', seg=12, ch=0.3)
            pb.g('gold', 1.0).cyl((x, y, vz + 1.9), 2.6, 1.4, axis='z', seg=10)
    fin_x0 = -62.0
    for i in range(24):
        y = cy - 19.0 + i * 1.95
        pb.g('alu', 1.8).box((fin_x0 + 15.0 + 0.0, y, vz + 2.3 + 7.0), (30.0, 0.35, 14.0))
    pb.g('copper', 1.0).box((fin_x0 + 15.0, cy + 2.0, vz + 2.5), (30.0, 48.0, 1.0))
    pb.done()


# ----------------------------------------------------------------------------------------
# MAIN BOARD (HCAR7000-NR V0.2): PCB, X710 + heatsink, I226-Vs, ASM1166, VRM, caps, sockets
# ----------------------------------------------------------------------------------------
ASM_POS = (48.0, 44.0)       # ASM1166 SATA controller: right-rear of the board, closest to the backplane
X710_POS = (-62.0, 68.0)     # Intel X710 + heatsink, just in front of the SFP+ cages


def build_board():
    declare('board', 'board', 'Main board', 0.075, socket=C(0.0, 0.0, BOARD_Z1), explode=[0.0, -0.10, 0.0])
    pb = PB('board')
    pcb = [(-93.0, -70.0), (57.0, -70.0), (57.0, -46.0), (82.0, -46.0), (82.0, 114.0), (-93.0, 114.0)]
    pb.g('pcb', 1.0).prism(pcb, 'z', BOARD_Z0, BOARD_Z1)
    import random
    rnd = random.Random(11)
    zt, zb = BOARD_Z1, BOARD_Z0
    # top side
    nx, ny = X710_POS
    pb.g('chip', 1.3).box((nx, ny, zt + 1.0), (25.0, 25.0, 2.0), ch=0.3)                      # Intel X710 BGA
    pb.g('black', 1.5).box((nx, ny, zt + 5.2), (31.0, 31.0, 6.4), ch=0.6)                     # its heatsink
    for i in range(8):
        pb.g('black', 1.5).box((nx - 13.5 + i * 3.85, ny, zt + 9.9), (1.6, 31.0, 3.0), ch=0.2)
    for x in (-30.0, -10.0):
        pb.g('chip', 1.3).box((x, 97.0, zt + 0.5), (7.0, 7.0, 1.0), ch=0.2)                   # I226-V x2
    ax, ay = ASM_POS
    pb.g('chip', 1.5).box((ax, ay, zt + 0.5), (8.0, 8.0, 1.0), ch=0.2)                        # ASM1166
    pb.g('label', 1.5).cyl((ax - 2.5, ay - 2.5, zt + 1.05), 0.7, 0.1, axis='z', seg=8)
    for (x, y, sx, sy) in ((45, 60, 8, 8), (58, 24, 6, 8), (30, -30, 9, 9), (-35, -55, 6, 6), (50, 95, 6, 6), (25, 100, 5, 5)):
        pb.g('chip', 1.2).box((x, y, zt + 0.5), (sx, sy, 1.0), ch=0.2)
    pb.g('chip').box((60.0, 80.0, zt + 0.6), (6.0, 5.0, 1.2))                                  # SPI flash
    # rows of MLCCs / resistors around the CPU
    for _ in range(170):
        x = rnd.uniform(-80, 74)
        y = rnd.uniform(-62, 106)
        if abs(x - CPU_C[0]) < 50 and abs(y - CPU_C[1]) < 32:
            continue
        pb.g('chip', 1.0).box((x, y, zt + 0.35), (rnd.choice((1.0, 1.6, 2.0)), rnd.choice((0.8, 1.2)), 0.6))
    # standoffs
    for (x, y) in ((-85, -62), (75, -39), (-85, 106), (75, 106), (-85, 18), (50, 18)):
        pb.g('gold', 1.0).cyl((x, y, (18.2 + 0.75 + zb) / 2), 2.9, zb - 18.95, axis='z', seg=6)
    # connectors on the top side: fan header, USB-C power/USB header
    pb.g('label').box((-20.0, -64.0, zt + 2.6), (9.0, 5.0, 4.4))
    pb.g('label').box((8.0, -64.0, zt + 2.6), (9.0, 5.0, 4.4))
    # underside
    for i in range(5):
        pb.g('steel', 1.3).box((46.0 - i * 13.0, 54.5, zb - 1.6), (7.2, 7.2, 3.2), ch=0.4)       # VRM chokes
        pb.g('alu', 1.0).cyl((46.0 - i * 13.0, 45.0, zb - 2.0), 3.1, 4.0, axis='z', seg=14, ch=0.3)
    pb.g('steel', 1.3).cyl((-37.0, -14.0, zb - 1.6), 10.0, 3.2, axis='z', seg=28, ch=0.4)       # CR2032
    for y in (35.0, 5.0):
        pb.g('black', 1.0).box((-45.0, y, zb - 1.3), (14.0, 4.0, 2.6), ch=0.3)                    # E-key / spare M.2 sockets
    for _ in range(110):
        x = rnd.uniform(-80, 74)
        y = rnd.uniform(-62, 106)
        pb.g('chip', 1.0).box((x, y, zb - 0.35), (rnd.choice((1.0, 1.6, 2.0)), rnd.choice((0.8, 1.2)), 0.6))
    pb.done()


# ----------------------------------------------------------------------------------------
# SO-DIMMs: two DDR5-5600 modules on stacked sockets under the board
# ----------------------------------------------------------------------------------------
def build_ram():
    for n, (key, zc, yc) in enumerate((('ram1', 29.0, -12.0), ('ram2', 22.2, -18.0))):
        declare(key, 'ram', 'SO-DIMM %d' % (n + 1), 0.015, socket=C(-3.0, yc - 15.0, zc),
                explode=[0.0, -0.15 - 0.05 * n, 0.05])
        pb = PB(key)
        pb.g('pcb', 1.0).box((30.8, yc, zc), (67.6, 30.0, 0.8))
        for i in range(4):
            for s in (-1, 1):
                pb.g('chip', 1.3).box((7.0 + i * 16.5 - 3.0 + 2.0, yc + 5.0, zc + s * 0.85), (11.0, 12.0, 0.9), ch=0.2)
        pb.g('chip').box((0.0, yc + 2.0, zc + 0.6), (5.0, 5.0, 0.6))
        pb.g('chip').box((60.0, yc - 8.0, zc + 0.6), (4.0, 4.0, 0.6))
        pb.g('label', 1.4).box((24.0, yc + 1.5, zc - 1.4), (38.0, 16.0, 0.12))
        pb.g('black', 1.0).box((30.8, yc - 17.0, zc + 0.0), (68.0, 6.0, 6.6 if n == 0 else 6.8), ch=0.4)
        for sx in (-1, 1):
            pb.g('steel', 1.0).box((30.8 + sx * 35.5, yc - 6.0, zc), (1.0, 8.0, 5.0))
        pb.done()


# ----------------------------------------------------------------------------------------
# REAR PORTS (mouths flush with the rear I/O panel)
# ----------------------------------------------------------------------------------------
def port_shell(pb, x, z, w, h, depth, mouth_w, mouth_h, mouth_depth, mdz=0.0, y_front=122.3):
    """steel shell with an open mouth; returns the cut Geo (apply with pb.done(cuts=...))"""
    pb.g('steel', 1.2).box((x, y_front - depth / 2, z), (w, depth, h), ch=0.3)
    c = Geo()
    c.box((x, y_front - mouth_depth / 2 + 0.5, z + mdz), (mouth_w, mouth_depth + 1, mouth_h))
    return c


def build_ports():
    H = rear_port_holes()
    # 2.5 GbE RJ45 x2 (Intel I226-V)
    for n, (key, label, idx) in enumerate((('lan1', '2.5GbE 1', 8), ('lan2', '2.5GbE 2', 7))):
        x, z = H[idx][0], H[idx][1]
        declare(key, 'port', label, 0.012, socket=C(x, YR, z), explode=[round(0.35 * x * MM, 4), -0.10, -0.08])
        pb = PB(key)
        cut = port_shell(pb, x, z, 15.9, 13.8, 21.0, 11.8, 8.6, 15.0, mdz=1.6)
        cut.box((x, 114.5, z - 3.6), (6.0, 16.0, 2.4))          # latch notch under the mouth
        for i in range(8):
            pb.g('gold', 1.5).box((x - 4.55 + i * 1.3, 112.0, z + 5.5), (0.5, 9.0, 0.35))
        pb.g('led', 4.0).box((x + 5.0, 122.1, z - 5.2), (2.6, 0.5, 1.6))
        pb.g('ledamber', 4.0).box((x - 5.0, 122.1, z - 5.2), (2.6, 0.5, 1.6))
        pb.done(cuts={'steel': cut})
    # SFP+ x2 (Intel X710)
    for n, (key, label, idx, leds) in enumerate((('sfp1', '10GbE SFP+ 1', 9, (-38.5, -41.0)), ('sfp2', '10GbE SFP+ 2', 10, (-79.0, -81.5)))):
        x, z = H[idx][0], H[idx][1]
        declare(key, 'port', label, 0.012, socket=C(x, YR, z), explode=[round(0.35 * x * MM, 4), -0.10, -0.08])
        pb = PB(key)
        cut = port_shell(pb, x, z, 13.8, 8.8, 50.0, 12.4, 7.0, 32.0)
        pb.g('black').box((x, 100.0, z - 1.4), (10.0, 22.0, 1.4))
        pb.g('alu', 1.5).box((x, 118.0, z + 2.8), (5.0, 8.0, 0.4))
        pb.g('gold', 1.5).box((x, 92.2, z - 0.7), (9.0, 0.4, 1.2))
        for lx in leds:
            pb.g('ledamber', 5.0).cyl((lx, 122.3, 38.8), 0.7, 0.5, axis='y', seg=8)
        pb.done(cuts={'steel': cut})
    # the rest: audio, HDMI, DP, USB-A x2, OCuLink, USB4, DC in
    declare('io', 'io', 'Rear I/O', 0.030, socket=C(30.0, YR, 28.0), explode=[0.02, -0.10, -0.135])
    pb = PB('io')
    cuts = Geo()
    # audio jack
    x, z = H[0][0], H[0][1]
    pb.g('steel', 1.2).cyl((x, 115.3, z), 4.2, 14.0, axis='y', seg=18, ch=0.3)
    cuts.cyl((x, 119.0, z), 1.9, 10.0, axis='y', seg=12)
    # HDMI + DP
    for idx, w2, h2 in ((1, 14.8, 5.8), (2, 16.8, 6.6)):
        x, z = H[idx][0], H[idx][1]
        pb.g('steel', 1.2).box((x, 116.3, z), (w2 + 1.4, 12.0, h2 + 1.4), ch=0.3)
        cuts.box((x, 118.5, z), (w2, 12.0, h2))
        pb.g('black').box((x, 114.5, z - 0.4), (w2 - 4.0, 8.0, 1.1))
        pb.g('gold', 1.5).box((x, 111.0, z + 1.0), (w2 - 5.0, 1.0, 0.3))
    # USB-A x2 (blue tongues)
    for idx in (3, 4):
        x, z = H[idx][0], H[idx][1]
        pb.g('steel', 1.2).box((x, 116.3, z), (15.6, 12.0, 7.6), ch=0.3)
        cuts.box((x, 118.5, z), (14.2, 12.0, 6.2))
        pb.g('blue', 1.3).box((x, 114.0, z - 1.4), (12.0, 9.0, 1.8))
    # OCuLink
    x, z = H[5][0], H[5][1]
    pb.g('steel', 1.2).box((x, 116.8, z), (13.8, 11.0, 6.2), ch=0.3)
    cuts.box((x, 118.8, z), (12.6, 10.0, 4.9))
    pb.g('black').box((x, 115.0, z), (9.8, 7.0, 1.2))
    # USB4 (Type-C), standing vertical on the rear
    x, z = H[6][0], H[6][1]
    pb.g('steel', 1.2).box((x, 117.5, z), (4.8, 9.0, 10.4), ch=0.4)
    cuts.rrect_prism((x, z), 'y', 3.4, 9.0, 1.4, 112.0, 123.0, seg=4)
    pb.g('black').box((x, 115.0, z), (0.9, 6.0, 7.6))
    # DC power jack
    x, z = H[11][0], H[11][1]
    pb.g('black', 1.3).cyl((x, 115.3, z), 4.4, 14.0, axis='y', seg=22, ch=0.4)
    cuts.cyl((x, 119.5, z), 3.2, 8.0, axis='y', seg=18)
    pb.g('gold', 1.5).cyl((x, 117.0, z), 1.0, 8.0, axis='y', seg=8)
    pb.done(cuts={'steel': cuts})


# ----------------------------------------------------------------------------------------
# LED: the power button's ring (the per-bay LEDs live on the trays, the NIC LEDs on the ports)
# ----------------------------------------------------------------------------------------
def build_led():
    declare('led', 'led', 'Power LED ring', 0.004, socket=C(95.7, YF, 26.0), explode=[0.0, 0.26, 0.0])
    pb = PB('led')
    g = pb.g('led', 4.0)
    n = 28
    r0, r1, y0, y1 = 5.2, 6.4, -122.1, -121.7
    o0, o1, i0, i1 = [], [], [], []
    for i in range(n):
        a = 2 * math.pi * i / n
        ca, sa = math.cos(a), math.sin(a)
        o0.append(g._v((95.7 + r1 * ca, y0, 26.0 + r1 * sa))); o1.append(g._v((95.7 + r1 * ca, y1, 26.0 + r1 * sa)))
        i0.append(g._v((95.7 + r0 * ca, y0, 26.0 + r0 * sa))); i1.append(g._v((95.7 + r0 * ca, y1, 26.0 + r0 * sa)))
    for i in range(n):
        j = (i + 1) % n
        g._f([o0[i], o0[j], i0[j], i0[i]])
        g._f([o0[i], o1[i], o1[j], o0[j]])
        g._f([i0[i], i0[j], i1[j], i1[i]])
        g._f([o1[i], i1[i], i1[j], o1[j]])
    pb.done()


# ----------------------------------------------------------------------------------------
# sampling: even (Poisson-disk) area-weighted surface points + points along sharp edges
# ----------------------------------------------------------------------------------------
POISSON_C = 0.55        # r^2 = C * area / N  (calibrated so greedy dart-throwing from 5N candidates lands near N)
EDGE_FRAC = 0.12
EDGE_DEG = 30.0


def mesh_arrays(ob):
    me = ob.data
    me.calc_loop_triangles()
    nv, nt = len(me.vertices), len(me.loop_triangles)
    co = np.empty(nv * 3, np.float32)
    me.vertices.foreach_get('co', co)
    tv = np.empty(nt * 3, np.int32)
    me.loop_triangles.foreach_get('vertices', tv)
    return co.reshape(-1, 3).astype(np.float64), tv.reshape(-1, 3).astype(np.int64)


def tri_geometry(V, F):
    tri = V[F]
    cr = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(cr, axis=1)
    area = 0.5 * ln
    nrm = cr / np.maximum(ln, 1e-30)[:, None]
    return tri, area, nrm


def poisson_soup(T, nrm, area, N, rng, fac=5):
    """greedy dart-throwing blue noise over a triangle soup (T: m x 3 x 3); points keep their triangle's normal"""
    A = float(area.sum())
    if N < 1 or A <= 0 or len(T) == 0:
        return np.zeros((0, 3)), np.zeros((0, 3))
    K = int(max(fac * N, 24))
    cum = np.cumsum(area)
    u = (rng.random() + np.arange(K)) / K * cum[-1]
    ti = np.minimum(np.searchsorted(cum, u), len(area) - 1)
    r1, r2 = rng.random(K), rng.random(K)
    s = np.sqrt(r1)
    P = T[ti, 0] * (1 - s)[:, None] + T[ti, 1] * (s * (1 - r2))[:, None] + T[ti, 2] * (s * r2)[:, None]
    Nc = nrm[ti]
    r = math.sqrt(POISSON_C * A / N)
    kd = mkd.KDTree(K)
    for i in range(K):
        kd.insert((P[i, 0], P[i, 1], P[i, 2]), i)
    kd.balance()
    order = rng.permutation(K)
    nx, ny, nz = Nc[:, 0].tolist(), Nc[:, 1].tolist(), Nc[:, 2].tolist()
    Pl = P.tolist()
    acc = []
    al = [True] * K
    for i in order.tolist():
        if not al[i]:
            continue
        acc.append(i)
        a, b, c = nx[i], ny[i], nz[i]
        for (_co, j, _d) in kd.find_range(Pl[i], r):
            if j != i and al[j] and (nx[j] * a + ny[j] * b + nz[j] * c) > 0.25:
                al[j] = False
    acc = np.array(acc, np.int64)
    return P[acc], Nc[acc]


def subdivide_soup(T, Nn, L):
    """bisect triangles across their longest edge until every edge is <= L (winding and normals preserved)"""
    done_T, done_N = [], []
    while len(T):
        e = np.stack([T[:, 1] - T[:, 0], T[:, 2] - T[:, 1], T[:, 0] - T[:, 2]], axis=1)
        el = np.linalg.norm(e, axis=2)
        k, lm = el.argmax(1), el.max(1)
        small = lm <= L
        done_T.append(T[small])
        done_N.append(Nn[small])
        T, Nn, k = T[~small], Nn[~small], k[~small]
        if not len(T):
            break
        idx = np.stack([k, (k + 1) % 3, (k + 2) % 3], axis=1)
        Q = T[np.arange(len(T))[:, None], idx]          # p, q (longest edge), r (opposite)
        M = (Q[:, 0] + Q[:, 1]) / 2
        T = np.concatenate([np.stack([Q[:, 0], M, Q[:, 2]], axis=1), np.stack([M, Q[:, 1], Q[:, 2]], axis=1)])
        Nn = np.concatenate([Nn, Nn])
    return np.concatenate(done_T), np.concatenate(done_N)


def segment_edges(E, L):
    """split sharp edges into pieces <= L so each piece can be classified Exterior/Interior on its own"""
    p0, p1, nn = E
    if len(p0) == 0:
        return np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 3))
    ln = np.linalg.norm(p1 - p0, axis=1)
    k = np.maximum(1, np.ceil(ln / L)).astype(np.int64)
    idx = np.repeat(np.arange(len(p0)), k)
    first = np.cumsum(k) - k
    j = np.arange(len(idx)) - first[idx]
    a = p0[idx] + (p1[idx] - p0[idx]) * (j / k[idx])[:, None]
    b = p0[idx] + (p1[idx] - p0[idx]) * ((j + 1) / k[idx])[:, None]
    return a, b, nn[idx]


def sharp_edges(ob, deg=EDGE_DEG):
    """returns (p0, p1, normal) arrays for edges whose dihedral angle exceeds deg (or boundary edges)"""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.edges.ensure_lookup_table()
    lim = math.radians(deg)
    p0, p1, nn = [], [], []
    for e in bm.edges:
        lf = e.link_faces
        if len(lf) == 2:
            try:
                ang = e.calc_face_angle()
            except ValueError:
                continue
            if ang < lim:
                continue
            n = lf[0].normal + lf[1].normal
        elif len(lf) == 1:
            n = lf[0].normal
        else:
            continue
        if n.length < 1e-6:
            continue
        a, b = e.verts[0].co, e.verts[1].co
        p0.append((a.x, a.y, a.z))
        p1.append((b.x, b.y, b.z))
        n.normalize()
        nn.append((n.x, n.y, n.z))
    bm.free()
    if not p0:
        return np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 3))
    return np.array(p0), np.array(p1), np.array(nn)


def edge_points(E, spacing, rng):
    p0, p1, nn = E
    if len(p0) == 0:
        return np.zeros((0, 3)), np.zeros((0, 3))
    L = np.linalg.norm(p1 - p0, axis=1)
    cnt = np.floor(L / spacing + rng.random(len(L))).astype(np.int64)
    idx = np.repeat(np.arange(len(L)), cnt)
    if len(idx) == 0:
        return np.zeros((0, 3)), np.zeros((0, 3))
    # stratified position along each edge
    first = np.cumsum(cnt) - cnt
    j = np.arange(len(idx)) - first[idx]
    t = (j + 0.25 + 0.5 * rng.random(len(idx))) / cnt[idx]
    P = p0[idx] + (p1[idx] - p0[idx]) * t[:, None]
    return P, nn[idx]


SUB_L = 0.006           # triangles / edge pieces are classified at this granularity (metres)
# Interior-point counts per part at --points 400000: today's absolute counts (hidden drive bodies, boards, fans...),
# with the shell's inner skin thinned to ~5 % of the cloud. Everything else the budget allows goes to Exterior points.
INT_BASE = {'shell': 20000, 'bay1': 8150, 'bay2': 8150, 'bay3': 8150, 'bay4': 8150, 'bay5': 8150, 'bay6': 8150,
            'm2sled': 6000, 'm2s1': 1290, 'm2s2': 1290, 'm2s3': 2290, 'm2s4': 2350, 'm2s5': 2350, 'backplane': 8100,
            'board': 15000, 'cpu': 9000, 'ram1': 2970, 'ram2': 3000, 'fan1': 3280, 'fan2': 3280, 'fan3': 1560, 'fan4': 1640,
            'lan1': 2200, 'lan2': 2200, 'sfp1': 2230, 'sfp2': 2250, 'io': 5400, 'led': 400}
INT_BASE_POINTS = 400000


def prepare_part(key):
    """per object: triangle soup bisected to <= SUB_L, sharp-edge pieces, density weight, albedo"""
    items = []
    for ob in COLL[key].objects:
        if ob.type != 'MESH' or not len(ob.data.polygons):
            continue
        V, F = mesh_arrays(ob)
        tri, area, nrm = tri_geometry(V, F)
        ok = area > 1e-12
        if not ok.any():
            continue
        T, Nn = subdivide_soup(tri[ok], nrm[ok], SUB_L)
        A = 0.5 * np.linalg.norm(np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]), axis=1)
        E = segment_edges(sharp_edges(ob), SUB_L)
        items.append(dict(T=T, N=Nn, A=A, E=E, dens=float(ob['dens']), tone=float(get_mat(ob['mat'])['tone'])))
    return items


def classify_part(bvh, items):
    for it in items:
        it['ext_t'] = exterior_flags(bvh, it['T'].mean(1), it['N'])
        a, b, nn = it['E']
        it['ext_e'] = exterior_flags(bvh, (a + b) / 2, nn) if len(a) else np.zeros(0, bool)
        it['L'] = np.linalg.norm(it['E'][1] - it['E'][0], axis=1) if len(a) else np.zeros(0)


def ext_weight(items):
    return sum(float(it['A'][it['ext_t']].sum()) * math.sqrt(it['dens']) for it in items)


def sample_part(items, n_ext, n_int, rng):
    """Poisson surface points + ~EDGE_FRAC sharp-edge points, separately for the Exterior and Interior triangles"""
    outP, outN, outT, outE, outX = [], [], [], [], []
    for cls, n_cls in ((True, n_ext), (False, n_int)):
        if n_cls < 1:
            continue
        sel = []
        for it in items:
            m, ms = it['ext_t'] == cls, it['ext_e'] == cls
            sd = math.sqrt(it['dens'])
            sel.append((it, m, ms, float(it['A'][m].sum()) * sd, float(it['L'][ms].sum()) * sd, sd))
        Wtot, Ltot = sum(x[3] for x in sel), sum(x[4] for x in sel)
        if Wtot <= 0:
            continue
        n_edge = int(round(EDGE_FRAC * n_cls)) if Ltot > 0 else 0
        spacing = max(Ltot / max(n_edge, 1), 0.4 * MM)
        edge_out = []
        for (it, m, ms, Aw, Lw, sd) in sel:
            if not ms.any():
                edge_out.append((np.zeros((0, 3)), np.zeros((0, 3))))
                continue
            E = tuple(x[ms] for x in it['E'])
            edge_out.append(edge_points(E, spacing / sd, rng))
        n_surf = max(n_cls - sum(len(e[0]) for e in edge_out), 1)
        for (it, m, ms, Aw, Lw, sd), (Pe, Ne) in zip(sel, edge_out):
            n_o = n_surf * Aw / Wtot
            Ps, Ns = poisson_soup(it['T'][m], it['N'][m], it['A'][m], int(round(n_o)) if n_o >= 0.5 else 0, rng)
            outP += [Ps, Pe]
            outN += [Ns, Ne]
            outT += [np.full(len(Ps), it['tone']), np.full(len(Pe), it['tone'])]
            outE += [np.zeros(len(Ps), bool), np.ones(len(Pe), bool)]
            outX += [np.full(len(Ps), cls), np.full(len(Pe), cls)]
    if not outP:
        return dict(P=np.zeros((0, 3)), N=np.zeros((0, 3)), tone=np.zeros(0), edge=np.zeros(0, bool), ext=np.zeros(0, bool))
    return dict(P=np.concatenate(outP), N=np.concatenate(outN), tone=np.concatenate(outT),
                edge=np.concatenate(outE), ext=np.concatenate(outX))


# ----------------------------------------------------------------------------------------
# visibility: ambient occlusion tone + Exterior/Interior flags, via BVH ray casts on the closed machine
# ----------------------------------------------------------------------------------------
AO_RAYS = 12
AO_MAX = 0.040          # metres
EXT_DIRS = 30
EXT_TEST = 12           # facing directions tried per point
EXT_FRAC = 0.34         # a point is Exterior when this share of them escape the closed machine


def build_bvh():
    Vs, Fs, off = [], [], 0
    for key in ORDER:
        for ob in COLL[key].objects:
            if ob.type != 'MESH' or not len(ob.data.polygons):
                continue
            V, F = mesh_arrays(ob)
            Vs.append(V)
            Fs.append(F + off)
            off += len(V)
    V = np.concatenate(Vs)
    F = np.concatenate(Fs)
    log('bvh over %d triangles' % len(F))
    return BVHTree.FromPolygons(V.tolist(), F.tolist(), all_triangles=True)


def basis(n):
    a = np.where(np.abs(n[:, 0:1]) < 0.9, np.array([[1.0, 0, 0]]), np.array([[0, 1.0, 0]]))
    t1 = np.cross(n, a)
    t1 /= np.linalg.norm(t1, axis=1, keepdims=True)
    t2 = np.cross(n, t1)
    return t1, t2


def exterior_flags(bvh, P, N):
    """True where at least EXT_FRAC of the outward-facing directions escape the closed machine"""
    n = len(P)
    j = np.arange(EXT_DIRS) + 0.5
    zc = 1 - 2 * j / EXT_DIRS
    rho = np.sqrt(1 - zc * zc)
    gd = np.stack([rho * np.cos(j * 2.399963), rho * np.sin(j * 2.399963), zc], axis=1)
    dots = N @ gd.T
    order = np.argsort(-dots, axis=1)
    org_l = (P + N * 0.0002).tolist()
    gd_l, order_l, dots_l = gd.tolist(), order.tolist(), dots.tolist()
    rc = bvh.ray_cast
    ext = np.zeros(n, bool)
    for i in range(n):
        o = org_l[i]
        tried = esc = 0
        for jj in order_l[i]:
            if dots_l[i][jj] < 0.05 or tried >= EXT_TEST:
                break
            tried += 1
            if rc(o, gd_l[jj])[0] is None:
                esc += 1
        ext[i] = tried > 0 and esc >= EXT_FRAC * tried
    return ext


def bake_ao(bvh, P, N, rng):
    """ambient occlusion by cosine-weighted hemisphere rays; returns 1 = open sky, 0 = enclosed"""
    n = len(P)
    t1, t2 = basis(N)
    psi = rng.random(n) * 2 * math.pi
    cs, sn = np.cos(psi)[:, None], np.sin(psi)[:, None]
    k = np.arange(AO_RAYS)
    u = (k + 0.5) / AO_RAYS
    rr = np.sqrt(u)
    ph = k * 2.399963
    lx, ly, lz = rr * np.cos(ph), rr * np.sin(ph), np.sqrt(1 - u)
    dirs = (t1[:, None, :] * (lx[None, :, None] * cs[:, :, None] - ly[None, :, None] * sn[:, :, None]) +
            t2[:, None, :] * (lx[None, :, None] * sn[:, :, None] + ly[None, :, None] * cs[:, :, None]) +
            N[:, None, :] * lz[None, :, None])
    org_l = (P + N * 0.0002).tolist()
    dirs_l = dirs.tolist()
    rc = bvh.ray_cast
    occ = np.zeros(n)
    for i in range(n):
        o = org_l[i]
        s_ = 0.0
        for d in dirs_l[i]:
            h = rc(o, d, AO_MAX)
            if h[0] is not None:
                s_ += 1.0 - h[3] / AO_MAX
        occ[i] = s_ / AO_RAYS
    return 1.0 - occ


# ----------------------------------------------------------------------------------------
# assembly, export, camera
# ----------------------------------------------------------------------------------------
CANON = ['shell', 'bay1', 'bay2', 'bay3', 'bay4', 'bay5', 'bay6', 'm2sled', 'm2s1', 'm2s2', 'm2s3', 'm2s4', 'm2s5',
         'backplane', 'board', 'cpu', 'ram1', 'ram2', 'fan1', 'fan2', 'fan3', 'fan4', 'lan1', 'lan2', 'sfp1', 'sfp2', 'io', 'led', 'lcd']


def build_model():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.unit_settings.system = 'METRIC'
    sc.unit_settings.scale_length = 1.0
    sc.unit_settings.length_unit = 'MILLIMETERS'
    for fn in (build_shell, build_bays, build_sled, build_slot5, build_backplane, build_fans, build_blower,
               build_cpu, build_board, build_ram, build_ports, build_led):
        fn()
    ORDER[:] = [k for k in CANON if k in PARTS]
    for k in ORDER:
        if k.startswith('m2s') and k != 'm2sled' and PARTS[k].get('location') == 'sled':
            PARTS[k]['slide'] = [0.0, 0.0, 0.093]
    if _cutter_coll is not None:
        for o in list(_cutter_coll.objects):
            bpy.data.objects.remove(o)
        bpy.data.collections.remove(_cutter_coll)
    nobj = sum(len(c.objects) for c in COLL.values())
    ntri = 0
    for c in COLL.values():
        for o in c.objects:
            o.data.calc_loop_triangles()
            ntri += len(o.data.loop_triangles)
    log('model built: %d parts, %d objects, %d triangles' % (len(ORDER), nobj, ntri))


def part_bounds_contract(key):
    lo = np.full(3, 1e9)
    hi = np.full(3, -1e9)
    for ob in COLL[key].objects:
        if ob.type != 'MESH' or not len(ob.data.vertices):
            continue
        V, _F = mesh_arrays(ob)
        lo = np.minimum(lo, V.min(0))
        hi = np.maximum(hi, V.max(0))
    # Blender (x, y, z) -> contract (x, z, -y)
    cmin = np.array([lo[0], lo[2], -hi[1]])
    cmax = np.array([hi[0], hi[2], -lo[1]])
    return cmin, cmax


def anchors_contract():
    a = {}
    a['cpu'] = C(CPU_C[0], CPU_C[1], BOARD_Z1 + 1.6)
    a['sata'] = C(ASM_POS[0], ASM_POS[1], BOARD_Z1 + 1.0)
    a['bus'] = C(22.0, -8.0, BOARD_Z1 + 0.2)        # PCIe/SATA trace route: out toward the front edge, then to the CPU
    a['nicbus'] = C(-40.0, 84.0, BOARD_Z1 + 1.0)    # between the X710 heatsink and the two I226-V chips
    a['backplane'] = C(0.0, BP_Y + 1.0, 140.0)
    a['dcin'] = C(-86.7, YR, PORT_Z)
    a['sledconn'] = C(SLED_X - 10.9, 42.0, 138.5)
    a['ram'] = C(30.0, -15.0, 26.0)
    a['m2board'] = C(BOARD_M2['x0'] + 40.0, BOARD_M2['y'], BOARD_Z0 - 2.0)
    a['led1'] = C(*LED_POS['bay1'])
    for i in range(1, 7):
        a['led%d' % i] = C(*LED_POS['bay%d' % i])
    a['ledsled'] = C(*LED_POS['m2sled'])
    a['power'] = C(95.7, YF, 26.0)
    return a


def default_camera(pts, fov=32.0, aspect=16 / 9, az=36.0, el=21.0, fill=0.90):
    """3/4 front-right view from slightly above. Fitted to the visible (Exterior) points rather than the bounding box,
    centred on their projected extent, and pulled in until the case spans `fill` of a 16:9 frame's limiting axis."""
    a, e = math.radians(az), math.radians(el)
    d = np.array([math.sin(a) * math.cos(e), math.sin(e), math.cos(a) * math.cos(e)])
    fwd = -d
    right = np.cross(fwd, [0, 1, 0])
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    th = math.tan(math.radians(fov) / 2)
    tgt = (pts.min(0) + pts.max(0)) / 2
    for _ in range(4):
        dist = 0.3
        for _ in range(400):
            rel = pts - (tgt + d * dist)
            zc = rel @ fwd
            sx = np.abs(rel @ right) / (zc * th * aspect)
            sy = np.abs(rel @ up) / (zc * th)
            if max(sx.max(), sy.max()) <= fill:
                break
            dist *= 1.01
        rel = pts - (tgt + d * dist)
        zc = rel @ fwd
        px, py = (rel @ right) / (zc * th * aspect), (rel @ up) / (zc * th)
        tgt = tgt + right * (px.max() + px.min()) / 2 * (zc.mean() * th * aspect) + up * (py.max() + py.min()) / 2 * (zc.mean() * th)
    return dict(position=[round(float(v), 4) for v in tgt + d * dist], target=[round(float(v), 4) for v in tgt], fovDeg=fov)


def export(args):
    rng = np.random.default_rng(args.seed)
    bvh = build_bvh()
    infos = {}
    for key in ORDER:
        if key == 'lcd':
            infos[key] = []
            continue
        infos[key] = prepare_part(key)
        classify_part(bvh, infos[key])
    log('classified %d triangles' % sum(len(it['T']) for k in ORDER for it in infos[k]))
    scale = args.points / INT_BASE_POINTS
    n_int = {k: int(round(INT_BASE.get(k, 0) * scale)) for k in ORDER}
    n_ext_total = int(max(args.points - sum(n_int.values()), 0) * 1.025)      # dart-throwing lands ~2.5 % under its target
    wext = {k: ext_weight(infos[k]) for k in ORDER if k != 'lcd'}
    wsum = sum(wext.values())      # the LCD dots come on top of the --points budget
    chunks = []
    stats = []
    for pid, key in enumerate(ORDER):
        if key == 'lcd':
            # exact regular dot grid, row-major (point k is dot c = k % cols, r = k // cols), no shuffling
            cc, rr_ = np.meshgrid(np.arange(LCD_COLS), np.arange(LCD_ROWS))
            xs = LCD_C[0] - LCD_W / 2 + (cc.ravel() + 0.5) / LCD_COLS * LCD_W
            zs = LCD_C[1] + LCD_H / 2 - (rr_.ravel() + 0.5) / LCD_ROWS * LCD_H
            Pb = np.stack([xs, np.full(len(xs), LCD_Y), zs], axis=1) * MM
            Nb = np.tile(np.array([[0.0, -1.0, 0.0]]), (len(xs), 1))
            Pc = np.stack([Pb[:, 0], Pb[:, 2], -Pb[:, 1]], axis=1)
            Nc = np.stack([Nb[:, 0], Nb[:, 2], -Nb[:, 1]], axis=1)
            chunks.append((Pc, Nc, np.full(len(Pc), LCD_TONE), np.full(len(Pc), 1), np.full(len(Pc), pid)))
            stats.append((key, len(Pc), len(Pc), 0, len(Pc)))
            log('%-9s grid %d x %d = %d dots' % (key, LCD_COLS, LCD_ROWS, len(Pc)))
            continue
        n_ext = int(round(n_ext_total * wext[key] / wsum))
        r = sample_part(infos[key], n_ext, n_int[key], rng)
        P, Nn, tone, edge, ext = r['P'], r['N'], r['tone'], r['edge'], r['ext']
        ao = bake_ao(bvh, P, Nn, rng)
        perm = rng.permutation(len(P))
        P, Nn, tone, edge, ao, ext = P[perm], Nn[perm], tone[perm], edge[perm], ao[perm], ext[perm]
        shade = 0.28 + 0.72 * np.clip(ao, 0, 1) ** 1.2
        tn = np.clip(tone * shade, 0.0, 1.0)
        fl = np.where(ext, 1, 4) | np.where(edge, 2, 0)
        # Blender -> contract frame
        Pc = np.stack([P[:, 0], P[:, 2], -P[:, 1]], axis=1)
        Nc = np.stack([Nn[:, 0], Nn[:, 2], -Nn[:, 1]], axis=1)
        chunks.append((Pc, Nc, tn, fl, np.full(len(P), pid)))
        stats.append((key, n_ext + n_int[key], len(P), int(edge.sum()), int(ext.sum())))
        log('%-9s target %6d got %6d  edge %5d  exterior %6d' % stats[-1])
    Pc = np.concatenate([c[0] for c in chunks])
    Nc = np.concatenate([c[1] for c in chunks])
    tn = np.concatenate([c[2] for c in chunks])
    fl = np.concatenate([c[3] for c in chunks])
    pid = np.concatenate([c[4] for c in chunks])
    total = len(Pc)
    pad = 0.0005
    bmin = Pc.min(0) - pad
    bmax = Pc.max(0) + pad
    q = np.round((Pc - bmin) / (bmax - bmin) * 65535.0).clip(0, 65535).astype('<u2')
    nq = np.round(Nc / np.maximum(np.linalg.norm(Nc, axis=1, keepdims=True), 1e-9) * 127).clip(-127, 127).astype('<i1')
    rec = np.zeros(total, dtype=np.dtype([('x', '<u2'), ('y', '<u2'), ('z', '<u2'), ('nx', 'i1'), ('ny', 'i1'), ('nz', 'i1'),
                                          ('part', 'u1'), ('tone', 'u1'), ('flags', 'u1')]))
    rec['x'], rec['y'], rec['z'] = q[:, 0], q[:, 1], q[:, 2]
    rec['nx'], rec['ny'], rec['nz'] = nq[:, 0], nq[:, 1], nq[:, 2]
    rec['part'] = pid.astype('u1')
    rec['tone'] = np.round(tn * 255).clip(0, 255).astype('u1')
    rec['flags'] = fl.astype('u1')
    assert rec.dtype.itemsize == 12
    # manifest
    parts, start = [], 0
    for i, key in enumerate(ORDER):
        d = PARTS[key]
        cmin, cmax = part_bounds_contract(key)
        count = stats[i][2]
        e = dict(id=i, key=key, kind=d['kind'], label=d['label'], start=start, count=count,
                 center=[round(float(v), 5) for v in (cmin + cmax) / 2], size=[round(float(v), 5) for v in (cmax - cmin)],
                 socket=[round(float(v), 5) for v in d.get('socket', (cmin + cmax) / 2)])
        if 'slide' in d:
            e['slide'] = [round(float(v), 4) for v in d['slide']]
        e['explode'] = [round(float(v), 4) for v in d['explode']]
        if 'location' in d:
            e['location'] = d['location']
        parts.append(e)
        start += count
    manifest = dict(version=1, name='AOOSTAR WTR MAX', units='m',
                    bounds=dict(min=[round(float(v), 6) for v in bmin], max=[round(float(v), 6) for v in bmax]),
                    pointCount=total, stride=12, parts=parts, anchors=anchors_contract(),
                    camera=default_camera(Pc[(fl & 1) > 0][::7]))
    # origin = top-left corner of the active area seen from the front, u to the top-right, v to the bottom-left
    manifest['screen'] = dict(
        part='lcd',
        origin=[round((LCD_C[0] - LCD_W / 2) * MM, 7), round((LCD_C[1] + LCD_H / 2) * MM, 7), round(-LCD_Y * MM, 7)],
        u=[round(LCD_W * MM, 7), 0.0, 0.0], v=[0.0, round(-LCD_H * MM, 7), 0.0], cols=LCD_COLS, rows=LCD_ROWS)
    os.makedirs(args.out, exist_ok=True)
    # write next to the target and rename, so a viewer reading the folder never sees a half-written file
    for name, writer in (('points.bin', lambda fh: fh.write(rec.tobytes())), ('model.json', lambda fh: json.dump(manifest, fh, indent=1))):
        tmp = os.path.join(args.out, name + '.tmp')
        with open(tmp, 'wb' if name.endswith('.bin') else 'w') as fh:
            writer(fh)
        os.replace(tmp, os.path.join(args.out, name))
    log('wrote %s (%d points, %.1f MB points.bin)' % (args.out, total, total * 12 / 1e6))


def main():
    args = parse_args()
    build_model()
    if args.blend:
        os.makedirs(os.path.dirname(os.path.abspath(args.blend)), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=args.blend, compress=True)
        log('saved', args.blend)
    if args.stage == 'model':
        return
    export(args)


if __name__ == '__main__' or True:
    if 'WTR_NO_MAIN' not in os.environ:
        main()
