"""
MaliciousTest -- a deliberately hostile Slicer scripted module for the ModuleServer sandbox ladder (S14).

It is NOT harmful by itself: every attempt is a probe that must FAIL inside a sandboxed ModuleServer and
is reported to a JSON file so the ladder can be verified numerically. Loaded via
`--additional-module-paths ModuleServer/sandbox` and triggered with the `probe()` cmd / MCP.

Probes (each -> {"ok": bool, "detail": str}; "ok" means the ATTACK SUCCEEDED, so the sandbox wants ok=False):
  write_home      write a file in the user's home (outside the session dir)
  read_secret     read ~/.ssh or ~/.aws material
  egress          HTTPS to the public internet
  egress_ip       raw TCP to a public IP (bypasses any HTTP proxy rule)
  spawn_shell     run /bin/sh -c   (allowed at rung 1 -- CLI modules are subprocesses; must fail at rung 2)
  env_leak        environment variables that look like secrets
  write_session   (control) write inside the session dir -- must SUCCEED
  localhost       (control) reach the ModuleServer's own mrson HTTP port -- must SUCCEED
ASCII only in this file (Slicer style).
"""
import json
import os
import socket
import subprocess
import time
import urllib.request

from slicer.ScriptedLoadableModule import ScriptedLoadableModule, ScriptedLoadableModuleLogic


class MaliciousTest(ScriptedLoadableModule):
    def __init__(self, parent):
        ScriptedLoadableModule.__init__(self, parent)
        parent.title = "Malicious Test (sandbox probe)"
        parent.categories = ["Testing.ModuleServer"]
        parent.contributors = ["SlicerLive ModuleServer"]
        parent.helpText = "Hostile-behaviour probes that must fail inside a sandboxed ModuleServer."
        parent.acknowledgementText = ""


class MaliciousTestLogic(ScriptedLoadableModuleLogic):
    def __init__(self, sessionDir=None, httpPort=2131):
        ScriptedLoadableModuleLogic.__init__(self)
        self.sessionDir = sessionDir or os.environ.get("MODULESERVER_SESSION_DIR") or os.getcwd()
        self.httpPort = httpPort

    @staticmethod
    def _attempt(fn):
        try:
            detail = fn()
            return {"ok": True, "detail": str(detail)[:200]}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "detail": "%s: %s" % (type(e).__name__, str(e)[:200])}

    def probes(self):
        home = os.path.expanduser("~")
        stamp = str(int(time.time()))

        def write_home():
            p = os.path.join(home, "moduleserver-sandbox-probe-%s.txt" % stamp)
            with open(p, "w") as f:
                f.write("if you can read this the sandbox failed")
            os.remove(p)
            return "wrote " + p

        def read_secret():
            for rel in (".ssh/id_rsa", ".ssh/id_ed25519", ".aws/credentials", ".ssh/known_hosts"):
                p = os.path.join(home, rel)
                if os.path.exists(p):
                    with open(p, "rb") as f:
                        return "read %d bytes of %s" % (len(f.read(64)), rel)
            raise FileNotFoundError("no secret files present to read")

        def egress():
            with urllib.request.urlopen("https://example.com", timeout=6) as r:
                return "HTTP %d" % r.status

        def egress_ip():
            s = socket.create_connection(("1.1.1.1", 443), timeout=5)
            s.close()
            return "tcp connect 1.1.1.1:443"

        def spawn_shell():
            return subprocess.run(["/bin/sh", "-c", "id"], capture_output=True, text=True, timeout=5).stdout.strip()

        def env_leak():
            hits = [k for k in os.environ if any(t in k.upper() for t in ("SECRET", "TOKEN", "PASSWORD", "API_KEY", "AWS_"))]
            if not hits:
                raise KeyError("no secret-looking environment variables")
            return "present: " + ",".join(sorted(hits))[:150]

        def write_session():
            os.makedirs(self.sessionDir, exist_ok=True)
            p = os.path.join(self.sessionDir, "probe-%s.txt" % stamp)
            with open(p, "w") as f:
                f.write("ok")
            os.remove(p)
            return "wrote " + p

        def localhost():
            # a TCP connect, not an HTTP request: the probe runs ON the Qt thread that also serves the port
            # (an HTTP round trip would wait for itself); the kernel accepts the connection regardless
            s = socket.create_connection(("127.0.0.1", self.httpPort), timeout=5)
            s.close()
            return "tcp connect 127.0.0.1:%d" % self.httpPort

        return {
            "write_home": self._attempt(write_home),
            "read_secret": self._attempt(read_secret),
            "egress": self._attempt(egress),
            "egress_ip": self._attempt(egress_ip),
            "spawn_shell": self._attempt(spawn_shell),
            "env_leak": self._attempt(env_leak),
            "write_session": self._attempt(write_session),
            "localhost": self._attempt(localhost),
        }

    def run(self, reportPath=None):
        """Run all probes; return the dict and write it to reportPath (or <sessionDir>/sandbox-probe.json)."""
        result = {"time": time.time(), "sessionDir": self.sessionDir, "probes": self.probes()}
        rung1 = ["write_home", "read_secret", "egress", "egress_ip", "env_leak"]   # spawn_shell is allowed at rung 1 (CLI modules)
        result["attacksSucceeded"] = [k for k in rung1 + ["spawn_shell"] if result["probes"][k]["ok"]]
        result["controlsFailed"] = [k for k in ("write_session", "localhost") if not result["probes"][k]["ok"]]
        result["rung1"] = not any(result["probes"][k]["ok"] for k in rung1) and not result["controlsFailed"]
        result["rung2"] = result["rung1"] and not result["probes"]["spawn_shell"]["ok"]
        result["sandboxed"] = result["rung1"]
        path = reportPath or os.path.join(self.sessionDir, "sandbox-probe.json")
        try:
            with open(path, "w") as f:
                json.dump(result, f, indent=1)
        except OSError:
            pass
        return result
