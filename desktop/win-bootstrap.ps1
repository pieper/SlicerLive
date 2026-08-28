#ps1_sysnative
# One-paste bootstrap for a fresh Windows test machine (Server 2022 or Win 10/11).
# In an elevated PowerShell:
#   irm https://raw.githubusercontent.com/pieper/SlicerLive/main/desktop/win-bootstrap.ps1 | iex
# Downloads everything from the internet (nothing needs uploading from the dev
# machine): OpenSSH server (+ the dev machine's public key, for remote driving),
# WebView2 runtime, VC++ runtime, Deno, this repo's desktop/ sources, the webview
# DLLs, and the gallery from github.com/pieper/live; then compiles natively and
# stages a ready-to-run folder on the Desktop.
$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Join-Path $env:USERPROFILE "Desktop\SlicerLive"
$work = "C:\slicerlive-build"
$raw = "https://raw.githubusercontent.com/pieper/SlicerLive/main/desktop"
$webviewRelease = "https://github.com/webview/webview_deno/releases/download/0.9.0"
$pubkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKf0cxXgJA3Ss5UwPnGfKm49r3tdpFUCYNVO20dX7W5c slicerlive-vultr-win"
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Get($url, $out) { & curl.exe -sSL -o $out $url; if (-not (Test-Path $out)) { throw "download failed: $url" } }
New-Item -ItemType Directory -Force -Path $work, "$work\src", "$work\deno", "$root", "$root\lib" | Out-Null

Step "OpenSSH server (so the dev machine can drive this box)"
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
}
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd -ErrorAction SilentlyContinue
$ak = "C:\ProgramData\ssh\administrators_authorized_keys"
Set-Content -Path $ak -Value $pubkey -Encoding ascii
icacls $ak /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null
New-Item -Path "HKLM:\SOFTWARE\OpenSSH" -Force | Out-Null
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null
Restart-Service sshd -ErrorAction SilentlyContinue
Write-Host "sshd: $((Get-Service sshd).Status)"

Step "WebView2 runtime"
$wv = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
if ($wv) { Write-Host "already installed: $($wv.pv)" } else {
  Get "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$work\wv2setup.exe"
  Start-Process -FilePath "$work\wv2setup.exe" -ArgumentList "/silent","/install" -Wait
  Write-Host "installed"
}

Step "Visual C++ runtime (webview.dll needs it)"
if (Test-Path "C:\Windows\System32\vcruntime140.dll") { Write-Host "already present" } else {
  Get "https://aka.ms/vs/17/release/vc_redist.x64.exe" "$work\vc_redist.x64.exe"
  Start-Process -FilePath "$work\vc_redist.x64.exe" -ArgumentList "/install","/quiet","/norestart" -Wait
  Write-Host "installed"
}

Step "Deno"
if (-not (Test-Path "$work\deno\deno.exe")) {
  Get "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip" "$work\deno.zip"
  & tar.exe -xf "$work\deno.zip" -C "$work\deno"
}
Write-Host (& "$work\deno\deno.exe" --version | Select-Object -First 1)

Step "SlicerLive desktop sources"
foreach ($f in "main.ts","server-worker.ts","macmenu.ts","help-content.ts") { Get "$raw/$f" "$work\src\$f" }

Step "webview DLLs"
Get "$webviewRelease/webview.dll" "$root\lib\webview.dll"
Get "$webviewRelease/WebView2Loader.dll" "$root\WebView2Loader.dll"

Step "gallery from github.com/pieper/live"
if (Test-Path "$root\gallery\index.html") { Write-Host "already present" } else {
  Get "https://github.com/pieper/live/archive/refs/heads/main.zip" "$work\live-main.zip"
  Remove-Item "$work\live-extract" -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path "$work\live-extract" | Out-Null
  & tar.exe -xf "$work\live-main.zip" -C "$work\live-extract"
  Move-Item -Force "$work\live-extract\live-main" "$root\gallery"
  Write-Host "$((Get-ChildItem "$root\gallery\webgpu").Count) files in webgpu/"
}

Step "compile (native)"
Set-Location "$work\src"
& "$work\deno\deno.exe" compile -A --unstable-ffi --no-terminal --include server-worker.ts -o "$root\SlicerLive.exe" main.ts
& "$work\deno\deno.exe" compile -A --unstable-ffi --include server-worker.ts -o "$root\SlicerLive-console.exe" main.ts
Set-Location $root

Step "done"
Get-ChildItem $root | ForEach-Object { "  " + $_.Name }
Write-Host "`nStaged at $root - double-click SlicerLive.exe. Startup log: $root\SlicerLive.log" -ForegroundColor Green
