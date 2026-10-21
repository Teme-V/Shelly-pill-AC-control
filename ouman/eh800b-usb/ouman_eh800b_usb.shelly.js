/**
 * @title Ouman EH-800B heating controller over USB for the Shelly Pill (CH376S)
 * @description Reads and controls an Ouman EH-800B through its USB service port
 *   with a CH376S USB-host module (HW-252) on the Pill UART: Shelly app virtual
 *   components, HTTP and MQTT. Run together with ouman_eh800b_companion.shelly.js
 *   (creates the virtual components, Home Assistant discovery, crash watchdog).
 *   Pill firmware 2.0.1+.
 * @status development
 * @link https://github.com/Teme-V/Shelly-pill-AC-control/tree/main/ouman/eh800b-usb
 */

/*
 * Copyright 2026 Teemu Virta
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy
 * at http://www.apache.org/licenses/LICENSE-2.0 . Distributed on an "AS IS"
 * BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
 *
 * USB shell commands and the trend.log layout were observed on an EH-800B
 * V3.0.0; property and object numbers match the EH-800 Ethernet interface
 * as listed by tjani8/ouman-eh-800-home-assistant and mcgurk/Ouman_EH-800_USB-serial.
 * This script is an independent implementation and contains no code from
 * those projects; see NOTICE in the repository root.
 */

/*
 * Wiring (HW-252 CH376S module, 3.3 V logic, no level shifter):
 *   Pill IO1 (TX) -> H1 "S" rxd     Pill IO2 (RX) -> H1 "S" txd     GND common
 *   Module 5 V on H2 +5V/GND (also feeds the USB-A VBUS to the EH-800B).
 *   H2 baud jumper to GND = 115200 (CFG.BAUD); no jumper = 9600. P_S as shipped.
 *   H2 RD/WR are parallel-bus strobes, NOT the UART.
 *
 * Pill: Pill.SetConfig {"config":{"mode":"js_uart"}}; only ONE script may use
 * the UART, and on firmware 2.0.1 UART RX works only for the first UART script
 * started after boot -> after stopping this script reboot the Pill.
 *
 * Reading:
 *   - every POLL_MS: MEASUREMENTS <n> for outdoor/supply/room/valve (one line
 *     each), GET PROPERTY 59 (mode) and 81 (room setpoint) and one more
 *     property (CFG.PROPS and, with PROP_SCAN, every id 1-257 / 327-422 in
 *     turn -> <prefix>/prop/<id>); every FULL_EVERY rounds all 28 rows.
 *   - return water / DHW tank have no MEASUREMENTS row: they come from
 *     trend.log. Its header (TYPE trend.log, 22 B) gives the ring write index,
 *     so the XModem upload is cancelled right after the packet that holds the
 *     newest record (on average half of the 226 packets). Channel types:
 *     properties 6/7/8 (measurement 3/4/5): 283 = return water, 237 = DHW tank.
 *     The controller pauses its own trend logging during an upload.
 * Writing (SET PROPERTY <id> <raw>): room_set (81, x10), mode (59), away (135)
 *   and {"prop":id,"raw":n} for ids in CFG.WRITE_OK. PID 56-58/143-145 and the
 *   manual valve positions 92/179 are never written.
 *
 * HTTP  GET  /script/<id>/ouman            -> {"state":{...},"diag":{...}}
 *       POST /script/<id>/ouman  {"room_set":21.5}, {"cmd":"TIME"}  (same JSON as <prefix>/set)
 *                                -> {"accepted":true|false,"queue":n}
 * MQTT  <prefix>/state (retained), /diag, /set, /prop/<id> (retained),
 *       /debug (TX/RX hex while DEBUG).
 *
 * version 20261021-14
 */

// ===================================================================
//  CONFIGURATION
// ===================================================================
let CFG = {
  BAUD: 115200,        // CH376S UART = HW-252 H2 baud jumper (GND = 115200, none = 9600)
  POLL_MS: 15000,      // one read round
  FULL_EVERY: 4,       // all 28 MEASUREMENTS rows every N rounds (-> /diag)
  TREND_MIN: 30,       // trend.log read interval in minutes (0 = only on request)
  XM_POLL_MS: 100,     // XModem poll interval while waiting for the next packet
  XM_GAP_MS: 0,        // pause after each XModem ACK
  MQTT_PREFIX: "ouman",
  HTTP_ENDPOINT: "ouman",
  VC: true,            // bind the virtual components 200-208 made by the companion script
  ALLOW_WRITE: true,
  WRITE_OK: ",54,55,59,67,69,71,73,75,81,91,112,113,114,126,127,134,135,",
  PROPS: "127,134,135,6,7,8,26,102,130,54,55,91,112,230",
  PROP_SCAN: true,
  DEBUG: false
};

// never written: PID 56-58 / 143-145, manual valve positions 92 / 179
let NEVER = ",56,57,58,92,143,144,145,179,";
// never published in clear: SMS alarm numbers, operator number, PIN, device id,
// lock code, web user and password (the EH-800 keeps them in plain text)
let SECRET = ",5,13,14,15,16,18,401,402,";
// read commands accepted from HTTP / MQTT (plus GET PROPERTY n, MEASUREMENTS n)
let READS = ",MEASUREMENTS,DEVINFO,OSINFO,TIME,LIST,GET TIME,";
// small lists as CSV strings: an array element costs ~14 B of heap, a character ~1.5 B
// ohjaustapa 59 by code (4 = unused); kotona/poissa 135 by code
let MODES = "auto,forced_reduced,forced_big_reduced,forced_normal,,shutdown,manual";
let KPS = "home,away,off";
// MEASUREMENTS rows (1-based) published by name in /diag; empty = m<n>
let ROWS = "supply_curve,room_comp,room_comp_time,,,,supply_target,,supply,outdoor,outdoor_slow,room,room_slow,," +
  "valve_target,valve,,,l2_curve,supply_setpoint,outdoor_delay,,,,,,l2_target,digital";
// CH376S start-up: bytes / max wait ms / expected status / error text
//   reset, CHECK_EXIST, host mode + bus reset, AUTO_CONFIG, retry off,
//   SET_LINE_CODING 115200 8N1 (setup, data, status),
//   SET_CONTROL_LINE_STATE DTR|RTS (without DTR the device NAKs every bulk IN)
let INIT = "05/250|0655/100/AA/CHECK_EXIST|1506/500|1507/120|1506/800/15/no USB device|4D/2500/14/AUTO_CONFIG|0B2500/100|" +
  "2C082120000000000700/100|4E000D/150|2C0700C20100000008/100|4E4001/150|4E8009/150/14/LINE_CODING|" +
  "2C082122030000000000/100|4E000D/150|4E8009/150/14/CTRL_LINE";

// ===================================================================
//  STATE
// ===================================================================
let U = null, rx = "", qcb = null, qT = null, qExp = 0, qSeq = 0, iK = 0;
let inTog = 0, outTog = 0, nak = 0, got = false, txt = "", reads = 0, afterIn = null, outNext = null, tErr = 0;
// CH376S status/data waits end as soon as the expected bytes are in; the long
// limit only covers a busy Pill (HTTP, MQTT) delaying the UART callback
let QW = 1500;
let ready = false, busy = false, initTries = 0, WRW = 20;
let queue = [], curCmd = "", rc = 0, propIdx = 0, scanId = 1, trendWant = false;
let V = { outdoor: null, supply: null, room: null, valve: null, ret: null, dhw: null, room_set: null, mode: null, kp: null };
let M = [], P = {}, CH = [0, 0, 0], vcH = [null, null, null, null, null, null, null, null, null];
let ST = { link: false, dev: "", ts: 0, n: 0, err: "", cmd: "", out: "", rej: "", rej_ts: 0 };
let TRD = { epoch: 0, raw: null, hex: "", ptr: -1, k: -1, pk: 0, need: 0, ts: 0, s: 0, busy: false, err: "" };
// trend.log stream parser: 22 B header, 20 B records (u32 epoch + 8 x int16/10)
let TR = { on: false, pos: 0, rec: "", best: -1, bestRec: "", n: 0, hdr: "" };
let XM = { on: false, buf: "", blk: 1, pkts: 0, bad: 0, idle: 0, empty: 0, t0: 0 };

// ===================================================================
//  HELPERS
// ===================================================================
function hx(c) { let h = "0123456789ABCDEF"; return h[(c >> 4) & 15] + h[c & 15]; }
function hexs(s, max) {
  let o = "", n = s.length;
  if (max && n > max) { n = max; }
  for (let i = 0; i < n; i++) { o += hx(s.charCodeAt(i) & 255) + " "; }
  return o;
}
function lastB(r) { return r.length ? (r.charCodeAt(r.length - 1) & 255) : -1; }
// bulk IN data toggle error (0x23 / 0x2B = DATA0/DATA1 out of turn): the first one is
// usually the device resending a packet whose ACK it missed -> poll again unchanged;
// a repeat means we are out of step -> flip. Returns false after 4 in a row.
function togErr(st) {
  if (st !== 0x23 && st !== 0x2B) { return false; }
  tErr++;
  if (tErr > 4) { return false; }
  if (tErr > 1) { inTog ^= 1; }
  return true;
}
function inCsv(csv, v) { return csv.indexOf("," + JSON.stringify(v) + ",") >= 0; }
function mqttOk() { return typeof MQTT !== "undefined" && MQTT.isConnected(); }
function pub(t, m, ret) {
  try { if (mqttOk()) { MQTT.publish(CFG.MQTT_PREFIX + t, m, 0, ret); } } catch (e) { }
}
function dbg(s) {
  if (!CFG.DEBUG) { return; }
  print("[ouman] " + s);
  pub("/debug", s + " @" + JSON.stringify(Math.round(Shelly.getUptimeMs())), false);
}
// the controller text is Latin-1 -> JSON.stringify would throw on such bytes
function safeStr(t) {
  let i = 0;
  while (i < t.length && t.charCodeAt(i) < 128) { i++; }
  if (i === t.length) { return t; }
  try { JSON.stringify(t); return t; } catch (e) { }
  let o = "";
  for (let i = 0; i < t.length; i++) { let c = t.charCodeAt(i) & 255; o += (c < 128) ? t[i] : "?"; }
  return o;
}
function num(t) {
  t = t.trim();
  if (t.length === 0 || t.length > 9) { return NaN; }
  let v = NaN;
  try { v = Number(t); } catch (e) { v = NaN; }
  return v;
}
// -999.9 = sensor missing or broken
function val(v) { return (v === null || isNaN(v) || v <= -999) ? null : v; }
function nowS() { return Shelly.getComponentStatus("sys").unixtime; }
// controller epochs are local time: offset from the Pill's local HH:MM
function localNowS() {
  let s = Shelly.getComponentStatus("sys"), off = 0;
  if (s.time && s.unixtime) {
    let p = s.time.split(":");
    off = (Number(p[0]) * 60 + Number(p[1])) - Math.floor(s.unixtime / 60) % 1440;
    if (off > 720) { off -= 1440; }
    if (off < -720) { off += 1440; }
  }
  return s.unixtime + off * 60;
}

// ===================================================================
//  CH376S  (57 AB <cmd>; status / data back on the same UART)
// ===================================================================
function snd(a) {
  let s = String.fromCharCode(0x57, 0xAB);
  for (let i = 0; i < a.length; i++) { s += String.fromCharCode(a[i] & 255); }
  U.send(s);
}
// q(bytes, maxWait, cb, exp): exp > 0 -> done after exp bytes; -1 -> RD_USB_DATA0 (len + data); 0 -> fixed wait
function qFin() {
  if (qT !== null) { Timer.clear(qT); qT = null; }
  let r = rx; rx = ""; let c = qcb; qcb = null; qExp = 0;
  if (c) { c(r); }
}
function qTimeout(seq) { if (seq === qSeq && qcb) { qT = null; qFin(); } }
function q(a, wait, cb, exp) {
  rx = ""; qcb = cb; qExp = exp ? exp : 0; qSeq++;
  snd(a);
  qT = Timer.set(wait, false, qTimeout, qSeq);
}
function onRx(d) {
  rx += d;
  if (qcb === null || qExp === 0) { return; }
  if (qExp > 0 && rx.length >= qExp) { qFin(); return; }
  if (qExp < 0 && rx.length >= 1 && rx.length >= (rx.charCodeAt(0) & 255) + 1) { qFin(); }
}
// bulk OUT EP1: WR_HOST_DATA + ISSUE_TKN_X, then next()
function outBytes(a, next) {
  outNext = next;
  let c = [0x2C, a.length];
  for (let i = 0; i < a.length; i++) { c.push(a[i]); }
  q(c, WRW, outTok);
}
function outStr(s, next) {
  let a = [];
  for (let i = 0; i < s.length; i++) { a.push(s.charCodeAt(i)); }
  if (CFG.DEBUG) { dbg("T " + hexs(s)); }
  outBytes(a, next);
}
function outTok(r) { q([0x4E, outTog ? 0x40 : 0x00, 0x11], QW, outRes, 1); }
function outRes(r) {
  if (lastB(r) !== 0x14) {
    if (XM.on) { xmFail("OUT " + hexs(r)); } else { fail("OUT " + curCmd + " status " + hexs(r)); }
    return;
  }
  outTog ^= 1;
  outNext();
}

// ===================================================================
//  START-UP: CH376S table, then cancel a left-over XModem upload
// ===================================================================
function fail(why) {
  ready = false; busy = false; ST.link = false; ST.err = why; TR.on = false; XM.on = false; TRD.busy = false;
  print("[ouman] link down: " + why);
  pubState();
  vcSync();
  initTries++;
  Timer.set(initTries < 5 ? 3000 : 30000, false, init, null);
}
function init() { busy = true; inTog = 0; outTog = 0; iK = 0; initStep(""); }
function initStep(r) {
  let all = INIT.split("|"), p = null;
  if (iK > 0) {
    p = all[iK - 1].split("/");
    if (p.length > 2 && lastB(r) !== parseInt(p[2], 16)) { fail(p[3] + " " + hexs(r)); return; }
  }
  if (iK >= all.length) { Timer.set(300, false, initDrain, null); return; }
  p = all[iK].split("/");
  iK++;
  let a = [];
  for (let i = 0; i < p[0].length; i += 2) { a.push(parseInt(p[0].slice(i, i + 2), 16)); }
  q(a, Number(p[1]), initStep);
}
function initDrain() { drain(initCan); }
// an upload cut off by a reboot later sends EOT (0x04) into the next reply:
// cancel it (CAN x3) and end the line so the shell drops the bytes
function initCan() { dbg("banner " + JSON.stringify(safeStr(txt))); outBytes([0x18, 0x18, 0x18, 0x0A], initWait); }
function initWait() { Timer.set(300, false, initFlush, null); }
function initFlush() { drain(initDone); }
function initDone() {
  if (txt.length) { dbg("flushed " + hexs(txt, 32)); }
  ready = true; busy = false; initTries = 0; ST.link = true; ST.err = "";
  print("[ouman] link up");
  queue = [];
  if (ST.dev === "") { queue.push("DEVINFO"); }
  // channel types first: they map the trend fields to return / DHW
  queue.push("GET PROPERTY 6"); queue.push("GET PROPERTY 7"); queue.push("GET PROPERTY 8"); queue.push("GET PROPERTY 135");
  vcSync();
  pump();
}

// ===================================================================
//  BULK IN (EP2) with early completion, command queue
// ===================================================================
function drain(next) { afterIn = next; nak = 0; got = false; reads = 0; txt = ""; inPoll(); }
function inPoll() { q([0x4E, inTog ? 0x80 : 0x00, 0x29], QW, inRes, 1); }
function inRes(r) {
  let st = lastB(r);
  if (st === 0x14) { inTog ^= 1; nak = 0; got = true; tErr = 0; q([0x27], QW, inData, -1); return; }
  if (togErr(st)) { inPoll(); return; }
  if (st === 0x16) { fail("USB disconnect"); return; }
  if (st === -1) { nak++; if (nak > 40) { fail("IN no status"); return; } inPoll(); return; }
  if (st !== 0x2A) { fail("IN status " + hexs(r)); return; }
  nak++;
  let fast = CFG.BAUD >= 57600;
  if ((got && nak >= (TR.on ? 30 : (fast ? 6 : 4))) || nak >= (TR.on ? 60 : (fast ? 40 : 25))) { afterIn(); return; }
  // the shell answers ~1 s after a command: poll gently (CPU), XModem polls faster
  Timer.set(fast ? 50 : 80, false, inPoll, null);
}
// a reply is complete as soon as its known shape is in; otherwise the NAK count ends it
function complete() {
  let c = curCmd;
  if (TR.on) { return TR.pos >= 200; }
  if (c.indexOf("MEASUREMENTS ") === 0) { return txt.indexOf("\n") > 0 && !isNaN(num(txt.slice(0, txt.indexOf("\r")))); }
  if (c.indexOf(" PROPERTY ") === 3) { return txt.indexOf("PROPERTY(") === 0 && txt.indexOf("\n") > 0; }
  if (c === "MEASUREMENTS") {
    let n = 0;
    for (let i = 0; i < txt.length; i++) { if (txt[i] === "\n") { n++; } }
    return n >= 28;
  }
  return false;
}
function inData(r) {
  reads++;
  let d = r.slice(1);
  if (TR.on) { trFeed(d); }
  else {
    txt += d;
    if (txt.length > 2048) { dbg("RX cap"); afterIn(); return; }
  }
  if (reads > 120 || (afterIn === done && complete())) { afterIn(); return; }
  inPoll();
}
function pump() {
  if (!ready || busy || queue.length === 0) { return; }
  busy = true;
  curCmd = queue.splice(0, 1)[0];
  if (curCmd === "TREND") { trendStart(); return; }
  if (curCmd === "PUB") { pubState(); vcSync(); busy = false; pump(); return; }
  TR.on = false;
  outStr(curCmd + "\n", cmdSent);
}
function cmdSent() { Timer.set(150, false, cmdRead, null); }
function cmdRead() { drain(done); }

// ===================================================================
//  REPLIES
// ===================================================================
function done() {
  let c = curCmd;
  if (TR.on) { TR.on = false; trendHeader(); return; }
  if (CFG.DEBUG) { dbg("R " + hexs(txt, 48)); }
  // measurements: parse in place and free the reply before /diag is built
  if (c.indexOf("MEASUREMENTS") === 0) {
    let ok = false;
    if (c === "MEASUREMENTS") { ok = parseMeas(txt); } else { setRow(Number(c.slice(13)), num(txt.slice(0, txt.indexOf("\r")))); }
    txt = "";
    if (ok) { pubDiag(); }
    busy = false;
    pump();
    return;
  }
  let out = safeStr(txt);
  if (c === "DEVINFO") { ST.dev = out.slice(0, out.indexOf("\r")); }
  if (out.indexOf("PROPERTY(") === 0) { parseProp(out); }
  if (c.indexOf("GET PROPERTY") !== 0) {
    ST.cmd = c; ST.out = out.length > 120 ? out.slice(0, 120) : out;
    pubDiag();
  }
  busy = false;
  pump();
}
function setRow(n, v) {
  if (isNaN(n) || n < 0 || n > 27 || isNaN(v)) { return; }
  M[n] = v;
  if (n === 9) { V.outdoor = val(v); }
  else if (n === 8) { V.supply = val(v); }
  else if (n === 11) { V.room = val(v); }
  else if (n === 15) { V.valve = val(v); }
}
// "<value> <unit>" rows, value may be "-.5"; walked line by line (no split arrays)
function parseMeas(t) {
  let n = 0, p = 0;
  while (p < t.length && n < 28) {
    let e = t.indexOf("\n", p);
    if (e < 0) { e = t.length; }
    let l = t.slice(p, e).trim(), sp = l.indexOf(" ");
    p = e + 1;
    if (sp < 1) { continue; }
    let v = num(l.slice(0, sp));
    if (isNaN(v)) { continue; }
    M[n] = v; n++;
  }
  if (n !== 28) { ST.err = "MEASUREMENTS rows " + JSON.stringify(n); return false; }
  for (let k = 8; k < 16; k++) { setRow(k, M[k]); }
  ST.n++; ST.ts = nowS(); ST.err = "";
  return true;
}
// PROPERTY(134):'L1_HIENOSAATO_VESI'(65496-40) = 0  |  PROPERTY(9):'MITTAUS_3_NIMI' = Mittaus 3
function parseProp(o) {
  let l = o.indexOf("\r") > 0 ? o.slice(0, o.indexOf("\r")) : o;
  let a = l.indexOf("("), b = l.indexOf(")"), q1 = l.indexOf("'"), q2 = l.indexOf("'", q1 + 1), eq = l.indexOf(" = ");
  if (a < 0 || b < a || q1 < 0 || q2 < q1 || eq < 0) { return; }
  let id = Number(l.slice(a + 1, b)), name = l.slice(q1 + 1, q2), v = l.slice(eq + 3);
  if (l.indexOf("(", q2) === q2 + 1) {
    let n = num(v);
    if (!isNaN(n)) { if (n >= 32768) { n -= 65536; } v = n; }
  }
  if (name.length > 48) { name = name.slice(0, 48); }
  if (typeof v === "string" && v.length > 64) { v = v.slice(0, 64); }
  if (inCsv(SECRET, id) && v !== "") { v = "***"; }
  pub("/prop/" + JSON.stringify(id), JSON.stringify({ name: name, value: v }), true);
  if (typeof v !== "number") { return; }
  if (id === 59) { V.mode = modeName(v); }
  else if (id === 81) { V.room_set = v / 10; }
  else if (id === 135) { V.kp = csvItem(KPS, v); }
  else if (id >= 6 && id <= 8) { CH[id - 6] = v; trendRoles(); }
  if (id === 59 || id === 81 || inCsv("," + CFG.PROPS + ",", id)) { P[JSON.stringify(id)] = v; }
}
// i-th item of a CSV string, null if missing or empty
function csvItem(csv, i) {
  if (typeof i !== "number" || i < 0) { return null; }
  let p = 0;
  for (let k = 0; k < i; k++) { p = csv.indexOf(",", p) + 1; if (p === 0) { return null; } }
  let e = csv.indexOf(",", p), n = csv.slice(p, e < 0 ? csv.length : e);
  return n ? n : null;
}
function modeName(c) { return csvItem(MODES, c); }
function modeCode(m) {
  if (typeof m === "number") { return modeName(m) ? m : -1; }
  for (let i = 0; i < 7; i++) { if (m && csvItem(MODES, i) === m) { return i; } }
  return -1;
}

// ===================================================================
//  READ ROUNDS
// ===================================================================
function round() {
  if (CFG.VC && !vcH[8]) { vcBind(); }
  if (!ready || TRD.busy || queue.length > 2) { return; }
  rc++;
  queue.push("MEASUREMENTS 9"); queue.push("MEASUREMENTS 8"); queue.push("MEASUREMENTS 11"); queue.push("MEASUREMENTS 15");
  queue.push("GET PROPERTY 59"); queue.push("GET PROPERTY 81");
  if (CFG.PROP_SCAN && rc % 2 === 0) {
    queue.push("GET PROPERTY " + JSON.stringify(scanId));
    scanId++;
    if (scanId === 258) { scanId = 327; }
    if (scanId > 422) { scanId = 1; }
  } else if (CFG.PROPS) {
    if (csvItem(CFG.PROPS, propIdx) === null) { propIdx = 0; }
    queue.push("GET PROPERTY " + csvItem(CFG.PROPS, propIdx));
    propIdx++;
  }
  if (rc % CFG.FULL_EVERY === 1) { queue.push("MEASUREMENTS"); }
  queue.push("PUB");
  if (trendWant || (CFG.TREND_MIN > 0 && rc > 2 && nowS() - TRD.ts >= CFG.TREND_MIN * 60)) { trendWant = false; queue.push("TREND"); }
  pump();
}

// ===================================================================
//  TREND: header -> XModem until the newest record -> cancel
// ===================================================================
function trReset() { TR.pos = 0; TR.rec = ""; TR.best = -1; TR.bestRec = ""; TR.n = 0; TR.hdr = ""; }
function trFeed(d) {
  let i = 0;
  if (TR.pos < 22) {
    let skip = 22 - TR.pos;
    if (skip > d.length) { skip = d.length; }
    TR.hdr += d.slice(0, skip); TR.pos += skip; i = skip;
  }
  while (i < d.length) {
    let take = d.slice(i, i + 20 - TR.rec.length);
    TR.rec += take; i += take.length; TR.pos += take.length;
    if (TR.rec.length === 20) {
      let r = TR.rec;
      let ep = (r.charCodeAt(0) & 255) + (r.charCodeAt(1) & 255) * 256 + (r.charCodeAt(2) & 255) * 65536 + (r.charCodeAt(3) & 255) * 16777216;
      if (ep > TR.best) { TR.best = ep; TR.bestRec = r; }
      TR.n++; TR.rec = "";
    }
  }
}
function u16(s, i) { return (s.charCodeAt(i) & 255) + (s.charCodeAt(i + 1) & 255) * 256; }
// TYPE prints the first 200 bytes of a file: enough for the header
function trendStart() {
  TRD.busy = true; TRD.err = "";
  pubState();
  curCmd = "TYPE trend.log"; TR.on = true; trReset();
  outStr(curCmd + "\n", cmdSent);
}
// header: u16 next write index, u16 records (1440), u16 record size (20), 8 x u16 field object ids
function trendHeader() {
  let h = TR.hdr;
  TRD.need = 0; TRD.k = -1;
  if (h.length === 22 && u16(h, 4) === 20 && u16(h, 2) > 0) {
    let N = u16(h, 2), p = u16(h, 0), k = (p + N - 1) % N;   // k = newest record
    TRD.ptr = p; TRD.k = k;
    TRD.need = Math.floor((22 + 20 * (k + 1) - 1) / 128) + 1;
  } else {
    TRD.err = "header " + hexs(h);
  }
  dbg("trend ptr " + JSON.stringify(TRD.ptr) + " need " + JSON.stringify(TRD.need));
  XM.on = true; XM.buf = ""; XM.blk = 1; XM.pkts = 0; XM.bad = 0; XM.idle = 0; XM.empty = 0; XM.t0 = Date.now();
  trReset();
  curCmd = "UPLOAD trend.log";
  outStr(curCmd + "\n", xmSent);
}
function xmSent() { Timer.set(300, false, xmRead, null); }
function xmRead() { drain(xmStartRx); }
function xmStartRx() {
  if (txt.indexOf("Start") < 0) { xmFail("no Start: " + JSON.stringify(safeStr(txt.slice(0, 40)))); return; }
  outBytes([0x43], xmPoll);   // 'C' = CRC mode
}
function xmPoll() { q([0x4E, inTog ? 0x80 : 0x00, 0x29], QW, xmIn, 1); }
function xmIn(r) {
  let st = lastB(r);
  if (st === 0x14) { inTog ^= 1; XM.idle = 0; tErr = 0; q([0x27], QW, xmData, -1); return; }
  if (togErr(st)) { xmPoll(); return; }
  if (st === -1) { XM.empty++; if (XM.empty > 20) { xmFail("IN no status"); return; } xmPoll(); return; }
  if (st !== 0x2A) { xmFail("IN " + hexs(r)); return; }
  XM.idle++;
  if (XM.idle * (CFG.XM_POLL_MS + 60) > 6000) {
    // ~6 s of silence: ask again (C before the first block, NAK after)
    XM.idle = 0; XM.bad++; XM.buf = "";
    if (XM.bad > 8) { xmFail("timeout blk " + JSON.stringify(XM.blk)); return; }
    outBytes([XM.pkts === 0 ? 0x43 : 0x15], xmPoll); return;
  }
  // the controller sends a packet ~1.3 s after the ACK: a 15 ms poll only burns CPU
  // and starves the Pill HTTP server (measured 21.10.2026), 100 ms costs ~3 % in time
  Timer.set(CFG.XM_POLL_MS, false, xmPoll, null);
}
// CRC-16/XMODEM, byte-wise (no 8-step bit loop: ~6x less interpreter work per packet)
function crc16x(t, a, n) {
  let c = 0;
  for (let i = a; i < a + n; i++) {
    c = ((c >> 8) | (c << 8)) & 0xFFFF;
    c ^= t.charCodeAt(i) & 255;
    c ^= (c & 0xFF) >> 4;
    c ^= (c << 12) & 0xFFFF;
    c ^= ((c & 0xFF) << 5) & 0xFFFF;
  }
  return c;
}
function xmAck() {
  if (CFG.XM_GAP_MS > 0) { Timer.set(CFG.XM_GAP_MS, false, xmPoll, null); } else { xmPoll(); }
}
function xmData(r) {
  XM.buf += r.slice(1);
  let b0 = XM.buf.length ? (XM.buf.charCodeAt(0) & 255) : -1;
  if (b0 === 0x04) { outBytes([0x06], xmEnd); return; }               // EOT
  if (b0 !== 0x01) { XM.buf = ""; xmPoll(); return; }                  // resync
  if (XM.buf.length < 133) { xmPoll(); return; }
  let p = XM.buf; XM.buf = "";
  let blk = p.charCodeAt(1) & 255, nb = p.charCodeAt(2) & 255;
  let crc = ((p.charCodeAt(131) & 255) << 8) | (p.charCodeAt(132) & 255);
  if (((blk + nb) & 255) !== 255 || crc16x(p, 3, 128) !== crc) { XM.bad++; outBytes([0x15], xmPoll); return; }
  if (blk === (XM.blk & 255)) {
    // header known: copy just the newest record's 20 bytes (it may span two
    // packets); otherwise parse every record and keep the latest epoch
    if (TRD.k >= 0) {
      let o = 22 + 20 * TRD.k - XM.pkts * 128;
      if (o < 128 && o > -20) { TR.bestRec += p.slice(3 + (o > 0 ? o : 0), 3 + (o + 20 < 128 ? o + 20 : 128)); }
    } else { trFeed(p.slice(3, 131)); }
    XM.blk++; XM.pkts++;
  }
  // newest record in -> cancel the rest of the upload
  // (+ newline: CANs the sender does not need would prefix the next shell command)
  if (TRD.need > 0 && XM.pkts >= TRD.need) { outBytes([0x18, 0x18, 0x18, 0x0A], xmEnd); return; }
  outBytes([0x06], xmAck);
}
function xmEnd() { Timer.set(300, false, xmEnd2, null); }
function xmEnd2() { drain(xmDone); }
function xmDone() {
  XM.on = false;
  TRD.s = Math.round((Date.now() - XM.t0) / 1000);
  TRD.pk = XM.pkts;
  if (TR.bestRec.length === 20) { trDecode(); } else { TRD.err = "no records"; }
  print("[ouman] trend pkts " + JSON.stringify(XM.pkts) + "/" + JSON.stringify(TRD.need) + " bad " + JSON.stringify(XM.bad) +
    " s " + JSON.stringify(TRD.s) + " epoch " + JSON.stringify(TRD.epoch));
  TRD.busy = false; TRD.ts = nowS();
  pubDiag(); pubState(); vcSync();
  busy = false;
  pump();
}
function xmFail(why) {
  XM.on = false; TRD.err = why; TRD.busy = false; TRD.ts = nowS();
  print("[ouman] trend FAIL " + why);
  // the controller may still be sending -> full re-init (cancels the upload)
  fail("xmodem " + why);
}
function trDecode() {
  let r = TR.bestRec, f = [], hs = "";
  TR.best = (r.charCodeAt(0) & 255) + (r.charCodeAt(1) & 255) * 256 + (r.charCodeAt(2) & 255) * 65536 + (r.charCodeAt(3) & 255) * 16777216;
  for (let k = 0; k < 8; k++) {
    let v = (r.charCodeAt(4 + 2 * k) & 255) + (r.charCodeAt(5 + 2 * k) & 255) * 256;
    if (v >= 32768) { v -= 65536; }
    f.push(v);
  }
  for (let j = 0; j < 20; j++) { hs += hx(r.charCodeAt(j) & 255); }
  TRD.epoch = TR.best; TRD.raw = f; TRD.hex = hs;
  trendRoles();
}
// trend fields 2/3/4 = measurement channels 3/4/5; type 283 = return water, 237 = DHW tank
function trendRoles() {
  if (!TRD.raw) { return; }
  V.ret = null; V.dhw = null;
  for (let j = 0; j < 3; j++) {
    let v = val(TRD.raw[2 + j] / 10);
    if (CH[j] === 283) { V.ret = v; }
    if (CH[j] === 237) { V.dhw = v; }
  }
}

// ===================================================================
//  STATE / DIAG
// ===================================================================
// <prefix>/state core, appended to s (no intermediate object)
function stateStr(s) {
  s += "{\"link\":"; s += JSON.stringify(ST.link); s += ",\"ts\":"; s += JSON.stringify(ST.ts);
  s += ",\"outdoor\":"; s += JSON.stringify(V.outdoor); s += ",\"supply\":"; s += JSON.stringify(V.supply);
  s += ",\"room\":"; s += JSON.stringify(V.room); s += ",\"return\":"; s += JSON.stringify(V.ret);
  s += ",\"dhw\":"; s += JSON.stringify(V.dhw); s += ",\"valve\":"; s += JSON.stringify(V.valve);
  s += ",\"room_set\":"; s += JSON.stringify(V.room_set); s += ",\"mode\":"; s += JSON.stringify(V.mode);
  s += ",\"away\":"; s += JSON.stringify(V.kp === null ? null : V.kp === "away");
  s += ",\"trend_age_s\":"; s += JSON.stringify(TRD.epoch ? localNowS() - TRD.epoch : null);
  s += ",\"trend_busy\":"; s += JSON.stringify(TRD.busy); s += ",\"debug\":"; s += JSON.stringify(CFG.DEBUG);
  s += "}";
  return s;
}
function pubState() { pub("/state", stateStr(""), true); }
// built by appending to one string (pre + diag + post): a 28-key rows object
// or a + b + c chains would multiply the peak memory
function rowName(i) { let n = csvItem(ROWS, i); return n ? n : "m" + JSON.stringify(i + 1); }
function diagStr(pre, post) {
  let s = pre;
  s += "{\"dev\":"; s += JSON.stringify(ST.dev); s += ",\"rows\":{";
  for (let i = 0; i < M.length; i++) {
    if (i) { s += ","; }
    s += "\""; s += rowName(i); s += "\":"; s += JSON.stringify(M[i]);
  }
  s += "},\"props\":"; s += JSON.stringify(P);
  s += ",\"status\":"; s += JSON.stringify((V.mode ? V.mode : "?") + " / " + (V.kp ? V.kp : "?"));
  s += ",\"ch\":"; s += JSON.stringify(CH);
  s += ",\"trend\":"; s += JSON.stringify(TRD);
  s += ",\"cmd\":"; s += JSON.stringify(ST.cmd);
  s += ",\"out\":"; s += JSON.stringify(ST.out);
  s += ",\"rej\":"; s += JSON.stringify(ST.rej);
  s += ",\"rej_ts\":"; s += JSON.stringify(ST.rej_ts);
  s += ",\"err\":"; s += JSON.stringify(ST.err);
  s += ",\"n\":"; s += JSON.stringify(ST.n);
  s += "}"; s += post;
  return s;
}
function pubDiag() { if (mqttOk()) { pub("/diag", diagStr("", ""), false); } }

// ===================================================================
//  COMMANDS  (MQTT <prefix>/set, HTTP POST, virtual components)
// ===================================================================
function rej(why) {
  ST.rej = why; ST.rej_ts = nowS();
  print("[ouman] rejected: " + why);
  dbg("REJ " + why);
  pubDiag();
  return false;
}
// one SET PROPERTY, checked against NEVER and WRITE_OK; queued ahead of reads
function wr(id, raw) {
  if (!CFG.ALLOW_WRITE) { return rej("writes disabled"); }
  if (isNaN(id) || isNaN(raw) || Math.floor(id) !== id || Math.floor(raw) !== raw) { return rej("prop/raw must be integers"); }
  if (inCsv(NEVER, id)) { return rej("property " + JSON.stringify(id) + " is never written"); }
  if (!inCsv(CFG.WRITE_OK, id)) { return rej("property " + JSON.stringify(id) + " not in WRITE_OK"); }
  if (queue.length > 12) { return rej("queue full"); }
  queue.splice(0, 0, "SET PROPERTY " + JSON.stringify(id) + " " + JSON.stringify(raw));
  pump();
  return true;
}
function submit(c) {
  c = String(c).trim().toUpperCase();
  if (c.indexOf("SET PROPERTY ") === 0) {
    let p = c.split(" ");
    if (p.length !== 4) { return rej("SET PROPERTY <id> <raw>"); }
    return wr(Number(p[2]), Number(p[3]));
  }
  if (c === "TREND") { trendWant = true; round(); return true; }
  let ok = inCsv(READS, c);
  if (!ok && (c.indexOf("GET PROPERTY ") === 0 || c.indexOf("MEASUREMENTS ") === 0)) {
    let n = Number(c.slice(13));
    ok = !isNaN(n) && Math.floor(n) === n && n >= 0 && c.length < 18;
  }
  if (!ok) { return rej("command not allowed: " + c.slice(0, 30)); }
  if (queue.length > 12) { return rej("queue full"); }
  queue.push(c);
  pump();
  return true;
}
function applyCmd(o) {
  if (typeof o !== "object" || o === null) { return rej("not a JSON object"); }
  let ok = true;
  if (o.debug !== undefined) { CFG.DEBUG = (o.debug === true); pubState(); }
  if (o.trend === true) { trendWant = true; round(); }
  if (o.room_set !== undefined) {
    let v = Number(o.room_set);
    if (isNaN(v) || v < 5 || v > 30) { return rej("room_set 5-30"); }
    ok = wr(81, Math.round(v * 2) * 5) && ok;
  }
  if (o.mode !== undefined) {
    let c = modeCode(o.mode);
    if (c < 0) { return rej("mode " + JSON.stringify(o.mode)); }
    ok = wr(59, c) && ok;
  }
  if (o.away !== undefined) { ok = wr(135, (o.away === true || o.away === 1 || o.away === "away") ? 1 : 0) && ok; }
  if (o.prop !== undefined) { ok = wr(Number(o.prop), Number(o.raw)) && ok; }
  if (o.cmd !== undefined) { ok = submit(o.cmd) && ok; }
  return ok;
}
function onSet(topic, msg) {
  let o = null;
  try { o = JSON.parse(msg); } catch (e) { rej("bad JSON"); return; }
  applyCmd(o);
}
function onHttp(req, res) {
  let acc = null;
  if (req.method === "POST" && req.body) {
    let o = null;
    try { o = JSON.parse(req.body); } catch (e) { o = null; }
    acc = applyCmd(o);
    // a command gets a short reply (memory); GET returns state + diag
    res.code = 200;
    res.body = "{\"accepted\":" + JSON.stringify(acc) + ",\"queue\":" + JSON.stringify(queue.length) + "}";
    res.send();
    return;
  }
  let pre = "{\"accepted\":";
  pre += JSON.stringify(acc); pre += ",\"queue\":"; pre += JSON.stringify(queue.length);
  pre += ",\"state\":"; pre = stateStr(pre); pre += ",\"diag\":";
  res.code = 200;
  res.headers = [["Content-Type", "application/json"]];
  res.body = diagStr(pre, "}");
  res.send();
}

// ===================================================================
//  VIRTUAL COMPONENTS  (made by the companion script; bound here)
//  number 200 outdoor, 201 supply, 202 room, 203 return, 204 DHW, 205 valve,
//  206 room setpoint, enum 207 mode, boolean 208 link, group 209
// ===================================================================
function vcBind() {
  if (typeof Virtual === "undefined") { return; }
  let k = "number:200,number:201,number:202,number:203,number:204,number:205,number:206,enum:207,boolean:208".split(",");
  for (let j = 0; j < 9; j++) {
    if (vcH[j]) { continue; }
    try { vcH[j] = Virtual.getHandle(k[j]); } catch (e) { vcH[j] = null; }
    try {
      if (vcH[j] && j === 6) { vcH[6].on("change", onVcRoomSet); }
      if (vcH[j] && j === 7) { vcH[7].on("change", onVcMode); }
    } catch (e2) { }
  }
  vcSync();
}
// our own setValue fires "change" too -> compare with the controller value
function onVcRoomSet(ev) { if (ev && ev.value !== undefined && ev.value !== V.room_set) { applyCmd({ room_set: ev.value }); } }
function onVcMode(ev) { if (ev && ev.value !== undefined && ev.value !== V.mode) { applyCmd({ mode: ev.value }); } }
function vcSet(i, v) {
  let h = vcH[i];
  if (!h || v === null || v === undefined) { return; }
  try { if (h.getValue() !== v) { h.setValue(v); } } catch (e) { }
}
function vcSync() {
  vcSet(0, V.outdoor); vcSet(1, V.supply); vcSet(2, V.room); vcSet(3, V.ret); vcSet(4, V.dhw);
  vcSet(5, V.valve); vcSet(6, V.room_set); vcSet(7, V.mode); vcSet(8, ST.link);
}

// ===================================================================
//  START
// ===================================================================
function serialCb(res, err, msg, ud) {
  if (err === 0 && res && res.serial && res.serial.baud !== CFG.BAUD) {
    Shelly.call("Serial.SetConfig", { id: 0, config: { serial: { baud: CFG.BAUD, format: "8N1" } } }, null, null);
    print("[ouman] Serial baud set to " + JSON.stringify(CFG.BAUD));
  }
}
U = UART.get(0);
U.configure({ baud: CFG.BAUD, mode: "8N1", format: "8N1" });
U.recv(onRx);
WRW = CFG.BAUD >= 57600 ? 20 : 120;
HTTPServer.registerEndpoint(CFG.HTTP_ENDPOINT, onHttp);
try { MQTT.subscribe(CFG.MQTT_PREFIX + "/set", onSet); } catch (e) { print("[ouman] MQTT disabled -> HTTP and virtual components only"); }
Timer.set(CFG.POLL_MS, true, round, null);
Shelly.call("Serial.GetConfig", { id: 0 }, serialCb, null);
Timer.set(800, false, init, null);
