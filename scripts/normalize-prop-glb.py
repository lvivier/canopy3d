#!/usr/bin/env python3
"""
Headless Blender normalization & LOD optimization pipeline for Canopy 3D background props.

Use this whenever importing a raw 3D model from:
  - AI Image-to-3D generators (Tripo3D, Meshy, Rodin, Hunyuan3D)
  - Poly Haven / Sketchfab CC0 / Grab3D / custom Blender builds

What it does automatically:
  1. Clears non-mesh clutter (cameras, lights, empties) and applies transforms.
  2. Rotates around vertical axis (--rotate-y degrees) so forward matches Canopy 3D (+Z).
  3. Uniformly scales to target real-world size (--target-length, --target-width, or --target-height in meters).
  4. Centers XZ footprint at (0, 0) and grounds the lowest vertex cleanly at Y = 0 (Z = 0 in Blender).
  5. Exports a clean WebP-textured GLB (with optional Draco compression) to --out,
     and optionally generates a lighter LOD1 mesh (--lod1-out + --lod1-ratio).

Example:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python scripts/normalize-prop-glb.py -- \
    --in assets-raw/models/cabin.glb \
    --out public/assets/models/cabin/lod0.glb \
    --target-width 8.4 --rotate-y 0 \
    --lod1-out public/assets/models/cabin/lod1.glb --lod1-ratio 0.35
"""
import argparse
import math
import os
import sys
import bpy
import mathutils


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    parser = argparse.ArgumentParser(description="Normalize and optimize a GLB prop for Canopy 3D.")
    parser.add_argument("--in", dest="input_path", required=True, help="Source .glb/.gltf/.fbx/.obj path")
    parser.add_argument("--out", dest="output_path", required=True, help="Output normalized LOD0 .glb path")
    parser.add_argument("--lod1-out", dest="lod1_path", default=None, help="Optional decimated LOD1 .glb path")
    parser.add_argument("--lod1-ratio", type=float, default=0.32, help="Decimation ratio for LOD1 (default 0.32)")
    parser.add_argument("--target-width", type=float, default=None, help="Target X width in meters")
    parser.add_argument("--target-length", type=float, default=None, help="Target Z length (Blender Y) in meters")
    parser.add_argument("--target-height", type=float, default=None, help="Target Y height (Blender Z) in meters")
    parser.add_argument("--rotate-y", type=float, default=0.0, help="Yaw rotation in degrees around vertical axis")
    parser.add_argument("--draco", action="store_true", help="Enable Draco mesh compression on export")
    return parser.parse_args(argv)


def import_model(filepath: str):
    ext = os.path.splitext(filepath)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=filepath)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=filepath)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=filepath)
    else:
        raise ValueError(f"Unsupported input format: {ext}")


def compute_bounds(meshes):
    min_v = mathutils.Vector((1e9, 1e9, 1e9))
    max_v = mathutils.Vector((-1e9, -1e9, -1e9))
    for obj in meshes:
        for corner in obj.bound_box:
            w = obj.matrix_world @ mathutils.Vector(corner)
            min_v.x = min(min_v.x, w.x)
            min_v.y = min(min_v.y, w.y)
            min_v.z = min(min_v.z, w.z)
            max_v.x = max(max_v.x, w.x)
            max_v.y = max(max_v.y, w.y)
            max_v.z = max(max_v.z, w.z)
    return min_v, max_v


def export_glb(filepath: str, use_draco: bool):
    os.makedirs(os.path.dirname(os.path.abspath(filepath)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format="GLB",
        export_image_format="WEBP",
        export_image_quality=82,
        export_apply=True,
        export_draco_mesh_compression_enable=use_draco,
        export_draco_mesh_compression_level=6,
    )


def main():
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    import_model(args.input_path)

    # Remove non-mesh helper objects (cameras, lights)
    for obj in list(bpy.context.scene.objects):
        if obj.type not in ("MESH", "EMPTY"):
            bpy.data.objects.remove(obj, do_unlink=True)

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"No mesh objects found in {args.input_path}")

    # Create root empty to transform everything uniformly (preserves multi-mesh hierarchies)
    root = bpy.data.objects.new("PropRoot", None)
    bpy.context.scene.collection.objects.link(root)
    for obj in list(bpy.context.scene.objects):
        if obj != root and obj.parent is None:
            obj.parent = root

    if abs(args.rotate_y) > 1e-4:
        root.rotation_euler = (0.0, 0.0, math.radians(args.rotate_y))
        bpy.context.view_layer.update()

    min_v, max_v = compute_bounds(meshes)
    size = max_v - min_v

    scale = 1.0
    if args.target_length and size.y > 1e-4:
        scale = args.target_length / size.y
    elif args.target_width and size.x > 1e-4:
        scale = args.target_width / size.x
    elif args.target_height and size.z > 1e-4:
        scale = args.target_height / size.z

    root.scale = (scale, scale, scale)
    bpy.context.view_layer.update()

    min_v, max_v = compute_bounds(meshes)
    center_x = (min_v.x + max_v.x) * 0.5
    center_y = (min_v.y + max_v.y) * 0.5
    root.location = (-center_x, -center_y, -min_v.z)
    bpy.context.view_layer.update()

    final_min, final_max = compute_bounds(meshes)
    final_size = final_max - final_min
    print(
        f"[normalize-prop] {args.input_path} -> {args.output_path} | "
        f"size(X={final_size.x:.2f}m, Z_depth={final_size.y:.2f}m, Y_height={final_size.z:.2f}m)"
    )

    export_glb(args.output_path, args.draco)

    if args.lod1_path:
        for obj in meshes:
            mod = obj.modifiers.new(name="LOD1_Decimate", type="DECIMATE")
            mod.decimate_type = "COLLAPSE"
            mod.ratio = max(0.12, min(0.95, args.lod1_ratio))
        export_glb(args.lod1_path, args.draco)
        print(f"[normalize-prop] Wrote LOD1 ({args.lod1_ratio:.2f} ratio) -> {args.lod1_path}")


if __name__ == "__main__":
    main()
