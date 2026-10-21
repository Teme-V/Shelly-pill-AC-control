/**
 * @title Panasonic CN-CNT (CZ-TACG1) heat pump control for the Shelly Pill
 * @description Polls a Panasonic air-to-air heat pump through its CN-CNT port
 *   (9600 8E1) and controls it from the Shelly app (virtual components), MQTT
 *   and HTTP. READ_ONLY by default: nothing is written until you allow it.
 * @status experimental
 * @link https://github.com/Teme-V/Shelly-pill-AC-control/tree/main/panasonic/cncnt
 */

/*
 * Copyright 2026 Teemu Virta
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy
 * at http://www.apache.org/licenses/LICENSE-2.0 . Distributed on an "AS IS"
 * BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
 *
 * CN-CNT protocol information: DomiStyle/esphome-panasonic-ac @c56eb4f (MIT,
 * CZ-TACG1 part, components/panasonic_ac/esppac_cnt.cpp). This script is an
 * independent implementation and contains no code from that project; see
 * NOTICE in the repository root. Line references below point to that file
 * unless noted.
 *
 * ---------------------------------------------------------------------------
 * Edit ONLY the CFG block, paste the whole file into a Shelly script
 * (Web UI -> Scripts -> Add script), Save, Start, enable "Run on startup".
 * Requirements: Pill firmware 2.0.1+, Pill peripheral mode js_uart
 * (Pill.SetConfig {"config":{"mode":"js_uart"}}). The script sets the serial
 * port to 9600 8E1 itself at every start (a firmware update resets it).
 *
 * !! LEVEL SHIFTER: CN-CNT is 5 V TTL, the Pill is 3.3 V. Use a 2-channel MH
 * !! shifter WITH ITS OWN LDO (662K / XC6206). The Pill terminals do not
 * !! provide 3.3 V; without the LDO the Pill can read the unit but its
 * !! commands never arrive ("reads but does not write").
 *
 * !! NEVER plug a Mitsubishi CN105 cable or adapter into CN-CNT. The housing
 * !! fits (JST PA, PAP-05V-S) but the pin order differs: CN-CNT pin 4 = +12 V
 * !! lands on the CN105 TX wire and the shifter, pin 1 = +5 V on CN105 GND.
 *
 * Wiring (CN-CNT pin numbers, HeishaMon order):
 *   1 +5 V          -> shifter HV / 5V (its LDO makes 3V3) AND Pill 5 V supply
 *   2 RX (to AC)    <- shifter HV2 <- LV2 <- Pill IO1 (TX)
 *   3 TX (from AC)  -> shifter HV1 -> LV1 -> Pill IO2 (RX)
 *   (pins 2/3 verified on a live unit 19 Oct 2026; some sources swap them)
 *   4 +12 V         -> NOT connected (never to a signal)
 *   5 GND           -> shifter GND (both sides), Pill GND
 *   Remove a CZ-TACG1 adapter first: CN-CNT can have only one master.
 *
 * Commands (MQTT <prefix>/set or HTTP POST /script/<id>/<HTTP_ENDPOINT>):
 *   {"power":"ON"|"OFF"} {"mode":"HEAT|DRY|COOL|FAN|AUTO"} (mode switches on)
 *   {"temp":16..30 step 0.5} {"fan":"AUTO|QUIET|POWERFUL|1..5"} {"vane":"AUTO|1..5|SWING"}
 *   {"wideVane": "<<" "<" "|" ">" ">>" or "AUTO"}
 *   {"swing":"BOTH|OFF|VERTICAL|HORIZONTAL"}
 *   {"preset":"NORMAL|POWERFUL|QUIET"} {"eco":true} {"nanoex":true}
 *   {"econavi":true} {"mild_dry":true} {"echo":true} (resend the state as is)
 * Several keys in one command, or commands within CMD_GAP_MS, go out in one
 * control frame built from the latest poll. Script switches (work also in
 * READ_ONLY and without a link, not saved over a restart):
 *   {"debug":true|false}      frame dump on/off (on restarts the auto-off)
 *   {"read_only":true|false}  allow / block control frames
 * MQTT: <prefix>/state (common core), <prefix>/diag (all Panasonic data incl.
 * the raw reply), <prefix>/debug (with DEBUG: lines "T|R|X <hex> @<ms>" =
 * frame sent / valid frame received / raw UART chunk, ms since script start,
 * one message per DEBUG_FLUSH_MS). HTTP GET returns the state, GET ...?diag
 * the diag JSON.
 *
 * MQTT broker from the script (MQTT_HOST set): the script writes host, TLS,
 * user, password, prefix and the RPC switch into the Pill's own MQTT settings
 * and reboots ONCE ("MQTT config applied"). The password is sent only to the
 * Pill's MQTT settings, never printed or published.
 *
 * Espruino rules followed: no closures (globals only), Timer.set instead of
 * setTimeout, no forEach/map/filter, zero bytes built with
 * String.fromCharCode, at most one Shelly.call in flight at boot.
 *
 * version 20261021-1
 */

// ===================================================================
//  CONFIGURATION - the only block you need to edit
// ===================================================================
let CFG = {
  UART_ID: 0,
  BAUD: 9600,
  FORMAT: "8E1",             // CN-CNT = 9600 8E1, do not change

  TICK_MS: 200,              // state machine tick (one tick ~25 ms of interpreter time on a Pill)
  POLL_MS: 5000,             // poll 5 s after the last frame sent (POLL_INTERVAL, esppac_cnt.h:12)
  CMD_GAP_MS: 250,           // min gap before a control frame (CMD_INTERVAL, esppac_cnt.h:13)
  VERIFY_POLL_MS: 500,       // extra poll this long after a control frame
  RESP_TIMEOUT_MS: 1000,     // poll without a valid reply within this = missed
  SET_MAX_AGE_MS: 1000,      // control frame only from a poll this fresh, else poll first (0 = off)
  LINK_FAILS: 3,             // missed polls in a row -> link false

  READ_ONLY: true,           // true = never send a control frame (0xF0)

  MIN_TEMP: 16,              // esppac.h:20-21
  MAX_TEMP: 30,

  // -- MQTT (optional) -----------------------------------------------
  // MQTT_ENABLE is the master switch: false = no MQTT at all.
  // MQTT_HOST "" = use the broker set in the Pill's web UI (Settings -> MQTT);
  // then set the web UI "MQTT prefix" to MQTT_PREFIX too.
  // MQTT_HOST set = the script writes HOST/TLS/USER/PASS/PREFIX/RPC into the
  // Pill's MQTT settings at start and reboots once to apply them.
  MQTT_ENABLE: false,
  MQTT_HOST: "",             // "host" or "host:port" (default port 1883, with TLS 8883)
  MQTT_TLS: false,           // true = TLS, server checked with the Pill's built-in CA bundle (ca.pem)
  MQTT_USER: "",             // "" = no user
  MQTT_PASS: "",
  MQTT_RPC: true,            // false = no RPC, notifications or MQTT control over MQTT (test broker)
  MQTT_PREFIX: "panasonic",  // <prefix>/state, /set, /diag, /debug (+ the Pill's own <prefix>/online)

  HTTP_ENDPOINT: "pac",      // http://<pill-ip>/script/<id>/pac
  VC_GROUP_NAME: "PanasonicAC",  // the virtual device in the Shelly app (10 of the Pill's max 10 VCs)

  DEBUG: false,              // log every TX/RX frame; with MQTT also <prefix>/debug
  DEBUG_FLUSH_MS: 2000,      // <prefix>/debug: one message per this period
  DEBUG_AUTO_OFF_MIN: 1440   // DEBUG switches itself off after this (0 = never)
};

// ===================================================================
//  [panasonic] PROTOCOL MAPS (esppac_cnt.cpp:12-120, 219-310)
//  data[i] = reply byte i+2; a control frame carries the same 10 bytes.
// ===================================================================
let MODE_N   = [0x4,    0x2,   0x3,    0x6,   0x0];    // data[0] high nibble
let MODE_M   = ["HEAT", "DRY", "COOL", "FAN", "AUTO"];
let FAN_B    = [0xA0,   0x30, 0x40, 0x50, 0x60, 0x70]; // data[3]
let FAN_S    = ["AUTO", "1",  "2",  "3",  "4",  "5"];
// fan as shown and accepted (VC, state, commands): QUIET / POWERFUL are the
// data[5] preset on top of fan AUTO, as the remote shows them (live 19.10.2026)
let FAN_M    = ["AUTO", "QUIET", "POWERFUL", "1", "2", "3", "4", "5"];
let VANE_N   = [0xF,    0x1, 0x2, 0x3, 0x4, 0x5, 0xE]; // data[4] high nibble
let VANE_M   = ["AUTO", "1", "2", "3", "4", "5", "SWING"];
let WVANE_N  = [0x9,  0xA, 0x6, 0xB, 0xC,  0xD];       // data[4] low nibble
let WVANE_M  = ["<<", "<", "|", ">", ">>", "AUTO"];
let SWING_B  = [0xFD,   0x36,  0xF6,       0x3D];      // data[4] shortcuts (:277-293)
let SWING_M  = ["BOTH", "OFF", "VERTICAL", "HORIZONTAL"];
let PRESET_N = [0x0,      0x2,        0x4];            // data[5] low nibble
let PRESET_M = ["NORMAL", "POWERFUL", "QUIET"];
let POLL_DATA = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];        // CMD_POLL (esppac_commands_cnt.h:11)
let RX_IDLE_MS = 200;      // a frame still incomplete after this silence is garbage

// ===================================================================
//  [runko] STATE
// ===================================================================
let uart = null;
let rxBuf = [];
let lastRxByteMs = 0;
let lastTxMs = 0;
let awaiting = false;      // poll sent, no valid reply yet
let pollSentMs = 0;
let link = false;
let misses = 0;
let data = null;           // data[0..9] of the last valid 0x70 reply
let dataMs = 0;
let lastRx = null;         // that whole reply
let lastPrinted = "";
let startMs = 0;           // script start (uptime ms), for the @<ms> stamps of the dump
let DBG_MAX = 1024;        // dump characters waiting for the flush; a few poll cycles fit
let dbgLines = [];         // an array, not one growing string: a 4 kB string buffer ran
let dbgLen = 0;            // the Pill out of memory (CN105 kit, live 12.10.2026)
let dbgDropped = 0;
let dbgOffAt = 0;          // uptime ms of the DEBUG auto-off, 0 = none
let dbgFlushAt = 0;
let linkPubAt = 0;         // last state publish while the link is down
let LINK_DOWN_PUB_MS = 10000;

let cur = {
  power: null, mode: null, temp: null, fan: null, vane: null, wideVane: null,
  room: null, roomSrc: null, outside: null, outsideSrc: null, powerW: null,
  defrost: null, preset: null, nanoex: null, econavi: null, eco: null, mildDry: null
};

let want = {
  power: null, mode: null, temp: -1, fan: null, vane: null, wideVane: null, swing: null,
  preset: null, eco: null, nanoex: null, econavi: null, mildDry: null, echo: false, dirty: false
};

// control frame verification
let ver = { pending: false, blob: null, base: null, polls: 0, setMs: 0, result: null, diff: null };

let cnt = { rx: 0, bad: 0, drop: 0, ctrl: 0, echo: 0, poll: 0, miss: 0, set: 0, rejected: 0 };

// ===================================================================
//  [runko] HELPERS
// ===================================================================
function hex(n) {
  let h = "0123456789ABCDEF";
  return h.charAt((n >> 4) & 0x0F) + h.charAt(n & 0x0F);
}

function hexArr(a) {
  let s = "";
  for (let i = 0; i < a.length; i++) { s += (i ? " " : "") + hex(a[i]); }
  return s;
}

function dbg(msg) { if (CFG.DEBUG) { print("[pac] " + msg); } }

function idx(arr, v) {
  for (let i = 0; i < arr.length; i++) { if (arr[i] === v) { return i; } }
  return -1;
}

function mapTo(bArr, mArr, v) {
  let i = idx(bArr, v);
  return i < 0 ? null : mArr[i];
}

// upper case by hand: String.toUpperCase is not on the verified fw 2.0.1
// method list (that firmware lacks even Array.shift/unshift)
function up(v) {
  if (v === undefined || v === null) { return null; }
  let s = "" + v, r = "";
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    r += (c >= 97 && c <= 122) ? String.fromCharCode(c - 32) : s.charAt(i);
  }
  return r;
}

// uptime ms (monotonic); Date.now() jumps when the clock gets synced.
// The typeof check runs once: every call costs interpreter time.
let HAS_UPTIME = (typeof Shelly.getUptimeMs === "function");
function upMs() { return HAS_UPTIME ? Shelly.getUptimeMs() : Date.now(); }

function onOff(v) {
  let s = up(v);
  if (s === "TRUE" || s === "ON" || s === "1") { return true; }
  if (s === "FALSE" || s === "OFF" || s === "0") { return false; }
  return null;
}

function mqttOk() {
  return CFG.MQTT_ENABLE && typeof MQTT !== "undefined" && MQTT.isConnected();
}

// MQTT.subscribe THROWS "MQTT is disabled" while the Pill's own MQTT is off,
// e.g. on the first start before mqttEnsure() has applied MQTT_HOST; the
// one-time reboot that follows starts the script again with MQTT on
function mqttSub(topic, cb) {
  try {
    MQTT.subscribe(topic, cb, null);
  } catch (e) {
    print("[pac] MQTT is off on the Pill - " + topic + " not subscribed yet");
  }
}

// [runko] frame dump: console line per frame; MQTT lines (T = frame sent,
// R = valid frame received, X = raw UART chunk) wait in dbgLines and go out
// as one message per DEBUG_FLUSH_MS; beyond DBG_MAX characters the oldest
// lines are dropped. Flush, auto-off and the link-down state run from the
// tick timer: a script may have at most 5 timers.
function pubDebug(dir, code, h) {
  print("[pac] " + dir + " " + h);
  if (!CFG.MQTT_ENABLE) { return; }
  let l = code + " " + h + " @" + JSON.stringify(upMs() - startMs);
  dbgLines.push(l);
  dbgLen += l.length + 1;
  while (dbgLen > DBG_MAX && dbgLines.length > 1) {
    dbgLen -= dbgLines[0].length + 1;
    dbgLines.splice(0, 1);       // fw 2.0.1 has no Array shift/unshift
    dbgDropped++;
  }
}

function dbgFlush() {
  if (dbgLines.length === 0 || !mqttOk()) { return; }
  let m = dbgLines.join("\n");
  if (dbgDropped > 0) { m = "...dropped " + JSON.stringify(dbgDropped) + "\n" + m; }
  MQTT.publish(CFG.MQTT_PREFIX + "/debug", m, 0, false);
  dbgLines = [];
  dbgLen = 0;
  dbgDropped = 0;
}

function setDebug(on, quiet) {
  CFG.DEBUG = on;
  dbgOffAt = (on && CFG.DEBUG_AUTO_OFF_MIN > 0) ? upMs() + CFG.DEBUG_AUTO_OFF_MIN * 60000 : 0;
  print("[pac] Debug " + (on ? "on" : "off") + (dbgOffAt > 0 ?
        ", auto-off in " + JSON.stringify(CFG.DEBUG_AUTO_OFF_MIN) + " min" : ""));
  if (!quiet) { publishAll(); }
}

function debugAutoOff() {
  dbgOffAt = 0;
  CFG.DEBUG = false;
  print("[pac] Debug auto-off");
  publishAll();
}

// with every tick, before the state machine
function auxTick(now) {
  if (dbgOffAt > 0 && now >= dbgOffAt) { debugAutoOff(); }
  if (now - dbgFlushAt >= CFG.DEBUG_FLUSH_MS) {
    dbgFlushAt = now;
    dbgFlush();
  }
  // no link -> no reply publishes the state: keep connected:false visible
  if (!link && now - linkPubAt >= LINK_DOWN_PUB_MS) {
    linkPubAt = now;
    publishAll();
  }
}

// ===================================================================
//  [panasonic] FRAMES
//  header, L = number of data bytes, data, checksum; all bytes sum to
//  0 mod 256 (esppac_cnt.cpp:391-404, check :466-472)
// ===================================================================
function frame(h, d) {
  let f = [h, d.length];
  let s = h + d.length;
  for (let i = 0; i < d.length; i++) { f.push(d[i] & 0xFF); s += d[i] & 0xFF; }
  f.push((0x100 - (s & 0xFF)) & 0xFF);
  return f;
}

// [runko] transmit; refuses a frame whose zero bytes got lost
function sendFrame(f) {
  let s = "";
  for (let i = 0; i < f.length; i++) { s += String.fromCharCode(f[i]); }
  if (s.length !== f.length) {
    print("[pac] ERROR: frame truncated to " + JSON.stringify(s.length) + "/" +
          JSON.stringify(f.length) + " bytes (zero-byte problem) - not sent");
    return false;
  }
  if (CFG.DEBUG) { pubDebug("TX", "T", hexArr(f)); }
  let n = uart.send ? uart.send(s) : uart.write(s);
  if (typeof n === "number" && n !== s.length) {
    print("[pac] WARNING: UART sent " + JSON.stringify(n) + "/" + JSON.stringify(s.length) + " bytes");
  }
  lastTxMs = upMs();
  return true;
}

function sendPoll() {
  if (!sendFrame(frame(0x70, POLL_DATA))) { return; }
  awaiting = true;
  pollSentMs = lastTxMs;
  cnt.poll++;
  if (ver.pending) { ver.polls++; }
}

// ===================================================================
//  [runko] RECEIVE AND FRAMING
//  Header 0x70|0xF0, length [1]+3 (12..128), sum 0. Any error drops ONE
//  byte and searches again: 0x70 also occurs inside data (fan 5).
// ===================================================================
function onRx(s) {
  if (s.length === 0) { return; }
  lastRxByteMs = upMs();
  if (CFG.DEBUG && !link) {         // raw chunks only while unlinked: wiring/parity diagnosis
    let h = "";
    for (let j = 0; j < s.length; j++) { h += (j ? " " : "") + hex(s.charCodeAt(j) & 0xFF); }
    pubDebug("RAW", "X", h);
  }
  for (let i = 0; i < s.length; i++) {
    if (rxBuf.length >= 256) { cnt.drop += rxBuf.length; rxBuf = []; }
    rxBuf.push(s.charCodeAt(i) & 0xFF);
  }
  parseRx(false);
}

function dropByte() {
  rxBuf.splice(0, 1);
  cnt.drop++;
}

// stale = no bytes for RX_IDLE_MS: an incomplete frame will never finish
function parseRx(stale) {
  while (rxBuf.length > 0) {
    if (rxBuf[0] !== 0x70 && rxBuf[0] !== 0xF0) { dropByte(); continue; }
    if (rxBuf.length < 2) { if (!stale) { return; } dropByte(); continue; }
    let n = rxBuf[1] + 3;
    if (n < 12 || n > 128) { dropByte(); continue; }
    if (rxBuf.length < n) { if (!stale) { return; } dropByte(); continue; }
    let s = 0;
    for (let i = 0; i < n; i++) { s += rxBuf[i]; }
    if ((s & 0xFF) !== 0) {
      cnt.bad++;
      dbg("checksum FAIL (sum " + hex(s & 0xFF) + "), dropping 1 byte");
      dropByte();
      continue;
    }
    handleFrame(rxBuf.splice(0, n));
  }
}

function isPollEcho(f) {
  if (f.length !== 13 || f[0] !== 0x70) { return false; }
  for (let i = 2; i < 12; i++) { if (f[i] !== 0) { return false; } }
  return true;
}

function handleFrame(f) {
  if (CFG.DEBUG) { pubDebug("RX", "R", hexArr(f)); }
  if (isPollEcho(f)) {
    cnt.echo++;
    if (cnt.echo === 1) { print("[pac] WARNING: received our own poll back - check that the TX and RX wires are not joined"); }
    return;
  }
  cnt.rx++;
  if (f[0] === 0xF0) {               // DomiStyle ignores these too (:491-493)
    cnt.ctrl++;
    dbg("0xF0 frame from the unit (ignored)");
    return;
  }
  awaiting = false;
  misses = 0;
  data = f.slice(2, 12);
  dataMs = upMs();
  lastRx = f;
  decode(f);
  if (!link) {
    link = true;                     // no handshake: first valid reply = Ready (:489-490)
    print("[pac] Link up");
  }
  if (ver.pending) { verifyCheck(); }
  publishAll();
}

// ===================================================================
//  [panasonic] DECODER (esppac_cnt.cpp:315-386, esppac.cpp:80-105)
// ===================================================================
function tempAt(f, i) {
  if (i === null) { return null; }
  let t = f[i] >= 128 ? f[i] - 256 : f[i];     // int8
  return t > 100 ? null : t;                   // TEMPERATURE_THRESHOLD
}

function decode(f) {
  let d = data;
  cur.power = (d[0] & 0x0F) !== 0 ? "ON" : "OFF";
  cur.mode = mapTo(MODE_N, MODE_M, (d[0] >> 4) & 0x0F);
  cur.temp = d[1] / 2 > 100 ? null : d[1] / 2;
  cur.mildDry = d[2] === 0x7F;
  cur.vane = mapTo(VANE_N, VANE_M, (d[4] >> 4) & 0x0F);
  cur.wideVane = mapTo(WVANE_N, WVANE_M, d[4] & 0x0F);
  cur.preset = mapTo(PRESET_N, PRESET_M, d[5] & 0x0F);
  cur.fan = (cur.preset === "QUIET" || cur.preset === "POWERFUL") ? cur.preset : mapTo(FAN_B, FAN_S, d[3]);
  cur.nanoex = (d[5] & 0x40) !== 0;
  cur.econavi = (d[5] & 0x10) !== 0;
  cur.eco = d[8] === 0x40;
  cur.defrost = f.length >= 15 ? f[14] === 0x02 : null;
  if (f.length >= 31) {              // rx[18..30] only from a long enough reply
    cur.roomSrc = f[18] !== 0x80 ? 18 : (f[21] !== 0x80 ? 21 : null);   // 0x80 = not supported
    cur.outsideSrc = f[19] !== 0x80 ? 19 : (f[22] !== 0x80 ? 22 : null);
    cur.room = tempAt(f, cur.roomSrc);
    cur.outside = tempAt(f, cur.outsideSrc);
    cur.powerW = f[28] + 256 * f[29] - f[30];
  } else {
    cur.room = null; cur.roomSrc = null; cur.outside = null; cur.outsideSrc = null; cur.powerW = null;
  }
}

// ===================================================================
//  [panasonic] CONTROL FRAME (0xF0)
//  = data[0..9] of the latest poll + the requested changes; one frame
//  for everything pending (esppac_cnt.cpp:206-310, 500-638)
// ===================================================================
function sendSet() {
  if (CFG.READ_ONLY) { clearWant(); return; }        // READ_ONLY may be set at run time
  let b = data.slice(0);
  if (want.mode !== null) {                          // a mode always switches on (:219-233)
    b[0] = (MODE_N[idx(MODE_M, want.mode)] << 4) | 0x04;
  }
  if (want.power === "OFF") {
    b[0] = b[0] & 0xF0;                              // strip the low nibble (:235)
  } else if (want.power === "ON" && (b[0] & 0x0F) === 0) {
    b[0] = b[0] | 0x04;
  }
  if (want.temp > 0) { b[1] = Math.round(want.temp * 2) & 0xFF; }   // 0.5 C steps (:245)
  if (want.fan === "QUIET" || want.fan === "POWERFUL") {
    b[3] = 0xA0;                                     // the remote shows fan AUTO with quiet/powerful
    b[5] = (b[5] & 0xF0) | PRESET_N[idx(PRESET_M, want.fan)];
  } else if (want.fan !== null) {
    b[3] = FAN_B[idx(FAN_S, want.fan)];
    b[5] = b[5] & 0xF0;                              // fan change resets powerful/quiet (:251-254)
  }
  if (want.preset !== null) { b[5] = (b[5] & 0xF0) | PRESET_N[idx(PRESET_M, want.preset)]; }
  if (want.swing !== null) { b[4] = SWING_B[idx(SWING_M, want.swing)]; }
  if (want.vane !== null) { b[4] = (b[4] & 0x0F) | (VANE_N[idx(VANE_M, want.vane)] << 4); }
  if (want.wideVane !== null) { b[4] = (b[4] & 0xF0) | WVANE_N[idx(WVANE_M, want.wideVane)]; }
  if (want.eco !== null) { b[8] = want.eco ? 0x40 : 0x00; }
  // nanoeX and econavi change their own bit only. DomiStyle writes the whole
  // high nibble (:573/576) or the whole byte (:613/616) and so clears the
  // other flags and powerful/quiet.
  if (want.nanoex !== null) { b[5] = want.nanoex ? (b[5] | 0x40) : (b[5] & 0xBF); }
  if (want.econavi !== null) { b[5] = want.econavi ? (b[5] | 0x10) : (b[5] & 0xEF); }
  if (want.mildDry !== null) { b[2] = want.mildDry ? 0x7F : 0x80; }
  clearWant();

  let f = frame(0xF0, b);
  if (!sendFrame(f)) { return; }
  cnt.set++;
  ver.pending = true;
  ver.blob = b;
  ver.base = data.slice(0);
  ver.polls = 0;
  ver.setMs = lastTxMs;
  ver.result = null;
  ver.diff = null;
  print("[pac] SET " + hexArr(f));
}

function clearWant() {
  want.power = null; want.mode = null; want.temp = -1; want.fan = null;
  want.vane = null; want.wideVane = null; want.swing = null; want.preset = null;
  want.eco = null; want.nanoex = null; want.econavi = null; want.mildDry = null;
  want.echo = false; want.dirty = false;
}

// The unit sends no ACK (:491-493): the next replies are compared with the
// frame sent. Verified = every byte we changed reads back as sent (an echo
// frame: all bytes). Not verified after the verify poll AND the next poll.
function verifyCheck() {
  let ok = true, changed = false, diff = [];
  for (let i = 0; i < 10; i++) {
    if (data[i] !== ver.blob[i]) { diff.push(i); }
    if (ver.blob[i] !== ver.base[i]) {
      changed = true;
      if (data[i] !== ver.blob[i]) { ok = false; }
    }
  }
  if (!changed) { ok = (diff.length === 0); }
  ver.diff = diff;
  if (ok) {
    ver.result = true;
    ver.pending = false;
    print("[pac] SET verified");
  } else if (ver.polls >= 2) {
    ver.result = false;
    ver.pending = false;
    print("[pac] SET NOT verified, data bytes differing from the frame sent: " + JSON.stringify(diff));
  }
}

// ===================================================================
//  [runko] STATE MACHINE CLOCK
//  No handshake. Poll POLL_MS after the last frame sent; pending
//  commands go out CMD_GAP_MS after the last frame, from a poll at most
//  SET_MAX_AGE_MS old (else a poll first: the remote may have changed
//  the unit since); verify poll VERIFY_POLL_MS after a control frame.
// ===================================================================
function tick() {
  let now = upMs();
  auxTick(now);
  if (rxBuf.length > 0 && (now - lastRxByteMs) > RX_IDLE_MS) { parseRx(true); }

  if (awaiting && (now - pollSentMs) > CFG.RESP_TIMEOUT_MS) {
    awaiting = false;
    misses++;
    cnt.miss++;
    dbg("no reply to poll, misses=" + JSON.stringify(misses));
    if (misses >= CFG.LINK_FAILS && link) {
      link = false;
      clearWant();
      print("[pac] Link lost: " + JSON.stringify(misses) + " polls without a valid reply");
      publishAll();
    }
  }

  let gap = now - lastTxMs;
  if (want.dirty && link) {
    if (gap < CFG.CMD_GAP_MS) { return; }
    if (CFG.SET_MAX_AGE_MS <= 0 || (now - dataMs) <= CFG.SET_MAX_AGE_MS) { sendSet(); return; }
    if (!awaiting) { dbg("refresh poll before the control frame"); sendPoll(); }
    return;
  }
  if (awaiting) { return; }
  if (ver.pending && ver.polls === 0) {
    if ((now - ver.setMs) >= CFG.VERIFY_POLL_MS && gap >= CFG.CMD_GAP_MS) { sendPoll(); }
    return;
  }
  if (gap >= CFG.POLL_MS) { sendPoll(); }
}

// ===================================================================
//  [runko] COMMAND INTERFACE (same JSON on MQTT, HTTP and from the VCs)
// ===================================================================
function applyCommand(o) {
  if (!o || typeof o !== "object") { return false; }
  // script switches first: they work in READ_ONLY and without a link
  let sw = false, unitKeys = 0, k = Object.keys(o);
  for (let i = 0; i < k.length; i++) { if (k[i] !== "debug" && k[i] !== "read_only") { unitKeys++; } }
  k = onOff(o.debug);
  if (k !== null) { setDebug(k, true); sw = true; }
  k = onOff(o.read_only);
  if (k !== null) {
    CFG.READ_ONLY = k;
    if (k) { clearWant(); }
    print("[pac] READ_ONLY " + JSON.stringify(k) + " (until the script restarts)");
    sw = true;
  }
  if (sw) { publishAll(); }
  if (unitKeys === 0) { return sw; }
  if (CFG.READ_ONLY) {
    cnt.rejected++;
    print("[pac] READ_ONLY: command ignored " + JSON.stringify(o));
    return false;
  }
  if (!link) {
    cnt.rejected++;
    print("[pac] No link to the unit: command ignored " + JSON.stringify(o));
    return false;
  }
  let t = false, v;
  v = o.power === true ? "ON" : (o.power === false ? "OFF" : up(o.power));
  if (v === "ON" || v === "OFF") { want.power = v; t = true; }
  v = up(o.mode);
  if (idx(MODE_M, v) >= 0) {
    want.mode = v;
    if (o.power === undefined) { want.power = null; }   // a later mode overrides an earlier OFF
    t = true;
  }
  if (o.temp !== undefined) {
    let x = Math.round(o.temp * 2) / 2;
    if (x >= CFG.MIN_TEMP && x <= CFG.MAX_TEMP) { want.temp = x; t = true; }
  }
  v = up(o.fan);        if (idx(FAN_M, v) >= 0) { want.fan = v; t = true; }
  v = up(o.vane);       if (idx(VANE_M, v) >= 0) { want.vane = v; t = true; }
  v = up(o.wideVane);   if (idx(WVANE_M, v) >= 0) { want.wideVane = v; t = true; }
  v = up(o.swing);      if (idx(SWING_M, v) >= 0) { want.swing = v; t = true; }
  v = up(o.preset);     if (idx(PRESET_M, v) >= 0) { want.preset = v; t = true; }
  v = onOff(o.eco);      if (v !== null) { want.eco = v; t = true; }
  v = onOff(o.nanoex);   if (v !== null) { want.nanoex = v; t = true; }
  v = onOff(o.econavi);  if (v !== null) { want.econavi = v; t = true; }
  v = onOff(o.mild_dry); if (v !== null) { want.mildDry = v; t = true; }
  if (o.echo === true) { want.echo = true; t = true; }
  if (t) { want.dirty = true; } else { print("[pac] Command not understood: " + JSON.stringify(o)); }
  return t;
}

// [runko] common core, the same keys for every brand (template.md)
function stateJson() {
  return JSON.stringify({
    connected: link,
    power: cur.power, mode: cur.mode, temp: cur.temp,
    fan: cur.fan, vane: cur.vane, wideVane: cur.wideVane,
    room_temp: cur.room,
    operating: null,                 // not in the CN-CNT protocol
    defrost: cur.defrost,
    remote_temp: 0, remote_temp_source: "internal", remote_temp_age_s: null,
    debug: CFG.DEBUG
  });
}

// [panasonic] everything else the unit reports
function diagJson() {
  let sys = Shelly.getComponentStatus("sys");   // uptime: Pill restarts (5 V supply budget) show as a drop
  return JSON.stringify({
    link: link, read_only: CFG.READ_ONLY, uptime_s: sys ? sys.uptime : null,
    outside_temp: cur.outside, defrost: cur.defrost, power_w: cur.powerW,
    eco: cur.eco, nanoex: cur.nanoex, econavi: cur.econavi, mild_dry: cur.mildDry, preset: cur.preset,
    room_src: cur.roomSrc, outside_src: cur.outsideSrc,
    unknown: data ? { d6: hex(data[6]), d7: hex(data[7]), d9: hex(data[9]) } : null,
    len: lastRx ? lastRx.length : null,
    raw: lastRx ? hexArr(lastRx) : null,
    set_verified: ver.result, set_diff: ver.diff,
    set_last: ver.blob ? hexArr(frame(0xF0, ver.blob)) : null,
    counters: cnt
  });
}

function publishAll() {
  let s = stateJson();
  if (CFG.DEBUG || s !== lastPrinted) { print("[pac] " + s); lastPrinted = s; }
  vcSync();
  if (mqttOk()) {
    MQTT.publish(CFG.MQTT_PREFIX + "/state", s, 0, false);
    MQTT.publish(CFG.MQTT_PREFIX + "/diag", diagJson(), 0, false);
  }
}

function onMqttSet(topic, msg, ud) {
  let o = null;
  try { o = JSON.parse(msg); } catch (e) { print("[pac] MQTT set: not JSON"); return; }
  applyCommand(o);
}

function onHttp(req, res, ud) {
  let body = null;
  if (req.body && req.body.length > 1) {
    let o = null;
    try { o = JSON.parse(req.body); } catch (e) { o = null; }
    applyCommand(o);
  } else if (req.query && req.query.indexOf("diag") >= 0) {
    body = diagJson();
  }
  res.code = 200;
  res.headers = [["Content-Type", "application/json"]];
  res.body = body ? body : stateJson();
  res.send();
}

// ===================================================================
//  [runko] VIRTUAL COMPONENTS - roles power, mode, fan, vane, wvane,
//  temp, room, link + group hvac (template.md) + [panasonic] power_w,
//  created in this order with Virtual.Add on fixed ids 200..209 (CN105 kit
//  path). power_w comes last and is optional: on a device already full of
//  other VCs it is left out and the group holds the rest. NOT the @meta block +
//  Script.getVcHandle: on Pill fw 2.0.1 a script with an @meta vc block
//  crashed the device at Script.Start (live 12.10.2026, even one role).
// ===================================================================
let VC_ROLES = ["power",   "mode", "fan",  "vane", "wvane", "temp",   "room",   "link",    "hvac",  "power_w"];
let VC_TYPES = ["boolean", "enum", "enum", "enum", "enum",  "number", "number", "boolean", "group", "number"];
let VC_IDS   = [200,       201,    202,    203,    204,     205,      207,      208,       206,     209];
let VC_NS    = ["Boolean", "Enum", "Enum", "Enum", "Enum",  "Number", "Number", "Boolean", "Group", "Number"];
let VC_GI = 8;             // index of the group
let VC_PW = 9;             // index of power_w
let vcH = [null, null, null, null, null, null, null, null, null, null];
let vcKey = ["", "", "", "", "", "", "", "", "", ""];
let PW_MAX = 5000;         // power_w VC range 0..PW_MAX W
let PW_DEADBAND = 5;       // W: smaller changes are not written to the VC
let vcMode = "none";
let vcIdx = 0;

// meta.ui.view: without it Power and the enums are hidden in the Shelly app
// and cloud ("Hidden"); views as the cloud offers them (live 19.10.2026)
function vcCfg(i) {
  if (i === 0) { return { name: "Power", meta: { ui: { view: "toggle" } } }; }
  if (i === 1) { return { name: "Mode", options: MODE_M, meta: { ui: { view: "dropdown" } } }; }
  if (i === 2) { return { name: "Fan", options: FAN_M, meta: { ui: { view: "dropdown" } } }; }
  if (i === 3) { return { name: "Vane", options: VANE_M, meta: { ui: { view: "dropdown" } } }; }
  if (i === 4) { return { name: "WVane", options: WVANE_M, meta: { ui: { view: "dropdown" } } }; }
  if (i === 5) {
    return { name: "Target temperature", min: CFG.MIN_TEMP, max: CFG.MAX_TEMP, default_value: 22,
             meta: { ui: { view: "slider", unit: "°C", step: 0.5 } } };
  }
  if (i === 6) {
    return { name: "Room temperature", min: 0, max: 50, default_value: 20,
             meta: { ui: { view: "label", unit: "°C", step: 0.5 } } };
  }
  if (i === 7) { return { name: "Link", meta: { ui: { view: "label" } } }; }
  if (i === VC_PW) {
    return { name: "Power consumption", min: 0, max: PW_MAX, default_value: 0,
             meta: { ui: { view: "label", unit: "W", step: 1 } } };
  }
  return { name: CFG.VC_GROUP_NAME };
}

function vcStart() {
  if (typeof Virtual === "undefined") {
    print("[pac] Virtual API not available - Shelly app control disabled");
    Timer.set(1000, false, mqttEnsure, null);
    return;
  }
  vcMode = "virtual_add";
  vcIdx = 0;
  vcEnsureNext();
}

function vcEnsureNext() {
  if (vcIdx >= VC_ROLES.length) {
    for (let i = 0; i < VC_ROLES.length; i++) {
      vcKey[i] = VC_TYPES[i] + ":" + JSON.stringify(VC_IDS[i]);
      vcH[i] = Virtual.getHandle(vcKey[i]);
    }
    vcGroup();
    return;
  }
  let ns = VC_NS[vcIdx];
  Shelly.call(ns + ".GetConfig", { id: VC_IDS[vcIdx] }, vcEnsureCb, ns);
}

function vcEnsureCb(res, err, msg, ns) {
  if (err === 0) {     // exists -> refresh the config; one RPC in flight
    Shelly.call(ns + ".SetConfig", { id: VC_IDS[vcIdx], config: vcCfgFor(vcIdx, res) }, vcNextCb, null);
    return;
  }
  Shelly.call("Virtual.Add", { type: VC_TYPES[vcIdx], id: VC_IDS[vcIdx], config: vcCfg(vcIdx) }, vcNextCb, null);
}

// SetConfig replaces meta as a whole (fw 2.0.1, live 20.10.2026): start from the
// device's meta (option titles, images, icons set in the app or cloud) and fill
// in only a view that was never set, and a missing unit and step. An empty view
// is "Hidden" chosen in the app and stays hidden (as CN105 20261020-3).
// No delete or for-in (fw 2.0.1).
function vcCfgFor(i, res) {
  let c = vcCfg(i);
  let old = (res && res.meta) ? res.meta : null;
  if (!c.meta || !old) { return c; }
  if (!old.ui) { old.ui = {}; }
  if (old.ui.view === undefined) { old.ui.view = c.meta.ui.view; }
  if (c.meta.ui.unit !== undefined && old.ui.unit === undefined) { old.ui.unit = c.meta.ui.unit; }
  if (c.meta.ui.step !== undefined && old.ui.step === undefined) { old.ui.step = c.meta.ui.step; }
  c.meta = old;
  return c;
}

function vcNextCb(res, err, msg, ud) {
  if (err !== 0) {
    print("[pac] VC " + VC_TYPES[vcIdx] + ":" + JSON.stringify(VC_IDS[vcIdx]) + " failed: " + msg);
  }
  vcIdx++;
  vcEnsureNext();
}

// group hvac = the role components that exist (Group.Set rejects the whole
// list if one key is missing, so a role the device could not create - e.g.
// power_w on a Pill full of other VCs - is left out)
function vcGroup() {
  let keys = [];
  for (let i = 0; i < VC_ROLES.length; i++) {
    if (i === VC_GI) { continue; }
    if (vcH[i]) { keys.push(vcKey[i]); } else { print("[pac] VC role " + VC_ROLES[i] + " missing - left out of the group"); }
  }
  Shelly.call("Group.Set", { id: VC_IDS[VC_GI], value: keys }, vcGroupCb, null);
}

function vcGroupCb(res, err, msg, ud) {
  if (err !== 0) { print("[pac] Group.Set failed: " + msg); }
  vcBind();
}

function vcBind() {
  let ok = true;
  try {
    if (vcH[0]) { vcH[0].on("change", onVcPower); }
    if (vcH[1]) { vcH[1].on("change", onVcMode); }
    if (vcH[2]) { vcH[2].on("change", onVcFan); }
    if (vcH[3]) { vcH[3].on("change", onVcVane); }
    if (vcH[4]) { vcH[4].on("change", onVcWVane); }
    if (vcH[5]) { vcH[5].on("change", onVcTemp); }
  } catch (e) { ok = false; }
  if (!ok) {
    Shelly.addStatusHandler(vcStatusFallback, null);
    print("[pac] VC on(change) not supported - using a status handler");
  }
  print("[pac] Virtual components ready (" + vcMode + ")");
  vcSync();
  Timer.set(1000, false, mqttEnsure, null);   // last boot stage: it may reboot once
}

// ===================================================================
//  [runko] MQTT BROKER FROM CFG (MQTT_HOST set)
//  Writes the broker into the Pill's own MQTT settings and reboots once.
//  A KVS signature of the applied values (password only as a change hash)
//  makes a changed password apply again while an unchanged config never
//  reboots; max 3 attempts, then it gives up. One RPC in flight at a time.
// ===================================================================
let MQTT_KVS_KEY = "pac_mqtt_applied";
let mqttCur = null;

function mqttServer() {
  if (CFG.MQTT_HOST.indexOf(":") >= 0) { return CFG.MQTT_HOST; }
  return CFG.MQTT_HOST + (CFG.MQTT_TLS ? ":8883" : ":1883");
}

// change detection only, not a secret hash
function mqttSig() {
  let h = 0;
  for (let i = 0; i < CFG.MQTT_PASS.length; i++) { h = ((h * 31) + CFG.MQTT_PASS.charCodeAt(i)) & 0xFFFFFF; }
  return mqttServer() + "|" + CFG.MQTT_USER + "|" + CFG.MQTT_PREFIX + "|" + (CFG.MQTT_TLS ? "tls" : "tcp") + "|" +
         (CFG.MQTT_RPC ? "rpc" : "norpc") + "|" + JSON.stringify(h);
}

function mqttEnsure() {
  if (!CFG.MQTT_ENABLE || typeof MQTT === "undefined") { return; }
  if (!CFG.MQTT_HOST) {
    let mc = Shelly.getComponentConfig("mqtt");
    if (!mc || !mc.enable) {
      print("[pac] WARNING: MQTT_ENABLE is true but the Pill's MQTT is off - enable it in the web UI or set MQTT_HOST");
    } else if (mc.topic_prefix !== CFG.MQTT_PREFIX) {
      print("[pac] WARNING: the Pill's MQTT prefix is \"" + mc.topic_prefix + "\" but MQTT_PREFIX is \"" + CFG.MQTT_PREFIX +
            "\" - the availability topic <prefix>/online will not match");
    }
    return;
  }
  Shelly.call("Mqtt.GetConfig", {}, mqttCfgCb, null);
}

function mqttCfgCb(res, err, msg, ud) {
  if (err !== 0 || !res) { print("[pac] Mqtt.GetConfig failed: " + msg); return; }
  mqttCur = res;
  Shelly.call("KVS.Get", { key: MQTT_KVS_KEY }, mqttKvsCb, null);
}

function mqttKvsCb(res, err, msg, ud) {
  let applied = (err === 0 && res && typeof res.value === "string") ? res.value : "";
  let prev = applied, n = 0, hi = applied.indexOf("#");
  if (hi >= 0) { prev = applied.substr(0, hi); n = applied.substr(hi + 1) * 1; }
  let sig = mqttSig(), c = mqttCur;
  mqttCur = null;
  let same = c.enable === true && c.server === mqttServer() && (c.user || "") === CFG.MQTT_USER &&
             c.topic_prefix === CFG.MQTT_PREFIX && (c.ssl_ca || null) === (CFG.MQTT_TLS ? "ca.pem" : null) &&
             (c.enable_rpc === undefined || c.enable_rpc === CFG.MQTT_RPC) && prev === sig;
  if (same) {
    if (n !== 0) { Shelly.call("KVS.Set", { key: MQTT_KVS_KEY, value: sig + "#0" }, null, null); }
    print("[pac] MQTT broker " + mqttServer() + (CFG.MQTT_TLS ? " (TLS)" : "") + " as configured");
    return;
  }
  if (prev === sig && n >= 3) {
    print("[pac] ERROR: MQTT config did not persist after 3 attempts - check it in the web UI");
    return;
  }
  let attempt = (prev === sig) ? n + 1 : 1;
  print("[pac] Applying MQTT broker " + mqttServer() + (CFG.MQTT_TLS ? " TLS" : "") + " user=" + (CFG.MQTT_USER || "(none)") +
        " prefix=" + CFG.MQTT_PREFIX + " rpc=" + JSON.stringify(CFG.MQTT_RPC) + " (attempt " + JSON.stringify(attempt) + ")");
  Shelly.call("KVS.Set", { key: MQTT_KVS_KEY, value: sig + "#" + JSON.stringify(attempt) }, mqttKvsSetCb, null);
}

function mqttKvsSetCb(res, err, msg, ud) {
  if (err !== 0) { print("[pac] KVS.Set failed: " + msg + " - applying anyway"); }
  Shelly.call("Mqtt.SetConfig", { config: {
    enable: true,
    server: mqttServer(),
    user: CFG.MQTT_USER ? CFG.MQTT_USER : null,
    pass: CFG.MQTT_PASS ? CFG.MQTT_PASS : null,
    ssl_ca: CFG.MQTT_TLS ? "ca.pem" : null,
    topic_prefix: CFG.MQTT_PREFIX,
    enable_rpc: CFG.MQTT_RPC,
    rpc_ntf: CFG.MQTT_RPC,
    enable_control: CFG.MQTT_RPC,
    status_ntf: false
  } }, mqttSetCb, null);
}

function mqttSetCb(res, err, msg, ud) {
  if (err !== 0) { print("[pac] Mqtt.SetConfig failed: " + msg); return; }
  if (res && res.restart_required) {
    print("[pac] MQTT config applied - rebooting once to activate it");
    Timer.set(2000, false, mqttReboot, null);
  } else {
    print("[pac] MQTT config applied");
  }
}

function mqttReboot() { Shelly.call("Shelly.Reboot", {}, null, null); }

function vcStatusFallback(st, ud) {
  if (!st || !st.delta || st.delta.value === undefined) { return; }
  let ev = { source: "status", value: st.delta.value };
  let i = idx(vcKey, st.component);
  if (i === 0) { onVcPower(ev); }
  else if (i === 1) { onVcMode(ev); }
  else if (i === 2) { onVcFan(ev); }
  else if (i === 3) { onVcVane(ev); }
  else if (i === 4) { onVcWVane(ev); }
  else if (i === 5) { onVcTemp(ev); }
}

// Loop guard: our own setValue comes back as "script:N" or "sys" depending
// on the firmware -> also skip any value equal to the unit state.
function vcFromScript(ev) {
  return (ev && typeof ev.source === "string" && ev.source.indexOf("script") >= 0);
}

function vcCmd(o) { if (!applyCommand(o)) { vcSync(); } }   // rejected -> show the unit state again

function onVcPower(ev) {
  let p = ev.value ? "ON" : "OFF";
  if (vcFromScript(ev) || p === cur.power) { return; }
  vcCmd({ power: p });
}
function onVcMode(ev)  { if (!vcFromScript(ev) && ev.value !== cur.mode) { vcCmd({ mode: ev.value }); } }
function onVcFan(ev)   { if (!vcFromScript(ev) && ev.value !== cur.fan) { vcCmd({ fan: ev.value }); } }
function onVcVane(ev)  { if (!vcFromScript(ev) && ev.value !== cur.vane) { vcCmd({ vane: ev.value }); } }
function onVcWVane(ev) { if (!vcFromScript(ev) && ev.value !== cur.wideVane) { vcCmd({ wideVane: ev.value }); } }
function onVcTemp(ev)  { if (!vcFromScript(ev) && ev.value !== cur.temp) { vcCmd({ temp: ev.value }); } }

function vcSet(i, v) {
  if (!vcH[i] || v === null || v === undefined) { return; }
  if (vcH[i].getValue() === v) { return; }
  vcH[i].setValue(v);
}

function vcSync() {
  if (cur.power !== null) { vcSet(0, cur.power === "ON"); }
  vcSet(1, cur.mode);
  vcSet(2, cur.fan);
  vcSet(3, cur.vane);
  vcSet(4, cur.wideVane);
  if (cur.temp !== null && cur.temp >= CFG.MIN_TEMP && cur.temp <= CFG.MAX_TEMP) { vcSet(5, cur.temp); }
  if (cur.room !== null && cur.room >= 0 && cur.room <= 50) { vcSet(6, cur.room); }
  vcSet(7, link);
  if (vcH[VC_PW] && cur.powerW !== null && cur.powerW >= 0 && cur.powerW <= PW_MAX &&
      Math.abs(vcH[VC_PW].getValue() - cur.powerW) >= PW_DEADBAND) { vcH[VC_PW].setValue(cur.powerW); }
}

// ===================================================================
//  [runko] STARTUP - Serial -> UART -> diag -> VCs, one RPC at a time
// ===================================================================
let serialCfgOk = false;
let bootTries = 0;

function isJsUart(m) { return m === "jsuart" || m === "js_uart"; }

function startUart() {
  if (typeof UART === "undefined") {
    print("[pac] ERROR: UART API not available. Set the Pill peripheral mode to js_uart.");
    return;
  }
  try { uart = UART.get(CFG.UART_ID); } catch (e) { uart = null; }
  if (!uart) { try { uart = UART.get(); } catch (e2) { uart = null; } }
  if (!uart) { print("[pac] ERROR: UART.get() returned null. Is the Pill in js_uart mode?"); return; }
  let ok = false;
  try { ok = (uart.configure({ baud: CFG.BAUD, format: CFG.FORMAT }) !== false); } catch (e3) { ok = false; }
  if (!ok && serialCfgOk) { ok = true; }    // fw 2.0.1: the Serial component owns baud/format
  if (!ok) { print("[pac] ERROR: uart.configure failed"); return; }
  if (String.fromCharCode(0).length !== 1) {
    print("[pac] ERROR: zero bytes cannot be built on this firmware - aborting");
    return;
  }
  print("[pac] UART " + JSON.stringify(CFG.BAUD) + " " + CFG.FORMAT + ", READ_ONLY=" + JSON.stringify(CFG.READ_ONLY));
  uart.recv(onRx);
  if (typeof HTTPServer !== "undefined") { HTTPServer.registerEndpoint(CFG.HTTP_ENDPOINT, onHttp, null); }
  if (CFG.MQTT_ENABLE && typeof MQTT !== "undefined") {
    mqttSub(CFG.MQTT_PREFIX + "/set", onMqttSet);
  }
  if (CFG.DEBUG) { setDebug(true, true); }
  lastTxMs = upMs() - CFG.POLL_MS + 1000;   // first poll 1 s after start
  Timer.set(CFG.TICK_MS, true, tick, null);
  Timer.set(2000, false, startDiag, null);
}

function startDiag() {
  Shelly.call("Shelly.GetDeviceInfo", {}, diagInfoCb, null);
}

function diagInfoCb(res, err, msg, ud) {
  if (err === 0 && res) { print("[pac] fw=" + res.ver + " app=" + res.app); }
  Shelly.call("Pill.GetConfig", {}, diagPillCb, null);
}

function diagPillCb(res, err, msg, ud) {
  if (err === 0 && res) {
    print("[pac] Pill mode=" + JSON.stringify(res.mode));
    if (!isJsUart(res.mode)) { print("[pac] !!! Pill is NOT in js_uart mode - Pill.SetConfig {\"config\":{\"mode\":\"js_uart\"}} and reboot"); }
  }
  vcStart();
}

function bootRetry(why) {
  bootTries++;
  if (bootTries > 5) { print("[pac] ERROR: boot gave up: " + why); return; }
  print("[pac] boot retry " + JSON.stringify(bootTries) + ": " + why);
  Timer.set(2000, false, boot, null);
}

function serialSet(mode, alt) {
  print("[pac] Fixing Serial config -> " + mode + " " + JSON.stringify(CFG.BAUD) + " " + CFG.FORMAT);
  try {
    Shelly.call("Serial.SetConfig", { id: CFG.UART_ID, config: { mode: mode, serial: { baud: CFG.BAUD, format: CFG.FORMAT } } },
                serialSetCb, { mode: mode, alt: alt });
  } catch (e) { bootRetry("Serial.SetConfig"); }
}

function serialSetCb(res, err, msg, ud) {
  if (err !== 0) {
    if (!ud.alt) { serialSet(ud.mode === "js_uart" ? "jsuart" : "js_uart", true); return; }   // other spelling once
    print("[pac] Serial.SetConfig failed: " + msg);
    return;
  }
  if (res && res.restart_required) { print("[pac] Restart required: reboot the Pill and start the script again"); return; }
  serialCfgOk = true;
  startUart();
}

function serialGetCb(res, err, msg, ud) {
  if (err !== 0) {
    print("[pac] No Serial component (" + msg + ") - using the UART API directly");
    startUart();
    return;
  }
  if (isJsUart(res.mode) && res.serial && res.serial.baud === CFG.BAUD && res.serial.format === CFG.FORMAT) {
    serialCfgOk = true;
    startUart();
    return;
  }
  serialSet(isJsUart(res.mode) ? res.mode : "js_uart", false);
}

function boot() {
  if (startMs === 0) { startMs = upMs(); }
  try { Shelly.call("Serial.GetConfig", { id: CFG.UART_ID }, serialGetCb, null); }
  catch (e) { bootRetry("Serial.GetConfig"); }
}

boot();
