# ModuleServer sandboxing — the ladder (S14)

A ModuleServer runs **other people's extension code**: Python with full OS access, CLI executables, pip
installs. The browser never runs any of it, and the server holds no truth (LiveScene does), so the server is
disposable — but the *machine it runs on* is not. Sandboxing is therefore per host, in rungs, and the
launcher (`ModuleServer/launch.ts`) is the single seam where a rung is applied: it decides which Slicer,
which ports, which directory may be written, which hosts may be reached.

Two modes, decided per server in the registry:

- **trusted** — the user's own machine, their own extensions; rung 0 (plain child process), warnings only.
- **hostile** (default for anything not installed by the user): the highest rung the platform offers.

## Contract for every rung

The `MaliciousTest` probe module (`ModuleServer/sandbox/MaliciousTest.py`, loaded with
`--extra=--additional-module-paths,ModuleServer/sandbox`) must report `sandboxed: true`:

| probe | must | meaning |
|---|---|---|
| `write_home` | fail | write outside the session dir |
| `read_secret` | fail | read `~/.ssh`, `~/.aws`, keychains … |
| `egress` | fail | HTTPS to the public internet |
| `egress_ip` | fail | raw TCP to a public IP |
| `spawn_shell` | fail (rung ≥ 2) | `/bin/sh -c` — rung 1 keeps it (CLI modules are subprocesses) |
| `env_leak` | fail | secret-looking environment variables present |
| `write_session` | **succeed** | the session dir is writable (blob cache, exports) |
| `localhost` | **succeed** | the server reaches its own mrson HTTP port |

Report: `<session>/sandbox-probe.json` and the `probe` result over MCP (`slicer.moduleServerSandboxProbe()`).

## Rungs

| rung | macOS | Linux | Windows | what it buys |
|---|---|---|---|---|
| 0 | plain child process (`launch.ts`), separate ports, own log | same | same | crash isolation, restart-and-reconcile |
| 1 | **Seatbelt** (`sandbox-exec`, profile `ModuleServer/sandbox/moduleserver-seatbelt.sb`): writes only to session + Slicer settings/cache + temp, no secrets readable, network = localhost + `--allow-host` | **bubblewrap** (`bwrap --unshare-net --ro-bind / / --bind <session> …`) or systemd-run `ProtectHome=` / `RestrictAddressFamilies=`; network via a localhost proxy to the data host | **AppContainer** / restricted token (`CreateProcess` with `SECURITY_CAPABILITIES`), or WDAC; firewall rule per exe for egress | file + network confinement; a malicious module cannot read secrets or phone home |
| 2 | Seatbelt + `(deny process-exec)` except Slicer's own bundle; pip/CLI disabled (`--disable-cli-modules`, `PIP_NO_INDEX`) | container (Docker/Podman, `--network none` + proxy, read-only image, tmpfs) | Windows Sandbox / Hyper-V isolated container | no arbitrary subprocess, reproducible image, wiped per session |
| 3 | VM (UTM/Virtualization.framework) with a shared session folder | microVM (Firecracker) or a cloud instance (JS2, Modal-without-gVisor) | Hyper-V VM | kernel isolation; the only rung for truly untrusted code on a shared host |

Rung 1 on macOS is implemented and verified with the probe module (2026-08-28): writes outside the
session, secret reads, HTTPS and raw-TCP egress all fail with `Operation not permitted`; the session write
and the server's own port work; `spawn_shell` still works (by design at rung 1). Two things the exercise
taught: (1) the CTK app launcher opens the executables it is about to run O_RDWR, so a `(deny file-write*)`
profile must allow `file-write-data` on exactly those binaries (the one hole rung 1 leaves; rung 2 = read-only
image); (2) the environment must be cleared — the first probe found this shell's API tokens inside Slicer.
The launcher now passes only an allow-list (HOME, USER, PATH, TMPDIR, LANG, TZ, DISPLAY, …) plus its own
`MODULESERVER_*` variables in sandbox mode.

Rung 1 on macOS is implemented: `deno run -A ModuleServer/launch.ts --sandbox seatbelt --session <dir>
[--allow-host host:port]`. `sandbox-exec` is deprecated by Apple but present on every macOS and is what
`Chromium`/`Safari` helpers used; the profile is written to `~/.slicerlive/moduleserver/moduleserver-<ws>.sb`
per launch so it can be inspected. Denials show up in `log stream --predicate 'sender == "Sandbox"'`.

## What the sandbox does NOT do

- It does not make the *browser page* safer — nothing from the server ever executes there (pixels + JSON).
- It does not protect against a module corrupting **the session's own data** — that is what the op log,
  checkpoints and branches in `render/sessions` are for (roll back).
- It does not hide PHI from the module — a PHI ModuleServer must run *inside* the trust boundary (that is the
  point of the metadata-only subscription + lazy bulk by hash: a server only ever sees what it is invoked on).

## Cloud note (2026-08-28)

Modal's default runtime (gVisor) is rung 3 by construction but Slicer's Qt main window deadlocks there
(see `docs/MODULESERVER.md`, S13); a real VM/host is the working rung-3 target for now.
