"""
FBX → GLB batch conversion script for vegetation assets.
Run with:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python convert.py

Converts 8 trees, 4 bushes, 4 grass FBX models to GLB.
Each GLB: single joined mesh, Y-up, ~6m tree height normalised, textures embedded.
"""
import bpy
import os
import sys
import math

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
NEW_TEX_BASE = os.path.join(
    os.path.dirname(os.path.dirname(SCRIPT_DIR)),
    "textures", "new textures"
)
TREE_FBX_DIR  = os.path.join(NEW_TEX_BASE, "craftpix-781618-free-tree-3d-low-poly-pack", "Fbx")
BUSH_FBX_DIR  = os.path.join(NEW_TEX_BASE, "craftpix-561109-free-bush-3d-low-poly-models", "Bush_temp_climate", "Fbx")
GRASS_FBX_DIR = os.path.join(NEW_TEX_BASE, "craftpix-561109-free-bush-3d-low-poly-models", "Grass_temp_climate", "Fbx")
TEX_DIR       = os.path.join(SCRIPT_DIR, "textures")

JOBS = []

# ---- Trees: 8 variants ----
for i in range(1, 9):
    fbx  = os.path.join(TREE_FBX_DIR, f"Tree_temp_climate_{i:03d}.FBX")
    glb  = os.path.join(SCRIPT_DIR, "trees", f"tree_{i:02d}.glb")
    tex  = os.path.join(TEX_DIR, "T_Trees_temp_climate.png")
    JOBS.append(("tree", fbx, glb, tex, 6.0))

# ---- Bushes: 4 variants ----
for i in range(1, 5):
    fbx  = os.path.join(BUSH_FBX_DIR, f"Bush_temp_climate_{i:03d}.fbx")
    glb  = os.path.join(SCRIPT_DIR, "bushes", f"bush_{i:02d}.glb")
    tex  = os.path.join(TEX_DIR, "T_Bush_temp_climate.png")
    JOBS.append(("bush", fbx, glb, tex, 1.2))

# ---- Grass: 4 variants ----
for i in range(1, 5):
    fbx  = os.path.join(GRASS_FBX_DIR, f"Grass_{i:03d}.fbx")
    glb  = os.path.join(SCRIPT_DIR, "grass", f"grass_{i:02d}.glb")
    tex  = os.path.join(TEX_DIR, "T_Grass.png")
    JOBS.append(("grass", fbx, glb, tex, 1.6))


def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in bpy.data.meshes:
        bpy.data.meshes.remove(block)
    for block in bpy.data.materials:
        bpy.data.materials.remove(block)
    for block in bpy.data.images:
        bpy.data.images.remove(block)
    for block in bpy.data.armatures:
        bpy.data.armatures.remove(block)


def assign_texture_to_all_meshes(tex_path):
    """Replace all materials on all mesh objects with a single textured material."""
    if not os.path.exists(tex_path):
        print(f"  [WARN] texture not found: {tex_path}")
        return

    # Load image (reuse if already loaded)
    img = bpy.data.images.get(os.path.basename(tex_path))
    if img is None:
        img = bpy.data.images.load(tex_path)
    img.alpha_mode = 'STRAIGHT'

    mat = bpy.data.materials.new(name="VegetationMat")
    nodes_tree = mat.node_tree  # Blender 5: direct access, no use_nodes needed
    if nodes_tree is None:
        mat.use_nodes = True  # fallback for older Blender
        nodes_tree = mat.node_tree
    # Blender 4.x: blend_method/shadow_method; Blender 5.x: these were removed
    try:
        mat.blend_method = 'CLIP'
    except AttributeError:
        pass
    try:
        mat.shadow_method = 'CLIP'
    except AttributeError:
        pass
    try:
        mat.alpha_threshold = 0.4
    except AttributeError:
        pass

    nodes = nodes_tree.nodes
    links = nodes_tree.links
    nodes.clear()

    output  = nodes.new("ShaderNodeOutputMaterial")
    bsdf    = nodes.new("ShaderNodeBsdfPrincipled")
    tex_node = nodes.new("ShaderNodeTexImage")
    tex_node.image = img

    # roughness = 0.85, metallic = 0
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Metallic"].default_value  = 0.0

    links.new(tex_node.outputs["Color"],  bsdf.inputs["Base Color"])
    links.new(tex_node.outputs["Alpha"],  bsdf.inputs["Alpha"])
    links.new(bsdf.outputs["BSDF"],       output.inputs["Surface"])

    output.location  = (400, 0)
    bsdf.location    = (100, 0)
    tex_node.location = (-250, 0)

    for obj in bpy.context.scene.objects:
        if obj.type == 'MESH':
            obj.data.materials.clear()
            obj.data.materials.append(mat)


def remove_armatures():
    """Delete all armature objects (no skeletal animation needed)."""
    for obj in list(bpy.context.scene.objects):
        if obj.type == 'ARMATURE':
            bpy.data.objects.remove(obj, do_unlink=True)


def join_all_meshes():
    """Join all mesh objects into one; returns the resulting object or None."""
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not meshes:
        return None
    bpy.ops.object.select_all(action='DESELECT')
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    return bpy.context.view_layer.objects.active


def normalise_height(obj, target_height):
    """Scale so bounding box height == target_height; translate base to Y=0."""
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    # Apply current transform so bbox is accurate
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.data.update()

    # Compute bbox
    coords = [obj.matrix_world @ v.co for v in obj.data.vertices]
    if not coords:
        return
    min_y = min(c.y for c in coords)
    max_y = max(c.y for c in coords)
    height = max_y - min_y
    if height < 0.001:
        return

    # Translate base to Y=0
    obj.location.y -= min_y
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

    # Scale to target
    scale = target_height / height
    obj.scale = (scale, scale, scale)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)


def process_job(kind, fbx_path, glb_path, tex_path, target_h):
    print(f"\n[{kind.upper()}] {os.path.basename(fbx_path)} → {os.path.basename(glb_path)}")
    if not os.path.exists(fbx_path):
        print(f"  [SKIP] FBX not found: {fbx_path}")
        return False

    clear_scene()

    # Import FBX
    bpy.ops.import_scene.fbx(
        filepath=fbx_path,
        use_manual_orientation=True,
        axis_forward='-Z',
        axis_up='Y',
        global_scale=1.0,
        use_image_search=False,
    )
    print(f"  Imported. Objects: {[o.name for o in bpy.context.scene.objects]}")

    # Remove armatures
    remove_armatures()

    # Join meshes
    obj = join_all_meshes()
    if obj is None:
        print("  [WARN] No mesh objects after import — skipping.")
        return False

    # Normalise height
    normalise_height(obj, target_h)
    tri_count = len(obj.data.loop_triangles) if hasattr(obj.data, 'loop_triangles') else len(obj.data.polygons)
    print(f"  Normalised to {target_h}m. Verts: {len(obj.data.vertices)}, Tris: {tri_count}")

    # Assign texture
    assign_texture_to_all_meshes(tex_path)

    # Select only mesh for export
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    os.makedirs(os.path.dirname(glb_path), exist_ok=True)

    # Export GLB
    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format='GLB',
        export_image_format='AUTO',
        export_materials='EXPORT',
        export_apply=True,
        export_yup=True,
        use_selection=True,
        export_draco_mesh_compression_enable=False,
        export_animations=False,
        export_skins=False,
    )
    size_kb = os.path.getsize(glb_path) / 1024
    print(f"  Exported: {glb_path} ({size_kb:.1f} KB)")
    return True


ok = 0
fail = 0
for (kind, fbx, glb, tex, height) in JOBS:
    if process_job(kind, fbx, glb, tex, height):
        ok += 1
    else:
        fail += 1

print(f"\n=== Done: {ok} converted, {fail} failed ===")
