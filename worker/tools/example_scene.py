"""Blender 示例脚本：建一个带材质和灯光的立方体，导出 GLB、保存 .blend 并渲染一张图。

由 blender_job.py 以 `blender --background --python-exit-code 1 --python 本文件` 调用。
输出目录来自环境变量 DSH_WORKER_OUT_DIR。
"""

import math
import os
import sys
import traceback

import bpy  # type: ignore[import-not-found]

OUT_DIR = os.environ.get("DSH_WORKER_OUT_DIR", r"C:\dsh-worker\workspace\out")


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)

    # 清空默认场景
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # 立方体 + 材质
    bpy.ops.mesh.primitive_cube_add(size=2)
    cube = bpy.context.active_object
    material = bpy.data.materials.get("DemoMaterial") or bpy.data.materials.new("DemoMaterial")
    if not material.use_nodes:
        material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    if principled is not None:
        principled.inputs["Base Color"].default_value = (0.2, 0.55, 0.95, 1.0)
        principled.inputs["Roughness"].default_value = 0.35
    cube.data.materials.append(material)

    # 灯光与相机
    bpy.ops.object.light_add(type="SUN", location=(4, -4, 8))
    sun = bpy.context.active_object
    sun.data.energy = 4.0
    sun.rotation_euler = (math.radians(50), 0.0, math.radians(35))

    bpy.ops.object.camera_add(location=(6, -6, 4))
    camera = bpy.context.active_object
    camera.rotation_euler = (math.radians(70), 0.0, math.radians(45))
    bpy.context.scene.camera = camera

    scene = bpy.context.scene
    scene.render.engine = "CYCLES" if os.environ.get("DSH_RENDER_ENGINE", "CYCLES") == "CYCLES" else "BLENDER_EEVEE_NEXT"
    scene.cycles.samples = int(os.environ.get("DSH_RENDER_SAMPLES", "32"))
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = os.path.join(OUT_DIR, "blender-demo.png")
    bpy.ops.render.render(write_still=True)

    # 导出 GLB 并保存工程
    glb_path = os.path.join(OUT_DIR, "blender-demo.glb")
    bpy.ops.export_scene.gltf(filepath=glb_path, export_format="GLB")
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_DIR, "blender-demo.blend"))

    print("ARTIFACTS", os.path.join(OUT_DIR, "blender-demo.png"))
    print("ARTIFACTS", glb_path)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        sys.exit(1)
