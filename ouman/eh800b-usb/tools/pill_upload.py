#!/usr/bin/env python3
# usage: pill_upload.py <ip> <script-name> <file>   -> creates/replaces, starts
import json, sys, urllib.request
ip, name, path = sys.argv[1], sys.argv[2], sys.argv[3]
def rpc(m, p=None):
    req = urllib.request.Request(f"http://{ip}/rpc", data=json.dumps({"id":1,"method":m,"params":p or {}}).encode(), headers={"Content-Type":"application/json"})
    for k in range(4):
        try:
            r = json.loads(urllib.request.urlopen(req, timeout=20).read()); break
        except OSError as e:
            if k == 3: raise
            import time; time.sleep(2)
    if "error" in r: raise SystemExit(f"{m}: {r['error']}")
    return r["result"]
sid = next((s["id"] for s in rpc("Script.List")["scripts"] if s["name"] == name), None)
if sid is None: sid = rpc("Script.Create", {"name": name})["id"]
else:
    try: rpc("Script.Stop", {"id": sid})
    except SystemExit: pass
code = open(path).read()
for i in range(0, len(code), 1024):
    rpc("Script.PutCode", {"id": sid, "code": code[i:i+1024], "append": i > 0})
rpc("Script.Start", {"id": sid})
print("script id", sid, "started,", len(code), "bytes")
