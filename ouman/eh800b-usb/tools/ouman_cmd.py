#!/usr/bin/env python3
"""Send one command to ouman_eh800b_usb.shelly.js over HTTP and print the reply.

usage:
  ouman_cmd.py <pill-ip> <script-id>                      state + diag summary
  ouman_cmd.py <pill-ip> <script-id> 'TIME'               read command (whitelist)
  ouman_cmd.py <pill-ip> <script-id> '{"room_set":21.5}'  any JSON accepted on <prefix>/set

Copyright 2026 Teemu Virta, SPDX-License-Identifier: Apache-2.0
"""
import json
import sys
import time
import urllib.request


def http(url, body=None, timeout=10, tries=5):
    for k in range(tries):
        try:
            data = json.dumps(body).encode() if body is not None else None
            return json.loads(urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=timeout).read())
        except OSError:
            if k == tries - 1:
                raise
            time.sleep(1.5)


def main():
    ip, sid = sys.argv[1], sys.argv[2]
    url = f"http://{ip}/script/{sid}/ouman"
    if len(sys.argv) < 4:
        r = http(url)
        print(json.dumps(r["state"], indent=1))
        d = r["diag"]
        print("dev:", d["dev"], "| full reads:", d["n"], "| err:", d["err"] or "-", "| last reject:", d["rej"] or "-")
        print("trend:", d["trend"])
        return
    arg = sys.argv[3]
    body = json.loads(arg) if arg.lstrip().startswith("{") else {"cmd": arg}
    r = http(url, body)
    print("accepted:", r["accepted"], "queue:", r["queue"])
    if not r["accepted"] or "cmd" not in body:
        return
    want = body["cmd"].strip().upper()
    t0 = time.time()
    while time.time() - t0 < 30:
        time.sleep(1)
        d = http(url)["diag"]
        if d["cmd"] == want:
            print(d["out"])
            return
    print("no reply within 30 s (GET PROPERTY / MEASUREMENTS replies go to state, diag and <prefix>/prop/<id>)")


if __name__ == "__main__":
    main()
