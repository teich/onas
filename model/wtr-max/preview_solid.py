"""
Render the solid Blender model (EEVEE) from the manifest camera, from the rear and a few cut-away views.

  blender -b <scratch>/wtr-max.blend --python model/wtr-max/preview_solid.py -- \
      --manifest client/public/wtr-max/model.json --out <dir> [--views cam,rear,cutaway,under]

Camera positions come from model.json (contract frame: +y up, front +z) and are converted back to
Blender's frame (bx = x, by = -z, bz = y).
"""
import bpy, math, sys, json, argparse, os
from mathutils import Vector


def parse():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', default='client/public/wtr-max/model.json')
    ap.add_argument('--out', required=True)
    ap.add_argument('--views', default='cam,rear')
    ap.add_argument('--size', default='1400x1000')
    return ap.parse_args(argv)


def to_b(v):
    return Vector((v[0], -v[2], v[1]))


def setup(res):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = res
    w = bpy.data.worlds.new('w')
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.30, 0.31, 0.35, 1)
    bg.inputs['Strength'].default_value = 1.0
    for (loc, e, col) in (((0.8, -1.0, 1.4), 3.0, (1, 0.97, 0.92)), ((-1.2, -0.5, 0.8), 1.2, (0.7, 0.8, 1.0)),
                          ((0.2, 1.2, 1.0), 1.5, (1, 1, 1))):
        ld = bpy.data.lights.new('sun', 'SUN')
        ld.energy, ld.color = e, col
        lo = bpy.data.objects.new('sun', ld)
        sc.collection.objects.link(lo)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 0.1)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    return sc


def shoot(sc, path, pos, tgt, fov):
    cd = bpy.data.cameras.new('cam')
    cd.sensor_fit = 'VERTICAL'          # fovDeg in the manifest is the vertical field of view
    cd.sensor_height = 24.0
    cd.lens = 12.0 / math.tan(math.radians(fov) / 2)
    cam = bpy.data.objects.new('cam', cd)
    sc.collection.objects.link(cam)
    cam.location = pos
    cam.rotation_euler = (Vector(tgt) - pos).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)


def main():
    a = parse()
    man = json.load(open(a.manifest))
    W, H = [int(v) for v in a.size.split('x')]
    sc = setup((W, H))
    cam = man['camera']
    pos, tgt, fov = to_b(cam['position']), to_b(cam['target']), cam['fovDeg']
    d = pos - tgt
    os.makedirs(a.out, exist_ok=True)
    hide_sets = {
        'cam': [], 'rear': [], 'under': [],
        'cutaway': ['shell.top_shell', 'shell.bezel', 'shell.cage_ceiling', 'shell.lcd', 'shell.base', 'shell.chassis_plate'],
        'innards': ['shell.top_shell', 'shell.bezel', 'shell.cage', 'shell.lcd', 'shell.base', 'shell.chassis_plate',
                    'bay', 'm2s', 'backplane', 'fan1', 'fan2'],
    }
    for v in a.views.split(','):
        for o in bpy.data.objects:
            o.hide_render = False
        for pre in hide_sets.get(v, []):
            for o in bpy.data.objects:
                if o.name.startswith(pre):
                    o.hide_render = True
        if v in ('cam', 'cutaway'):
            p, t = pos, tgt
        elif v == 'rear':
            p, t = tgt + Vector((-d.x, -d.y, d.z)) * 1.0, tgt        # mirror the camera to the rear-left
            p = Vector((-abs(d.x) * 0.9, abs(d.y) * 1.0, d.z * 0.8))
            p = tgt + Vector((-d.length * 0.62, d.length * 0.75, d.length * 0.45))
        elif v == 'innards':
            p, t = tgt + Vector((0.2, -0.45, 0.62)), tgt
        elif v == 'under':
            p, t = tgt + Vector((0.3, -0.45, -0.5)), tgt
        else:
            p, t = pos, tgt
        shoot(sc, os.path.join(a.out, 'solid_%s.png' % v), p, t, fov)
        print('rendered', v)


main()
