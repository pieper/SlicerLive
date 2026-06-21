"""Does the PyPI vtk wheel get a HARDWARE EGL context (NVIDIA L4) on Modal, for GPU volume
rendering of a NRRD? If yes -> the alligator demo is straightforward Slicer-quality VTK. If it
falls back to llvmpipe (software) or needs X, we use the proven wgpu path instead."""
import json
import modal

app = modal.App("vtk-egl-probe")
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglx0", "libegl1", "libglvnd0", "libx11-6", "libxext6",
                 "mesa-utils-extra", "libxt6")
    .pip_install("vtk")
    .run_commands(
        "mkdir -p /usr/share/glvnd/egl_vendor.d",
        "python3 -c \"import json;open('/usr/share/glvnd/egl_vendor.d/10_nvidia.json','w')"
        ".write(json.dumps({'file_format_version':'1.0.0',"
        "'ICD':{'library_path':'libEGL_nvidia.so.0'}}))\"",
    )
    .env({"NVIDIA_DRIVER_CAPABILITIES": "all", "NVIDIA_VISIBLE_DEVICES": "all"})
)


@app.function(gpu="L4", image=image, timeout=180)
def probe():
    import vtk
    out = {"vtk_version": vtk.vtkVersion().GetVTKVersion()}
    out["has_vtkEGLRenderWindow"] = hasattr(vtk, "vtkEGLRenderWindow")
    try:
        rw = vtk.vtkEGLRenderWindow() if hasattr(vtk, "vtkEGLRenderWindow") else vtk.vtkRenderWindow()
        rw.SetOffScreenRendering(1); rw.SetSize(640, 480)
        ren = vtk.vtkRenderer(); rw.AddRenderer(ren)
        src = vtk.vtkConeSource(); mp = vtk.vtkPolyDataMapper()
        mp.SetInputConnection(src.GetOutputPort())
        ac = vtk.vtkActor(); ac.SetMapper(mp); ren.AddActor(ac); ren.SetBackground(0.1, 0.2, 0.3)
        rw.Render()
        out["render_window_class"] = rw.GetClassName()
        caps = rw.ReportCapabilities()
        out["gl"] = [l.strip() for l in caps.splitlines()
                     if "vendor string" in l.lower() or "renderer string" in l.lower()
                     or "version string" in l.lower()]
    except Exception as e:
        out["error"] = repr(e)
    return out


@app.local_entrypoint()
def main():
    print(json.dumps(probe.remote(), indent=2))
