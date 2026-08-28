# Microsoft Visual C++ runtime (x64), app-local copies

`vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll` from the Visual C++ 2015–2022
Redistributable (`vc_redist.x64.exe`, installed 2026-08-27 on Windows Server 2022). `webview.dll`
links against them and a fresh Windows Server does not have them; `make-win.ts` places these
beside `SlicerLive.exe` so the DLL loader finds them without a system-wide install. Microsoft
permits app-local redistribution of these files (see the VC redistributable license terms).
