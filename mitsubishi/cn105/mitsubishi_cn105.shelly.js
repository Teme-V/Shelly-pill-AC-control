/**
 * @title Mitsubishi Electric CN105 heat pump control for the Shelly Pill
 * @description Controls a Mitsubishi Electric indoor unit through its CN105
 *   service port (2400 8E1, level shifter with its own 3.3 V LDO) from the
 *   Shelly app (virtual components), HTTP and optional MQTT / Home Assistant,
 *   with an optional BTHome room sensor and defrost state. Pill firmware 2.0.1+.
 * @status production
 * @link https://github.com/Teme-V/Shelly-pill-AC-control/tree/main/mitsubishi/cn105
 */
// Copyright 2026 Teemu Virta. SPDX-License-Identifier: Apache-2.0
// http://www.apache.org/licenses/LICENSE-2.0 - provided "AS IS", without warranties.
// Independent implementation; CN105 protocol information from SwiCago/HeatPump
// and echavet/MitsubishiCN105ESPHome (see NOTICE in the repository).
// Setup, wiring, MQTT and Home Assistant: README.md at the @link above.
// Edit only the CFG block. Pill peripheral mode: Serial Communication (js_uart).
// version 20261116-2

// ===================================================================
//  CONFIGURATION - the only block you need to edit
// ===================================================================
let CFG = {
  // -- Serial link to the heat pump ----------------------------------
  UART_ID: 0,
  BAUD: 2400,
  FORMAT: "8E1",             // CN105 = 2400 8E1, do not change

  TICK_MS: 200,              // state machine tick
  CYCLE_MS: 10000,           // pause after a full poll cycle
  RESP_TIMEOUT_MS: 2000,     // 22 bytes @2400 = ~101 ms/direction, 2 s is generous
  CONNECT_TIMEOUT_MS: 10000,
  MAX_FAILS: 5,              // consecutive timeouts -> reconnect

  POLL: [0x02, 0x03, 0x06, 0x09],  // settings, room temp, status, sub mode (defrost)

  REMOTE_TEMP_KEEPALIVE_MS: 20000,    // 0 = off. Kumo sends every 20 s
  REMOTE_TEMP_TIMEOUT_MS: 1800000,    // 0 = off. Fall back to internal sensor

  // Remote temperature from a BTHome sensor paired to the Pill (e.g. BLU H&T):
  //   "auto" = the only BTHome temperature sensor on the Pill
  //   number = that bthomesensor id (the boot log lists the candidates)
  //   -1     = off
  REMOTE_TEMP_BTHOME_ID: "auto",
  REMOTE_TEMP_BTHOME_MAX_AGE_S: 900,  // older readings are ignored

  MIN_TEMP: 16,
  MAX_TEMP: 31,

  INSTALLER_MODE: false,     // true -> CONNECT 0x5B (only if 0x5A is not enough)

  // -- MQTT (optional; needed for Home Assistant) ---------------------
  // MQTT_ENABLE false = no MQTT at all. MQTT_HOST set = the script writes the
  // broker into the Pill's MQTT settings and reboots once; "" = keep the web
  // UI MQTT settings (then set the web UI MQTT prefix = MQTT_PREFIX).
  MQTT_ENABLE: false,        // true = use MQTT (required for Home Assistant)
  MQTT_HOST: "",             // broker IP or hostname, e.g. "192.168.1.10" ("host:port" also works)
  MQTT_PORT: 1883,           // with MQTT_TLS: true the default 1883 becomes 8883
  MQTT_TLS: false,           // true = TLS, server checked with the Pill's built-in CA bundle (ca.pem)
  MQTT_USER: "",             // "" = anonymous
  MQTT_PASS: "",
  MQTT_RPC: true,            // false = no Shelly RPC, notifications or MQTT control over MQTT (test broker)
  MQTT_PREFIX: "mitsuac",    // topic prefix - must match the HA package YAML

  HTTP_ENDPOINT: "cn105",    // http://<pill-ip>/script/<id>/cn105

  // -- Home Assistant (needs MQTT_ENABLE: true) ----------------------
  // HA_DISCOVERY false = use the HA package from the repository (default);
  // true = the script announces the climate entity itself (no package).
  HA_DISCOVERY: false,
  HA_DISC_PREFIX: "homeassistant",
  HA_DISC_ID: "mitsuac",     // discovery node id + unique_id stem; KEEP STABLE
  HA_NAME: "MitsubishiAC",   // climate entity name in HA
  HA_DEVICE_NAME: "MitsubishiAC", // device name in HA's MQTT integration

  // -- Shelly app (virtual components) -------------------------------
  VC_GROUP_NAME: "MitsubishiAC",  // group shown as its own virtual device in the Shelly app
  VC_ECHO_TTL_MS: 15000,     // own VC writes: a change event this late is still an echo

  DEBUG: false,              // log every TX/RX frame; with MQTT also <prefix>/debug
  DEBUG_FLUSH_MS: 2000,      // <prefix>/debug: one message per this period
  DEBUG_AUTO_OFF_MIN: 1440   // DEBUG switches itself off after this (0 = never)
};
let POWER_B   = [0x00, 0x01];
let POWER_M   = ["OFF", "ON"];
let MODE_B    = [0x01,   0x02,  0x03,   0x07,  0x08];
let MODE_M    = ["HEAT", "DRY", "COOL", "FAN", "AUTO"];
let FAN_B     = [0x00,   0x01,     0x02, 0x03, 0x05, 0x06];
let FAN_M     = ["AUTO", "QUIET",  "1",  "2",  "3",  "4"];
let VANE_B    = [0x00,   0x01, 0x02, 0x03, 0x04, 0x05, 0x07];
let VANE_M    = ["AUTO", "1",  "2",  "3",  "4",  "5",  "SWING"];
let WVANE_B   = [0x01,  0x02, 0x03, 0x04, 0x05, 0x08, 0x0c];
let WVANE_M   = ["<<",  "<",  "|",  ">",  ">>", "<>", "SWING"];

let SUB_B     = [0x00,     0x01,     0x02,      0x04,      0x08,      0x10];
let SUB_M     = ["NORMAL", "WARMUP", "DEFROST", "PREHEAT", "STANDBY", "OFF"];
let STAGE_B   = [0x00,   0x01,  0x02,     0x03,     0x04,       0x05,   0x06];
let STAGE_M   = ["IDLE", "LOW", "GENTLE", "MEDIUM", "MODERATE", "HIGH", "DIFFUSE"];
let AUTOSUB_B = [0x00,       0x01,        0x02,        0x03,          0x40,            0x41,        0x43];
let AUTOSUB_M = ["AUTO_OFF", "AUTO_COOL", "AUTO_HEAT", "AUTO_LEADER", "AUTO_INACTIVE", "AUTO_IDLE", "AUTO_ACTIVE"];

let C1_POWER = 0x01, C1_MODE = 0x02, C1_TEMP = 0x04, C1_FAN = 0x08, C1_VANE = 0x10;
let C2_WVANE = 0x01;

let ST_BOOT = 0, ST_CONNECTING = 1, ST_IDLE = 2, ST_WAIT_RESP = 3, ST_WAIT_ACK = 4;

let uart = null;
let state = ST_BOOT;
let rxBuf = [];
let lastSendMs = 0;
let fails = 0;
let pollIdx = 0;
let nextCycleAt = 0;
let useTempEncB = false;
let gotFirstSettings = false;
let wvaneBit80 = false;

let cur = {
  connected: false,
  power: null, mode: null, temp: -1, fan: null, vane: null, wideVane: null,
  iSee: false,
  roomTemp: null, outsideTemp: null, runtimeHours: null,
  operating: false, compressorHz: null, inputPowerW: null, kWh: null,
  subMode: null, stage: null, autoSubMode: null
};

let want = { power: null, mode: null, temp: -1, fan: null, vane: null, wideVane: null, dirty: false };

let remoteTemp = 0;
let remoteTempPending = false;
let remoteTempSetAt = 0;
let remoteTempSentAt = 0;
let remoteTempSource = "internal";
let remoteTempSentVal = 0;

let _sfcOk = false;
try { _sfcOk = (String.fromCharCode(0).length === 1); } catch (e0) { _sfcOk = false; }
let _hasChr = false;
try { _hasChr = (chr(65) === "A" && chr(0).length === 1); } catch (e) { _hasChr = false; }

function C(n) {
  if (_sfcOk) { return String.fromCharCode(n & 0xFF); }
  if (_hasChr) { return chr(n & 0xFF); }
  return String.fromCharCode(n & 0xFF);
}

function B(s, i) {
  if (s.charCodeAt) { return s.charCodeAt(i) & 0xFF; }
  return s.at(i) & 0xFF;
}

function hex(n) {
  let h = "0123456789ABCDEF";
  return h.charAt((n >> 4) & 0x0F) + h.charAt(n & 0x0F);
}

function dbg(msg) { if (CFG.DEBUG) { print("[cn105] " + msg); } }

let DBG_MAX = 1024;
let dbgLines = [];
let dbgLen = 0;
let dbgDropped = 0;
let dbgOffAt = 0;
let dbgFlushAt = 0;
let linkPubAt = 0;
let startMs = 0;

function upMs() {
  if (typeof Shelly.getUptimeMs === "function") { return Shelly.getUptimeMs(); }
  return Date.now();
}

function mqttOk() {
  return CFG.MQTT_ENABLE && typeof MQTT !== "undefined" && MQTT.isConnected();
}

function mqttSub(topic, cb) {
  try {
    MQTT.subscribe(topic, cb, null);
  } catch (e) {
    print("[cn105] MQTT is off on the Pill - " + topic + " not subscribed yet");
  }
}

function dbgLine(code, h) {
  if (!CFG.MQTT_ENABLE) { return; }
  if (h.length > 0 && h.charAt(h.length - 1) === " ") { h = h.substr(0, h.length - 1); }
  let l = code + " " + h + " @" + JSON.stringify(upMs() - startMs);
  dbgLines.push(l);
  dbgLen += l.length + 1;
  while (dbgLen > DBG_MAX && dbgLines.length > 1) {
    dbgLen -= dbgLines[0].length + 1;
    dbgLines.splice(0, 1);
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

function setDebug(on) {
  CFG.DEBUG = on;
  dbgOffAt = (on && CFG.DEBUG_AUTO_OFF_MIN > 0) ? upMs() + CFG.DEBUG_AUTO_OFF_MIN * 60000 : 0;
  print("[cn105] Debug " + (on ? "on" : "off") + (dbgOffAt > 0 ?
        ", auto-off in " + JSON.stringify(CFG.DEBUG_AUTO_OFF_MIN) + " min" : ""));
}

function debugAutoOff() {
  dbgOffAt = 0;
  CFG.DEBUG = false;
  print("[cn105] Debug auto-off");
  publishMqttState();
}

function auxTick() {
  let now = upMs();
  if (dbgOffAt > 0 && now >= dbgOffAt) { debugAutoOff(); }
  if (now - dbgFlushAt >= CFG.DEBUG_FLUSH_MS) {
    dbgFlushAt = now;
    dbgFlush();
  }

  if (!cur.connected && now - linkPubAt >= CFG.CYCLE_MS) {
    linkPubAt = now;
    publishMqttState();
  }
}

function idxOfByte(arr, v) {
  for (let i = 0; i < arr.length; i++) { if (arr[i] === v) { return i; } }
  return -1;
}

function idxOfStr(arr, v) {
  for (let i = 0; i < arr.length; i++) { if (arr[i] === v) { return i; } }
  return -1;
}

function mapByte(bArr, mArr, v, fallback) {
  let i = idxOfByte(bArr, v);
  if (i < 0) { return fallback; }
  return mArr[i];
}

function frameOut(b) {
  let s = "";
  let sum = 0;
  for (let i = 0; i < b.length; i++) {
    let v = b[i] & 0xFF;
    sum += v;
    s += C(v);
  }
  s += C((0xFC - sum) & 0xFF);
  return s;
}

function newSetPacket(cmd) {
  let b = [0xFC, 0x41, 0x01, 0x30, 0x10, cmd];
  for (let i = 6; i <= 20; i++) { b.push(0x00); }
  return b;
}

function newInfoPacket(code) {
  let b = [0xFC, 0x42, 0x01, 0x30, 0x10, code];
  for (let i = 6; i <= 20; i++) { b.push(0x00); }
  return b;
}

function newConnectPacket() {
  return [0xFC, CFG.INSTALLER_MODE ? 0x5B : 0x5A, 0x01, 0x30, 0x02, 0xCA, 0x01];
}

function uartWrite(s) {
  if (uart === null) { return 0; }
  if (uart.send) { return uart.send(s); }
  return uart.write(s);
}

function sendFrame(b, newState) {
  let s = frameOut(b);
  if (s.length !== b.length + 1) {
    print("[cn105] ERROR: frame truncated to " + JSON.stringify(s.length) + "/" +
          JSON.stringify(b.length + 1) + " bytes (zero-byte problem)");
  }
  if (CFG.DEBUG) {
    let h = "";
    for (let i = 0; i < s.length; i++) { h += hex(B(s, i)) + " "; }
    dbg("TX " + h);
    dbgLine("T", h);
  }
  let n = uartWrite(s);
  if (typeof n === "number" && n !== s.length) {
    print("[cn105] WARNING: UART sent " + JSON.stringify(n) + "/" +
          JSON.stringify(s.length) + " bytes");
  }
  lastSendMs = Date.now();
  state = newState;
}

function resync() {
  while (rxBuf.length > 0 && rxBuf[0] !== 0xFC) { rxBuf.splice(0, 1); }
}

function parseRx() {
  resync();
  while (rxBuf.length >= 5) {
    let dlen = rxBuf[4];
    let total = dlen + 6;
    if (total > 64) {
      rxBuf.splice(0, 1);
      resync();
      continue;
    }
    if (rxBuf.length < total) { return; }

    let f = rxBuf.slice(0, total);
    rxBuf.splice(0, total);

    let sum = 0;
    for (let i = 0; i < total - 1; i++) { sum += f[i]; }
    if (((0xFC - sum) & 0xFF) === f[total - 1]) {
      handleFrame(f);
    } else {
      dbg("checksum FAIL, type 0x" + hex(f[1]));
    }
    resync();
  }
}

function handleFrame(f) {
  if (CFG.DEBUG) {
    let h = "";
    for (let i = 0; i < f.length; i++) { h += hex(f[i]) + " "; }
    dbg("RX " + h);
    dbgLine("R", h);
  }
  fails = 0;
  let t = f[1];

  if (t === 0x7A || t === 0x7B) {
    cur.connected = true;
    state = ST_IDLE;
    pollIdx = 0;
    nextCycleAt = 0;
    print("[cn105] Connected to heat pump (0x" + hex(t) + ")");
    return;
  }
  if (t === 0x61) {
    if (state === ST_WAIT_ACK) { state = ST_IDLE; }
    return;
  }
  if (t === 0x62) {
    handleInfo(f);
    return;
  }
  dbg("unknown packet type 0x" + hex(t));
}

function handleInfo(f) {
  let code = f[5];
  if (code === 0x02) { decodeSettings(f); }
  else if (code === 0x03) { decodeRoomTemp(f); }
  else if (code === 0x06) { decodeStatus(f); }
  else if (code === 0x09) { decodeStandby(f); }
  else { dbg("unhandled info code 0x" + hex(code)); }

  if (state === ST_WAIT_RESP) {
    pollIdx++;
    if (pollIdx >= CFG.POLL.length) {
      pollIdx = 0;
      nextCycleAt = Date.now() + CFG.CYCLE_MS;
      publishState();
    }
    state = ST_IDLE;
  }
}

function decodeSettings(f) {
  let d3 = f[8], d4 = f[9], d5 = f[10], d6 = f[11], d7 = f[12];
  let d10 = f[15], d11 = f[16];

  cur.power = mapByte(POWER_B, POWER_M, d3, cur.power);
  cur.iSee = (d4 > 0x08);
  let modeCode = cur.iSee ? (d4 - 0x08) : d4;
  cur.mode = mapByte(MODE_B, MODE_M, modeCode, cur.mode);

  if (d11 !== 0x00) {
    cur.temp = (d11 - 128) / 2;
    useTempEncB = true;
  } else {
    cur.temp = 31 - d5;
  }

  cur.fan = mapByte(FAN_B, FAN_M, d6, cur.fan);
  cur.vane = mapByte(VANE_B, VANE_M, d7, cur.vane);

  if (d10 !== 0) {
    cur.wideVane = mapByte(WVANE_B, WVANE_M, d10 & 0x0F, cur.wideVane);
    wvaneBit80 = ((d10 & 0xF0) === 0x80);
  }
  gotFirstSettings = true;
}

function decodeRoomTemp(f) {
  let d3 = f[8], d5 = f[10], d6 = f[11];
  let d11 = f[16], d12 = f[17], d13 = f[18];

  cur.outsideTemp = (d5 > 1) ? ((d5 - 128) / 2) : null;

  if (d6 !== 0x00) {
    cur.roomTemp = (d6 - 128) / 2;
  } else {
    cur.roomTemp = d3 + 10;
  }

  cur.runtimeHours = (((d11 << 16) | (d12 << 8) | d13) / 60);
}

function decodeStatus(f) {
  let d3 = f[8], d4 = f[9], d5 = f[10], d6 = f[11], d7 = f[12], d8 = f[13];
  cur.operating = (d4 !== 0);
  cur.compressorHz = cur.operating ? d3 : 0;
  cur.inputPowerW = ((d5 << 8) | d6);
  cur.kWh = ((d7 << 8) | d8) / 10;
}

function decodeStandby(f) {
  subModeMiss = 0;
  cur.subMode = mapByte(SUB_B, SUB_M, f[8], cur.subMode);
  cur.stage = mapByte(STAGE_B, STAGE_M, f[9], cur.stage);
  cur.autoSubMode = mapByte(AUTOSUB_B, AUTOSUB_M, f[10], cur.autoSubMode);
  dbg("sub mode 0x" + hex(f[8]) + " stage 0x" + hex(f[9]) + " auto 0x" + hex(f[10]));
}

let subModeMiss = 0;

function subModeTimeout() {
  subModeMiss++;
  if (subModeMiss < 3) { return; }
  let p = [];
  for (let i = 0; i < CFG.POLL.length; i++) {
    if (CFG.POLL[i] !== 0x09) { p.push(CFG.POLL[i]); }
  }
  CFG.POLL = p;
  pollIdx = 0;
  nextCycleAt = Date.now() + CFG.CYCLE_MS;
  print("[cn105] Unit does not answer 0x09 -> sub mode / defrost not available");
  publishState();
}

function sendSet() {
  let b = newSetPacket(0x01);
  let c1 = 0, c2 = 0;

  if (want.power !== null) {
    let i = idxOfStr(POWER_M, want.power);
    if (i >= 0) { b[8] = POWER_B[i]; c1 |= C1_POWER; }
  }
  if (want.mode !== null) {
    let i = idxOfStr(MODE_M, want.mode);
    if (i >= 0) { b[9] = MODE_B[i]; c1 |= C1_MODE; }
  }
  if (want.temp > 0) {
    let t = want.temp;
    if (t < CFG.MIN_TEMP) { t = CFG.MIN_TEMP; }
    if (t > CFG.MAX_TEMP) { t = CFG.MAX_TEMP; }
    if (useTempEncB) {
      b[19] = (Math.round(t * 2) + 128) & 0xFF;
    } else {
      b[10] = (31 - Math.round(t)) & 0x0F;
    }
    c1 |= C1_TEMP;
  }
  if (want.fan !== null) {
    let i = idxOfStr(FAN_M, want.fan);
    if (i >= 0) { b[11] = FAN_B[i]; c1 |= C1_FAN; }
  }
  if (want.vane !== null) {
    let i = idxOfStr(VANE_M, want.vane);
    if (i >= 0) { b[12] = VANE_B[i]; c1 |= C1_VANE; }
  }
  if (want.wideVane !== null) {
    let i = idxOfStr(WVANE_M, want.wideVane);
    if (i >= 0) { b[18] = WVANE_B[i] | (wvaneBit80 ? 0x80 : 0x00); c2 |= C2_WVANE; }
  }

  if (c1 === 0 && c2 === 0) { clearWant(); return; }

  b[6] = c1;
  b[7] = c2;
  sendFrame(b, ST_WAIT_ACK);
  clearWant();
  pollIdx = 0;
  nextCycleAt = 0;
}

function clearWant() {
  want.power = null; want.mode = null; want.temp = -1;
  want.fan = null; want.vane = null; want.wideVane = null;
  want.dirty = false;
}

function sendRemoteTemp() {
  let b = newSetPacket(0x07);
  if (remoteTemp > 0) {
    let r = Math.round(remoteTemp * 2);
    b[6] = 0x01;
    b[7] = (r - 16) & 0xFF;
    b[8] = (r + 128) & 0xFF;
  } else {
    b[6] = 0x00;
    b[8] = 0x80;
  }
  sendFrame(b, ST_WAIT_ACK);
  remoteTempSentAt = Date.now();
  remoteTempSentVal = remoteTemp;
  remoteTempPending = false;
}

function setRemoteTemp(v, src, ageS) {
  let ok = (v >= 1 && v <= 40);
  if (src === "bthome") {
    if (!ok) { return; }
    if (remoteTemp <= 0 || remoteTempSource !== "bthome" ||
        Math.abs(v - remoteTempSentVal) >= 0.5) { remoteTempPending = true; }
    remoteTemp = v;
    remoteTempSetAt = Date.now() - ageS * 1000;
  } else {
    remoteTemp = ok ? v : 0;
    remoteTempSetAt = Date.now();
    remoteTempPending = true;
  }
  remoteTempSource = src;
}

function remoteTempDue(now) {
  if (remoteTempPending) { return true; }
  if (remoteTemp <= 0) { return false; }
  if (CFG.REMOTE_TEMP_TIMEOUT_MS > 0 && (now - remoteTempSetAt) > CFG.REMOTE_TEMP_TIMEOUT_MS) {
    print("[cn105] Remote temperature expired -> internal sensor");
    remoteTemp = 0;
    remoteTempPending = true;
    return true;
  }
  if (CFG.REMOTE_TEMP_KEEPALIVE_MS <= 0) { return false; }
  return (now - remoteTempSentAt) >= CFG.REMOTE_TEMP_KEEPALIVE_MS;
}

function sendConnect() {
  cur.connected = false;
  gotFirstSettings = false;
  rxBuf = [];
  sendFrame(newConnectPacket(), ST_CONNECTING);
  dbg("CONNECT sent");
}

function tick() {
  parseRx();
  let now = Date.now();

  if (state === ST_BOOT) { return; }

  if (state === ST_CONNECTING) {
    if ((now - lastSendMs) > CFG.CONNECT_TIMEOUT_MS) {
      print("[cn105] No reply to CONNECT, retrying");
      sendConnect();
    }
    return;
  }

  if (state === ST_WAIT_RESP || state === ST_WAIT_ACK) {
    if ((now - lastSendMs) <= CFG.RESP_TIMEOUT_MS) { return; }
    fails++;
    dbg("timeout, fails=" + JSON.stringify(fails));
    if (state === ST_WAIT_RESP && CFG.POLL[pollIdx] === 0x09) { subModeTimeout(); }
    if (fails >= CFG.MAX_FAILS) {
      print("[cn105] Connection lost, reconnecting");
      fails = 0;
      sendConnect();
      return;
    }
    state = ST_IDLE;
  }

  if (want.dirty && gotFirstSettings) { sendSet(); return; }
  if (remoteTempDue(now)) { sendRemoteTemp(); return; }
  if (pollIdx > 0 || now >= nextCycleAt) {
    sendFrame(newInfoPacket(CFG.POLL[pollIdx]), ST_WAIT_RESP);
  }
}

function applyCommand(o) {
  let touched = false;

  if (o.debug === true || o.debug === false) {
    setDebug(o.debug);
    publishMqttState();
  }
  if (o.power !== undefined && idxOfStr(POWER_M, o.power) >= 0) { want.power = o.power; touched = true; }
  if (o.mode !== undefined && idxOfStr(MODE_M, o.mode) >= 0) { want.mode = o.mode; touched = true; }
  if (o.fan !== undefined && idxOfStr(FAN_M, o.fan) >= 0) { want.fan = o.fan; touched = true; }
  if (o.vane !== undefined && idxOfStr(VANE_M, o.vane) >= 0) { want.vane = o.vane; touched = true; }
  if (o.wideVane !== undefined && idxOfStr(WVANE_M, o.wideVane) >= 0) { want.wideVane = o.wideVane; touched = true; }
  if (o.temp !== undefined) {
    let t = o.temp * 1;
    if (t >= CFG.MIN_TEMP && t <= CFG.MAX_TEMP) { want.temp = t; touched = true; }
  }
  if (o.remote_temp !== undefined) { setRemoteTemp(o.remote_temp * 1, "manual", 0); }
  if (touched) { want.dirty = true; }
  return touched;
}

function stateJson() {
  return JSON.stringify({
    connected: cur.connected,
    power: cur.power, mode: cur.mode, temp: cur.temp,
    fan: cur.fan, vane: cur.vane, wideVane: cur.wideVane,
    iSee: cur.iSee,
    room_temp: cur.roomTemp, outside_temp: cur.outsideTemp,
    operating: cur.operating, compressor_hz: cur.compressorHz,
    input_power_w: cur.inputPowerW, energy_kwh: cur.kWh,
    runtime_hours: cur.runtimeHours,
    sub_mode: cur.subMode, stage: cur.stage, auto_sub_mode: cur.autoSubMode,
    defrost: cur.subMode === null ? null : cur.subMode === "DEFROST",
    remote_temp: remoteTemp,
    remote_temp_source: remoteTemp > 0 ? remoteTempSource : "internal",
    remote_temp_age_s: remoteTemp > 0 ? Math.round((Date.now() - remoteTempSetAt) / 1000) : null,
    debug: CFG.DEBUG
  });
}

function publishMqttState() {
  if (mqttOk()) { MQTT.publish(CFG.MQTT_PREFIX + "/state", stateJson(), 0, false); }
}

function publishState() {
  print("[cn105] " + stateJson());
  vcSync();
  if (CFG.MQTT_ENABLE && typeof MQTT !== "undefined" && MQTT.isConnected()) {
    MQTT.publish(CFG.MQTT_PREFIX + "/state", stateJson(), 0, false);
  }
}

let MQTT_KVS_KEY = "cn105_mqtt_applied";
let mqttCurCfg = null;

function mqttServer() {
  if (CFG.MQTT_HOST.indexOf(":") >= 0) { return CFG.MQTT_HOST; }
  let port = (CFG.MQTT_TLS && CFG.MQTT_PORT === 1883) ? 8883 : CFG.MQTT_PORT;
  return CFG.MQTT_HOST + ":" + JSON.stringify(port);
}

function mqttSig() {
  let h = 0;
  for (let i = 0; i < CFG.MQTT_PASS.length; i++) {
    h = ((h * 31) + CFG.MQTT_PASS.charCodeAt(i)) & 0xFFFFFF;
  }
  return mqttServer() + "|" + CFG.MQTT_USER + "|" + CFG.MQTT_PREFIX + "|" + JSON.stringify(h) +
         (CFG.MQTT_TLS ? "|tls" : "") + (CFG.MQTT_RPC ? "" : "|norpc");
}

function sigTail(s, f) {
  return s.length >= f.length && s.substr(s.length - f.length) === f;
}

function mqttEnsure() {
  if (!CFG.MQTT_ENABLE) {
    if (CFG.MQTT_HOST) { print("[cn105] NOTE: MQTT_HOST is set but MQTT_ENABLE is false - MQTT stays off"); }
    return;
  }
  if (!CFG.MQTT_HOST) { mqttPrefixCheck(); return; }
  Shelly.call("Mqtt.GetConfig", {}, mqttEnsureCb1, null);
}

function mqttEnsureCb1(res, err, msg, ud) {
  if (err !== 0) { print("[cn105] Mqtt.GetConfig failed: " + msg); return; }
  mqttCurCfg = res;
  Shelly.call("KVS.Get", { key: MQTT_KVS_KEY }, mqttEnsureCb2, null);
}

function mqttEnsureCb2(res, err, msg, ud) {
  let applied = (err === 0 && res && typeof res.value === "string") ? res.value : "";
  let prevSig = applied, cnt = 0;
  let hi = applied.indexOf("#");
  if (hi >= 0) { prevSig = applied.substr(0, hi); cnt = applied.substr(hi + 1) * 1; }

  let sig = mqttSig();
  let same = (mqttCurCfg.enable === true) &&
             (mqttCurCfg.server === mqttServer()) &&
             ((mqttCurCfg.user || "") === CFG.MQTT_USER) &&
             (mqttCurCfg.topic_prefix === CFG.MQTT_PREFIX) &&
             (!CFG.MQTT_TLS || mqttCurCfg.ssl_ca === "ca.pem") &&
             (CFG.MQTT_RPC || mqttCurCfg.enable_rpc === false) &&
             (prevSig === sig);
  if (same) {
    if (cnt !== 0) { Shelly.call("KVS.Set", { key: MQTT_KVS_KEY, value: sig + "#0" }, null, null); }
    mqttPrefixCheck();
    return;
  }
  if (prevSig === sig && cnt >= 3) {
    print("[cn105] ERROR: MQTT config did not persist after 3 attempts - configure MQTT in the web UI");
    return;
  }
  let attempt = (prevSig === sig) ? cnt + 1 : 1;
  print("[cn105] Applying MQTT broker " + mqttServer() + (CFG.MQTT_TLS ? " TLS" : "") +
        " user=" + (CFG.MQTT_USER || "(none)") + " prefix=" + CFG.MQTT_PREFIX +
        (CFG.MQTT_RPC ? "" : " rpc=false") + " (attempt " + JSON.stringify(attempt) + ")");
  Shelly.call("KVS.Set", { key: MQTT_KVS_KEY, value: sig + "#" + JSON.stringify(attempt) }, null, null);
  let c = {
    enable: true,
    server: mqttServer(),
    user: CFG.MQTT_USER ? CFG.MQTT_USER : null,
    pass: CFG.MQTT_PASS ? CFG.MQTT_PASS : null,
    topic_prefix: CFG.MQTT_PREFIX
  };

  let prevRpc = !sigTail(prevSig, "|norpc");
  let prevTls = sigTail(prevRpc ? prevSig : prevSig.substr(0, prevSig.length - 6), "|tls");
  if (CFG.MQTT_TLS) { c.ssl_ca = "ca.pem"; }
  else if (prevTls && mqttCurCfg.ssl_ca === "ca.pem") { c.ssl_ca = null; }
  if (!CFG.MQTT_RPC) {
    c.enable_rpc = false; c.rpc_ntf = false; c.enable_control = false; c.status_ntf = false;
  } else if (!prevRpc && mqttCurCfg.enable_rpc === false) {
    c.enable_rpc = true; c.rpc_ntf = true; c.enable_control = true;
  }
  Shelly.call("Mqtt.SetConfig", { config: c }, mqttEnsureCb3, null);
}

function mqttEnsureCb3(res, err, msg, ud) {
  if (err !== 0) { print("[cn105] Mqtt.SetConfig failed: " + msg); return; }
  if (res && res.restart_required) {
    print("[cn105] MQTT config applied - rebooting once to activate it");
    Timer.set(2000, false, function () { Shelly.call("Shelly.Reboot", {}, null, null); }, null);
  } else {
    mqttPrefixCheck();
  }
}

function mqttPrefixCheck() {
  Shelly.call("Mqtt.GetConfig", {}, function (res, err, msg, ud) {
    if (err !== 0 || !res) { return; }
    if (!res.enable) {
      print("[cn105] WARNING: device MQTT is disabled - set MQTT_HOST in CFG or enable it in the web UI");
      return;
    }
    if (res.topic_prefix !== CFG.MQTT_PREFIX) {
      print("[cn105] WARNING: Shelly MQTT prefix is \"" + res.topic_prefix + "\" but CFG.MQTT_PREFIX is \"" +
            CFG.MQTT_PREFIX + "\" - the HA package availability topic will not match. " +
            "Set the web UI MQTT prefix to \"" + CFG.MQTT_PREFIX + "\" (or set MQTT_HOST to let the script do it).");
    }
  }, null);
}

let haDiscPublished = false;

function haDiscoveryJson() {
  let st = CFG.MQTT_PREFIX + "/state";
  let cmd = CFG.MQTT_PREFIX + "/set";
  let d = {
    name: CFG.HA_NAME,
    unique_id: CFG.HA_DISC_ID + "_cn105_climate",
    icon: "mdi:air-conditioner",
    device: {
      identifiers: [CFG.HA_DISC_ID + "-cn105-pill"],
      name: CFG.HA_DEVICE_NAME,
      manufacturer: "Mitsubishi Electric",
      model: "CN105 via Shelly Pill"
    },
    min_temp: CFG.MIN_TEMP,
    max_temp: CFG.MAX_TEMP,
    temp_step: 0.5,
    precision: 0.5,
    modes: ["off", "heat", "dry", "cool", "fan_only", "auto"],
    fan_modes: ["auto", "quiet", "1", "2", "3", "4"],
    swing_modes: ["auto", "1", "2", "3", "4", "5", "swing"],
    mode_command_topic: cmd,
    mode_command_template: "{% if value == 'off' %}{\"power\":\"OFF\"}{% else %}{\"power\":\"ON\",\"mode\":\"{{ {'heat':'HEAT','dry':'DRY','cool':'COOL','fan_only':'FAN','auto':'AUTO'}.get(value,'AUTO') }}\"}{% endif %}",
    temperature_command_topic: cmd,
    temperature_command_template: "{\"temp\": {{ value }}}",
    fan_mode_command_topic: cmd,
    fan_mode_command_template: "{\"fan\": \"{{ value | upper }}\"}",
    swing_mode_command_topic: cmd,
    swing_mode_command_template: "{\"vane\": \"{{ value | upper }}\"}",
    mode_state_topic: st,
    mode_state_template: "{% if value_json.power == 'OFF' %}off{% else %}{{ {'HEAT':'heat','DRY':'dry','COOL':'cool','FAN':'fan_only','AUTO':'auto'}.get(value_json.mode,'off') }}{% endif %}",
    temperature_state_topic: st,
    temperature_state_template: "{{ value_json.temp }}",
    current_temperature_topic: st,
    current_temperature_template: "{{ value_json.room_temp }}",
    fan_mode_state_topic: st,
    fan_mode_state_template: "{{ value_json.fan | lower }}",
    swing_mode_state_topic: st,
    swing_mode_state_template: "{{ value_json.vane | lower }}",
    action_topic: st,
    action_template: "{% if value_json.power == 'OFF' %}off{% elif value_json.defrost and value_json.mode in ['HEAT','AUTO'] %}defrosting{% elif not value_json.operating %}idle{% else %}{{ {'HEAT':'heating','COOL':'cooling','DRY':'drying','FAN':'fan','AUTO':'idle'}.get(value_json.mode,'idle') }}{% endif %}"
  };

  try {
    let mc = Shelly.getComponentConfig("mqtt");
    if (mc && mc.topic_prefix) {
      d.availability_topic = mc.topic_prefix + "/online";
      d.payload_available = "true";
      d.payload_not_available = "false";
    }
  } catch (eMc) { }

  try {
    let ws = Shelly.getComponentStatus("wifi");
    if (ws && ws.sta_ip) { d.device.configuration_url = "http://" + ws.sta_ip + "/"; }
  } catch (eWs) { }
  return JSON.stringify(d);
}

function haDiscoveryPublish() {
  if (!CFG.MQTT_ENABLE || !CFG.HA_DISCOVERY || typeof MQTT === "undefined" || !MQTT.isConnected()) { return; }
  MQTT.publish(CFG.HA_DISC_PREFIX + "/climate/" + CFG.HA_DISC_ID + "/config",
               haDiscoveryJson(), 0, true);
  haDiscPublished = true;
  print("[cn105] HA discovery published (retained)");
}

function haStatusCb(topic, msg) {
  if (msg === "online") { haDiscoveryPublish(); }
}

function haDiscoveryInit() {
  if (!CFG.MQTT_ENABLE || !CFG.HA_DISCOVERY || typeof MQTT === "undefined") { return; }
  mqttSub(CFG.HA_DISC_PREFIX + "/status", haStatusCb);
  Timer.set(10000, true, function () {
    if (!haDiscPublished) { haDiscoveryPublish(); }
  }, null);
  haDiscoveryPublish();
}

let VC_GROUP_ID = 206;

let VC_DEFS = [
  { ns: "Boolean", type: "boolean", id: 200, cfg: { name: "Power", meta: { ui: { view: "toggle" } } } },
  { ns: "Enum",    type: "enum",    id: 201, cfg: { name: "Mode",  options: MODE_M,  meta: { ui: { view: "dropdown" } } } },
  { ns: "Enum",    type: "enum",    id: 202, cfg: { name: "Fan",   options: FAN_M,   meta: { ui: { view: "dropdown" } } } },
  { ns: "Enum",    type: "enum",    id: 203, cfg: { name: "Vane",  options: VANE_M,  meta: { ui: { view: "dropdown" } } } },
  { ns: "Enum",    type: "enum",    id: 204, cfg: { name: "WVane", options: WVANE_M, meta: { ui: { view: "dropdown" } } } },
  { ns: "Number",  type: "number",  id: 205, cfg: { name: "Target temperature",
                     min: CFG.MIN_TEMP, max: CFG.MAX_TEMP,

                     default_value: Math.round((CFG.MIN_TEMP + CFG.MAX_TEMP) / 2),
                     meta: { ui: { view: "slider", unit: "°C", step: 0.5 } } } },
  { ns: "Number",  type: "number",  id: 207, cfg: { name: "Room temperature", min: 0, max: 50,
                     default_value: 20,
                     meta: { ui: { view: "label", unit: "°C", step: 0.5 } } } },
  { ns: "Group",   type: "group",   id: 206, cfg: { name: CFG.VC_GROUP_NAME } }
];

let vcH = { power: null, mode: null, fan: null, vane: null, wvane: null, temp: null, room: null };

let vcEcho = [[], [], [], [], [], []];
let vcIdx = 0;

function ensureVcs() {
  if (typeof Virtual === "undefined") {
    print("[cn105] Virtual API not available - app control disabled");
    afterVcs();
    return;
  }
  vcIdx = 0;
  vcEnsureNext();
}

function vcEnsureNext() {
  if (vcIdx >= VC_DEFS.length) { vcFinish(); return; }
  Shelly.call(VC_DEFS[vcIdx].ns + ".GetConfig", { id: VC_DEFS[vcIdx].id }, vcEnsureCb, null);
}

function vcEnsureCb(res, err, msg, ud) {
  let d = VC_DEFS[vcIdx];
  if (err === 0) {
    Shelly.call(d.ns + ".SetConfig", { id: d.id, config: vcCfgFor(d, res) }, vcAdvanceCb, null);
    return;
  }
  Shelly.call("Virtual.Add", { type: d.type, id: d.id, config: d.cfg }, vcAddCb, null);
}

function vcCfgFor(d, res) {
  let c = d.cfg;
  let old = (res && res.meta) ? res.meta : null;
  if (!c.meta || !old) { return c; }
  if (!old.ui) { old.ui = {}; }
  if (old.ui.view === undefined) { old.ui.view = c.meta.ui.view; }
  if (c.meta.ui.unit !== undefined && old.ui.unit === undefined) { old.ui.unit = c.meta.ui.unit; }
  if (c.meta.ui.step !== undefined && old.ui.step === undefined) { old.ui.step = c.meta.ui.step; }
  c.meta = old;
  return c;
}

function vcAdvanceCb(res, err, msg, ud) {
  vcIdx++;
  vcEnsureNext();
}

function vcAddCb(res, err, msg, ud) {
  if (err !== 0) {
    print("[cn105] VC creation failed (" + VC_DEFS[vcIdx].type + ":" +
          JSON.stringify(VC_DEFS[vcIdx].id) + "): " + msg);
  }
  vcIdx++;
  vcEnsureNext();
}

function vcFinish() {
  Shelly.call("Group.Set", { id: VC_GROUP_ID, value: [
    "boolean:200", "enum:201", "enum:202", "enum:203", "enum:204", "number:205", "number:207"
  ] }, null, null);
  vcBind();
  afterVcs();
}

function vcBind() {
  vcH.power = Virtual.getHandle("boolean:200");
  vcH.mode  = Virtual.getHandle("enum:201");
  vcH.fan   = Virtual.getHandle("enum:202");
  vcH.vane  = Virtual.getHandle("enum:203");
  vcH.wvane = Virtual.getHandle("enum:204");
  vcH.temp  = Virtual.getHandle("number:205");
  vcH.room  = Virtual.getHandle("number:207");
  let ok = true;
  try {
    if (vcH.power) { vcH.power.on("change", onVcPower); }
    if (vcH.mode)  { vcH.mode.on("change", onVcMode); }
    if (vcH.fan)   { vcH.fan.on("change", onVcFan); }
    if (vcH.vane)  { vcH.vane.on("change", onVcVane); }
    if (vcH.wvane) { vcH.wvane.on("change", onVcWVane); }
    if (vcH.temp)  { vcH.temp.on("change", onVcTemp); }
  } catch (eOn) { ok = false; }
  if (!ok) {
    Shelly.addStatusHandler(vcStatusFallback, null);
    print("[cn105] VC on(change) not supported - falling back to status handler");
  }
  print("[cn105] Virtual components ready (group " + CFG.VC_GROUP_NAME + ")");
  vcSync();
}

function vcStatusFallback(st, ud) {
  if (!st || !st.delta || st.delta.value === undefined) { return; }
  let ev = { source: "status", value: st.delta.value };
  if (st.component === "boolean:200") { onVcPower(ev); }
  else if (st.component === "enum:201") { onVcMode(ev); }
  else if (st.component === "enum:202") { onVcFan(ev); }
  else if (st.component === "enum:203") { onVcVane(ev); }
  else if (st.component === "enum:204") { onVcWVane(ev); }
  else if (st.component === "number:205") { onVcTemp(ev); }
}

function vcFromScript(ev) {
  return (ev && typeof ev.source === "string" && ev.source.indexOf("script") >= 0);
}

function vcSkip(ev, k, curVal) {
  let q = vcEcho[k];
  let now = upMs();
  let i = 0;
  while (i < q.length) {
    if (now - q[i + 1] > CFG.VC_ECHO_TTL_MS) { q.splice(i, 2); }
    else if (q[i] === ev.value) { q.splice(i, 2); return true; }
    else { i += 2; }
  }
  return vcFromScript(ev) || ev.value === curVal;
}

function onVcPower(ev) {
  if (vcSkip(ev, 0, cur.power === null ? null : cur.power === "ON")) { return; }
  applyCommand({ power: ev.value ? "ON" : "OFF" });
}
function onVcMode(ev) {
  if (vcSkip(ev, 1, cur.mode)) { return; }
  applyCommand({ mode: ev.value });
}
function onVcFan(ev) {
  if (vcSkip(ev, 2, cur.fan)) { return; }
  applyCommand({ fan: ev.value });
}
function onVcVane(ev) {
  if (vcSkip(ev, 3, cur.vane)) { return; }
  applyCommand({ vane: ev.value });
}
function onVcWVane(ev) {
  if (vcSkip(ev, 4, cur.wideVane)) { return; }
  applyCommand({ wideVane: ev.value });
}
function onVcTemp(ev) {
  if (vcSkip(ev, 5, cur.temp)) { return; }
  applyCommand({ temp: ev.value });
}

function vcSet(h, v, k) {
  if (!h || v === null || v === undefined) { return; }
  if (h.getValue() === v) { return; }
  if (k >= 0) {
    if (vcEcho[k].length >= 4) { vcEcho[k].splice(0, 2); }
    vcEcho[k].push(v);
    vcEcho[k].push(upMs());
  }
  h.setValue(v);
}

function vcSync() {
  if (cur.power !== null) { vcSet(vcH.power, cur.power === "ON", 0); }
  vcSet(vcH.mode, cur.mode, 1);
  vcSet(vcH.fan, cur.fan, 2);
  vcSet(vcH.vane, cur.vane, 3);
  vcSet(vcH.wvane, cur.wideVane, 4);
  if (cur.temp > 0) { vcSet(vcH.temp, cur.temp, 5); }
  vcSet(vcH.room, cur.roomTemp);
}

let bthomeId = -1;
let bthomeKey = "";
let bthomeLastTs = -1;
let bthomeScanN = 0;

function bthomeFind(verbose) {
  let first = -1, n = 0;
  for (let id = 200; id < 300; id++) {
    let c = null;
    try { c = Shelly.getComponentConfig("bthomesensor", id); } catch (e) { c = null; }
    if (c && (c.obj_id === 69 || c.obj_id === 2)) {
      if (verbose) {
        let s = Shelly.getComponentStatus("bthomesensor", id);
        print("[cn105] BTHome temperature sensor: id=" + JSON.stringify(id) + " addr=" + c.addr +
              (c.name ? " name=" + c.name : "") + " value=" + JSON.stringify(s ? s.value : null));
      }
      if (first < 0) { first = id; }
      n++;
    }
  }
  if (CFG.REMOTE_TEMP_BTHOME_ID !== "auto") { return CFG.REMOTE_TEMP_BTHOME_ID * 1; }
  if (n === 1) { return first; }
  if (verbose) {
    print("[cn105] BTHome remote temp: " + (n === 0 ? "no temperature sensor paired" :
          "several sensors -> set CFG.REMOTE_TEMP_BTHOME_ID to one of the ids above") +
          " -> pump's own sensor, searching again every minute");
  }
  return -1;
}

function bthomeUse(id) {
  if (id < 0) { return; }
  bthomeId = id;
  bthomeKey = "bthomesensor:" + JSON.stringify(id);
  bthomeLastTs = -1;
  let st = Shelly.getComponentStatus("bthomesensor", id);
  if (st) {
    print("[cn105] BTHome remote temp: id=" + JSON.stringify(id) +
          ", value=" + JSON.stringify(st.value) + ", age=" + JSON.stringify(bthomeAge(st)) + "s");
  } else {
    print("[cn105] BTHome remote temp: " + bthomeKey + " not found -> pump's own sensor");
  }
  bthomeCheck(false);
}

function bthomeAge(st) {
  let ts = (st.last_updated_ts !== undefined) ? st.last_updated_ts : st.last_update_ts;
  let sys = Shelly.getComponentStatus("sys");
  if (ts === undefined || ts === null || !sys || !sys.unixtime) { return -1; }
  return Math.max(0, Math.round(sys.unixtime - ts));
}

function bthomeCheck(fresh) {
  let st = Shelly.getComponentStatus("bthomesensor", bthomeId);
  if (!st) { return; }
  let ts = (st.last_updated_ts !== undefined) ? st.last_updated_ts : st.last_update_ts;
  if (ts === undefined || ts === null || ts === bthomeLastTs) { return; }
  let age = bthomeAge(st);
  if (age < 0 && fresh) { age = 0; }
  if (age < 0) { return; }
  bthomeLastTs = ts;
  if (age > CFG.REMOTE_TEMP_BTHOME_MAX_AGE_S) {
    print("[cn105] BTHome reading is " + JSON.stringify(age) + " s old -> ignored");
    return;
  }
  setRemoteTemp(st.value * 1, "bthome", age);
}

function bthomeStatusCb(st, ud) {
  if (st && st.component === bthomeKey && st.delta) { bthomeCheck(true); }
}

function bthomeTick(ud) {
  if (bthomeId >= 0 && Shelly.getComponentConfig("bthomesensor", bthomeId) === null) {
    if (remoteTemp > 0 && remoteTempSource === "bthome") {
      print("[cn105] BTHome sensor " + bthomeKey + " removed -> pump's own sensor");
      remoteTemp = 0;
      remoteTempPending = true;
    }
    if (CFG.REMOTE_TEMP_BTHOME_ID === "auto") { bthomeId = -1; bthomeKey = ""; }
  }
  if (bthomeId >= 0) { bthomeCheck(false); return; }
  if (CFG.REMOTE_TEMP_BTHOME_ID === "auto" && ++bthomeScanN >= 3) {
    bthomeScanN = 0;
    bthomeUse(bthomeFind(false));
  }
}

function bthomeInit() {
  if (CFG.REMOTE_TEMP_BTHOME_ID === -1) { return; }
  bthomeUse(bthomeFind(true));

  if (remoteTemp <= 0) { remoteTempPending = true; }
  Shelly.addStatusHandler(bthomeStatusCb, null);
  Timer.set(20000, true, bthomeTick, null);
}

function startUart() {
  if (typeof UART === "undefined") {
    print("[cn105] ERROR: UART API not available. Set the Pill peripheral mode to js_uart (Pill.SetConfig).");
    return;
  }
  try { uart = UART.get(CFG.UART_ID); } catch (e) { uart = null; }
  if (!uart) { try { uart = UART.get(); } catch (e2) { uart = null; } }
  if (!uart) {
    print("[cn105] ERROR: UART.get() returned null. Is the Pill in UART mode?");
    return;
  }

  let ok = false;
  try { ok = (uart.configure({ baud: CFG.BAUD, mode: CFG.FORMAT, format: CFG.FORMAT }) !== false); } catch (e3) { ok = false; }
  if (!ok) {
    try { ok = (uart.configure({ baud: CFG.BAUD, mode: CFG.FORMAT }) !== false); } catch (e4) { ok = false; }
  }
  if (!ok) {
    try { ok = (uart.configure({ baud: CFG.BAUD, format: CFG.FORMAT }) !== false); } catch (e5) { ok = false; }
  }
  if (!ok && serialCfgOk) {
    print("[cn105] uart.configure unavailable; Serial component is " +
          JSON.stringify(CFG.BAUD) + " " + CFG.FORMAT + " -> continuing");
    ok = true;
  }
  if (!ok) {
    print("[cn105] ERROR: uart.configure failed (baud=" + JSON.stringify(CFG.BAUD) + " " + CFG.FORMAT + ")");
    return;
  }
  if (C(0).length !== 1) {
    print("[cn105] ERROR: zero-byte string building is broken - packets would be truncated. Aborting.");
    return;
  }
  print("[cn105] UART " + JSON.stringify(CFG.BAUD) + " " + CFG.FORMAT);

  uart.recv(function (data) {
    if (CFG.DEBUG && data.length > 0) {
      let h = "";
      for (let j = 0; j < data.length; j++) { h += hex(B(data, j)) + " "; }
      print("[cn105] raw RX (" + JSON.stringify(data.length) + "): " + h);

      if (!cur.connected) { dbgLine("X", h); }
    }
    for (let i = 0; i < data.length; i++) {
      if (rxBuf.length > 256) { rxBuf = []; break; }
      rxBuf.push(B(data, i));
    }
  });

  if (typeof HTTPServer !== "undefined") {
    HTTPServer.registerEndpoint(CFG.HTTP_ENDPOINT, function (req, res) {
      if (req.body && req.body.length > 1) {
        let ok2 = false;
        try { ok2 = applyCommand(JSON.parse(req.body)); } catch (e5) { ok2 = false; }
      }
      res.code = 200;
      res.headers = [["Content-Type", "application/json"]];
      res.body = stateJson();
      res.send();
    });
  }

  if (CFG.MQTT_ENABLE && typeof MQTT !== "undefined") {
    mqttSub(CFG.MQTT_PREFIX + "/set", function (topic, msg) {
      try { applyCommand(JSON.parse(msg)); } catch (e6) { print("[cn105] MQTT parse fail"); }
    });
  }

  startMs = upMs();
  linkPubAt = startMs;
  if (CFG.DEBUG) { setDebug(true); }
  Timer.set(CFG.TICK_MS, true, function () { tick(); auxTick(); }, null);
  sendConnect();
}

function startDiag() {
  Shelly.call("Shelly.GetDeviceInfo", {}, function (res, err, msg, ud) {
    if (err === 0 && res) {
      print("[cn105] fw=" + res.ver + " app=" + res.app);
    }
  }, null);
  Shelly.call("Pill.GetConfig", {}, function (res, err, msg, ud) {
    if (err !== 0) {
      print("[cn105] Pill.GetConfig not available (" + msg + ")");
      return;
    }
    print("[cn105] Pill mode=" + JSON.stringify(res.mode) +
          " pin0=" + JSON.stringify(res.pin0_mode) +
          " pin1=" + JSON.stringify(res.pin1_mode) +
          " pin2=" + JSON.stringify(res.pin2_mode));
    if (!isJsUart(res.mode)) {
      print("[cn105] !!! Pill is NOT in js_uart mode - run Pill.SetConfig {\"config\":{\"mode\":\"js_uart\"}} and reboot.");
    }

  }, null);
}

function isJsUart(m) { return m === "jsuart" || m === "js_uart"; }

let serialCfgOk = false;
let bootTries = 0;

function startAux() {
  startDiag();
  bthomeInit();
  Timer.set(1500, false, function () { ensureVcs(); haDiscoveryInit(); }, null);
}

function afterVcs() {
  Timer.set(1000, false, function () { mqttEnsure(); }, null);
}

function bootRetry(why) {
  bootTries++;
  if (bootTries > 5) { print("[cn105] ERROR: boot gave up: " + why); return; }
  print("[cn105] boot retry " + JSON.stringify(bootTries) + ": " + why);
  Timer.set(2000, false, function () { boot(); }, null);
}

function serialSetCb(res2, err2, msg2, ud2) {
  if (err2 !== 0) {
    if (ud2 && ud2.mode === "js_uart" && !ud2.alt) { serialSet("jsuart", true); return; }
    if (ud2 && ud2.mode === "jsuart" && !ud2.alt) { serialSet("js_uart", true); return; }
    print("[cn105] Serial.SetConfig failed: " + msg2);
    return;
  }
  if (res2 && res2.restart_required) {
    print("[cn105] Restart required. Run Sys.Reboot and start the script again.");
    return;
  }
  serialCfgOk = true;
  startUart();
  Timer.set(2000, false, function () { startAux(); }, null);
}

function serialSet(mode, alt) {
  print("[cn105] Fixing Serial config -> " + mode + " " + JSON.stringify(CFG.BAUD) + " " + CFG.FORMAT);
  try {
    Shelly.call("Serial.SetConfig", {
      id: CFG.UART_ID,
      config: { mode: mode, serial: { baud: CFG.BAUD, format: CFG.FORMAT } }
    }, serialSetCb, { mode: mode, alt: alt });
  } catch (e) {
    bootRetry("Serial.SetConfig: " + JSON.stringify(e));
  }
}

function serialGetCb(res, err, msg, ud) {
  if (err !== 0) {
    print("[cn105] No Serial component on this firmware (" + msg + ") - using the direct UART API");
    startUart();
    Timer.set(2000, false, function () { startAux(); }, null);
    return;
  }
  let needsFix = !isJsUart(res.mode) ||
                 (res.serial && (res.serial.baud !== CFG.BAUD || res.serial.format !== CFG.FORMAT));
  if (!needsFix) {
    serialCfgOk = true;
    startUart();
    Timer.set(2000, false, function () { startAux(); }, null);
    return;
  }

  serialSet(isJsUart(res.mode) ? res.mode : "js_uart", false);
}

function boot() {
  try {
    Shelly.call("Serial.GetConfig", { id: CFG.UART_ID }, serialGetCb, null);
  } catch (e) {
    bootRetry("Serial.GetConfig: " + JSON.stringify(e));
  }
}

boot();
