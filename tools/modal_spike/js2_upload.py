"""Upload the bumblebee pyramid from the Modal Volume -> JS2 Swift (public container), from Modal
(fast network). App credential is read from local clouds.yaml and passed as a Modal Secret (not echoed)."""
import os
import modal

app = modal.App("js2-upload")
cache = modal.Volume.from_name("slicerlive-cache")

# Build the JS2 secret from local clouds.yaml — ONLY locally (this module is also imported in the
# container, where the file/pyyaml don't exist). The real values are submitted to Modal and injected.
if modal.is_local():
    import yaml
    _c = yaml.safe_load(open(os.path.expanduser("~/.config/openstack/clouds.yaml")))["clouds"]["BIO240357_IU"]["auth"]
    js2 = modal.Secret.from_dict({
        "OS_AUTH_URL": _c["auth_url"],
        "OS_AC_ID": _c["application_credential_id"],
        "OS_AC_SECRET": _c["application_credential_secret"],
    })
else:
    js2 = modal.Secret.from_dict({})
image = modal.Image.debian_slim(python_version="3.11").pip_install("python-swiftclient", "keystoneauth1")
CONT = "slicerlive-data"
TARGETS = [f"bumblebee_L{ds}.zarr" for ds in (1, 2, 4, 8)] + ["bumblebee_pyramid.json"]


@app.function(image=image, volumes={"/cache": cache}, secrets=[js2], timeout=1800)
def upload():
    import time
    from concurrent.futures import ThreadPoolExecutor
    from keystoneauth1.identity import v3
    from keystoneauth1 import session
    import swiftclient

    def mkconn():
        return swiftclient.Connection(session=session.Session(auth=v3.ApplicationCredential(
            auth_url=os.environ["OS_AUTH_URL"], application_credential_id=os.environ["OS_AC_ID"],
            application_credential_secret=os.environ["OS_AC_SECRET"])))

    base = "/cache"
    files = []
    for tgt in TARGETS:
        p = os.path.join(base, tgt)
        if os.path.isfile(p):
            files.append((p, tgt))
        else:
            for dp, _, fs in os.walk(p):
                for f in fs:
                    fp = os.path.join(dp, f)
                    files.append((fp, os.path.relpath(fp, base)))
    tl = __import__("threading").local()

    def put(item):
        fp, key = item
        if not hasattr(tl, "c"):
            tl.c = mkconn()
        with open(fp, "rb") as fh:
            data = fh.read()
        tl.c.put_object(CONT, key, data)
        return len(data)
    t = time.time()
    with ThreadPoolExecutor(16) as ex:
        sizes = list(ex.map(put, files))
    dt = time.time() - t
    tot = sum(sizes) / 1e6
    return {"objects": len(files), "MB": round(tot, 1), "seconds": round(dt, 1),
            "up_MBps": round(tot / dt, 1)}


@app.local_entrypoint()
def main():
    import json
    print(json.dumps(upload.remote(), indent=2))
