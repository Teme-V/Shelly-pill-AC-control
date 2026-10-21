#!/usr/bin/env python3
# ws_log.py <ip> <seconds> [filter]: print the Shelly debug log (ws://<ip>/debug/log), stdlib only
import base64, json, os, socket, sys, time
ip, secs = sys.argv[1], float(sys.argv[2]); flt = sys.argv[3] if len(sys.argv) > 3 else ""
s = socket.create_connection((ip, 80), timeout=5)
key = base64.b64encode(os.urandom(16)).decode()
s.sendall(("GET /debug/log HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (ip, key)).encode())
buf = b""
while b"\r\n\r\n" not in buf: buf += s.recv(1024)
buf = buf.split(b"\r\n\r\n", 1)[1]
end = time.time() + secs
def need(n):
    global buf
    while len(buf) < n:
        s.settimeout(max(0.1, end - time.time()))
        d = s.recv(4096)
        if not d: raise EOFError
        buf += d
    out, buf = buf[:n], buf[n:]
    return out
try:
    while time.time() < end:
        h = need(2); ln = h[1] & 127
        if ln == 126: ln = int.from_bytes(need(2), "big")
        elif ln == 127: ln = int.from_bytes(need(8), "big")
        p = need(ln)
        if h[0] & 15 != 1: continue
        try: m = json.loads(p)
        except Exception: m = {"data": p.decode("utf-8", "replace")}
        line = str(m.get("data", m)).rstrip()
        if flt in line: print(time.strftime("%H:%M:%S"), line, flush=True)
except (socket.timeout, EOFError):
    pass
