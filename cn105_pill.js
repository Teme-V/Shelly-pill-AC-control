/**
 * cn105_pill.js — Mitsubishi Electric CN105 control on the Shelly Pill 
 * ---------------------------------------------------------------------------
 * Edit ONLY the CFG block below, paste the whole file into a Shelly script
 * (Web UI -> Scripts -> Add script) and enable "Run on startup".
 * See README.md for wiring, MQTT and Home Assistant.
 *
 * Ported from the ESPHome implementation echavet/MitsubishiCN105ESPHome
 * (original reverse engineering: SwiCago/HeatPump).
 *
 * Requirements before running:
 *   1) The Pill runs firmware 2.0.1 or later.
 *   2) The Pill peripheral mode is js_uart:
 *        Pill.SetConfig {"config":{"mode":"js_uart"}}
 *      The script sets the serial port to 2400 8E1 itself on every start.
 *   3) Only ONE script may use the UART at a time.
 *
 * Pill firmware 2.0.1 notes:
 *   - the Serial mode is reported as "js_uart" (docs example: "jsuart")
 *     -> both names are accepted; the firmware's own name is kept.
 *   - a firmware update resets serial:0 to 115200 8N1 -> the script restores
 *     2400 8E1 at boot (Serial.SetConfig, applied without a reboot).
 *   - a script may have at most 5 Shelly.call()s in flight; the 6th THROWS
 *     "Too many calls in progress" and kills the script -> boot RPCs are
 *     serialized: UART first, then diagnostics, virtual components and
 *     finally the MQTT broker settings.
 *
 * Wiring with a 2-channel MH level shifter (CN105 = 5 V TTL, Pill = 3.3 V):
 *   CN105 pin3 5V  -> shifter 5V     (HV reference; 662K LDO produces 3V3)
 *   CN105 pin2 GND -> shifter GND (both sides) -> Pill GND
 *   CN105 pin4 TX  -> shifter HV1 ... LV1 -> Pill IO2 (RX)
 *   CN105 pin5 RX  <- shifter HV2 ... LV2 <- Pill IO1 (TX)
 *   Shifter 3V3 pin: leave unconnected if the module has its own LDO (662K).
 *   CN105 pin1 12V: power supply only via a buck converter, NEVER to signals.
 *
 * Espruino restrictions honored in this script:
 *   - no closures  -> all state kept in globals
 *   - no setTimeout -> Timer.set()
 *   - no forEach/map/filter -> for loops
 * 
 * version 20260930
 */

// ═══════════════════════════════════════════════════════════════════
//  CONFIGURATION — the only block you need to edit
// ═══════════════════════════════════════════════════════════════════
let CFG = {
  // ── Serial link to the heat pump ──────────────────────────────────
  UART_ID: 0,
  BAUD: 2400,
  FORMAT: "8E1",             // CN105 = 2400 8E1, do not change

  TICK_MS: 200,              // state machine tick
  CYCLE_MS: 10000,           // pause after a full poll cycle
  RESP_TIMEOUT_MS: 2000,     // 22 bytes @2400 = ~101 ms/direction, 2 s is generous
  CONNECT_TIMEOUT_MS: 10000,
  MAX_FAILS: 5,              // consecutive timeouts -> reconnect

  POLL: [0x02, 0x03, 0x06],  // settings, room temp, status. Add 0x09 if needed

  REMOTE_TEMP_KEEPALIVE_MS: 20000,    // 0 = off. Kumo sends every 20 s
  REMOTE_TEMP_TIMEOUT_MS: 1800000,    // 0 = off. Fall back to internal sensor

  MIN_TEMP: 16,
  MAX_TEMP: 31,

  INSTALLER_MODE: false,     // true -> CONNECT 0x5B (only if 0x5A is not enough)

  // ── MQTT broker ───────────────────────────────────────────────────
  // If MQTT_HOST is non-empty the script writes these into the Pill's own
  // MQTT settings (Mqtt.SetConfig) on boot and reboots ONCE to apply them.
  // Leave MQTT_HOST "" to keep whatever you configured in the Shelly web UI
  // (then set the web UI "MQTT prefix" to the same value as MQTT_PREFIX so
  // the Home Assistant package finds the availability topic <prefix>/online).
  MQTT_HOST: "",             // broker IP or hostname, e.g. "192.168.1.10"
  MQTT_PORT: 1883,
  MQTT_USER: "",             // "" = anonymous
  MQTT_PASS: "",
  MQTT_ENABLE: true,         // publish <prefix>/state, subscribe <prefix>/set
  MQTT_PREFIX: "mitsuac",    // topic prefix — must match the HA package YAML

  HTTP_ENDPOINT: "cn105",    // http://<pill-ip>/script/<id>/cn105

  // ── Home Assistant ────────────────────────────────────────────────
  // Option A (default): use homeassistant/packages/mitsubishi_ac.yaml from
  //   the kit — it defines the climate entity AND extra sensors. Keep
  //   HA_DISCOVERY false so the same climate is not announced twice.
  // Option B: set HA_DISCOVERY true and skip the package — the script then
  //   announces the climate entity itself via MQTT discovery (retained,
  //   re-published whenever HA sends its birth message).
  HA_DISCOVERY: false,
  HA_DISC_PREFIX: "homeassistant",
  HA_DISC_ID: "mitsuac",     // discovery node id + unique_id stem; KEEP STABLE
  HA_NAME: "MitsubishiAC",   // climate entity name in HA
  HA_DEVICE_NAME: "MitsubishiAC", // device name in HA's MQTT integration

  // ── Shelly app (virtual components) ───────────────────────────────
  VC_GROUP_NAME: "MitsubishiAC",  // group shown as its own virtual device in the Shelly app

  DEBUG: false
};

// ═══════════════════════════════════════════════════════════════════
//  PROTOCOL MAPS (cn105_types.h)
// ═══════════════════════════════════════════════════════════════════
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

// Control byte bits (CONTROL_PACKET_1 / _2)
let C1_POWER = 0x01, C1_MODE = 0x02, C1_TEMP = 0x04, C1_FAN = 0x08, C1_VANE = 0x10;
let C2_WVANE = 0x01;

// ═══════════════════════════════════════════════════════════════════
//  STATE MACHINE
// ═══════════════════════════════════════════════════════════════════
let ST_BOOT = 0, ST_CONNECTING = 1, ST_IDLE = 2, ST_WAIT_RESP = 3, ST_WAIT_ACK = 4;

let uart = null;
let state = ST_BOOT;
let rxBuf = [];
let lastSendMs = 0;
let fails = 0;
let pollIdx = 0;
let nextCycleAt = 0;
let useTempEncB = false;      // detected from the 0x02 response
let gotFirstSettings = false;
let wideVaneAdj = false;

// Current device state
let cur = {
  connected: false,
  power: null, mode: null, temp: -1, fan: null, vane: null, wideVane: null,
  iSee: false,
  roomTemp: null, outsideTemp: null, runtimeHours: null,
  operating: false, compressorHz: null, inputPowerW: null, kWh: null
};

// Desired settings (waiting to be sent)
let want = { power: null, mode: null, temp: -1, fan: null, vane: null, wideVane: null, dirty: false };

// External (remote) temperature
let remoteTemp = 0;           // 0 = use the heat pump's internal sensor
let remoteTempPending = false;
let remoteTempSetAt = 0;
let remoteTempSentAt = 0;

// ═══════════════════════════════════════════════════════════════════
//  HELPERS: string <-> byte
// ═══════════════════════════════════════════════════════════════════
// NOTE: on some Shelly firmware builds chr(0) returns an EMPTY string, which
// would truncate every packet containing zero bytes. String.fromCharCode(0)
// is checked first and used whenever it preserves the zero byte.
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

// ═══════════════════════════════════════════════════════════════════
//  PACKET BUILDING
//  Checksum = (0xFC - sum(all bytes before the checksum)) & 0xFF
// ═══════════════════════════════════════════════════════════════════
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
  // FC 41 01 30 10 <cmd> ... = indexes 0..20 (checksum appended in frameOut)
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

// ═══════════════════════════════════════════════════════════════════
//  UART TRANSMIT
// ═══════════════════════════════════════════════════════════════════
function uartWrite(s) {
  if (uart === null) { return 0; }
  if (uart.send) { return uart.send(s); }   // official Gen2+ Script API
  return uart.write(s);                     // UART objects without send()
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
  }
  let n = uartWrite(s);
  if (typeof n === "number" && n !== s.length) {
    print("[cn105] WARNING: UART sent " + JSON.stringify(n) + "/" +
          JSON.stringify(s.length) + " bytes");
  }
  lastSendMs = Date.now();
  state = newState;
}

// ═══════════════════════════════════════════════════════════════════
//  RECEIVE AND FRAMING
// ═══════════════════════════════════════════════════════════════════
function resync() {
  while (rxBuf.length > 0 && rxBuf[0] !== 0xFC) { rxBuf.splice(0, 1); }
}

function parseRx() {
  resync();
  while (rxBuf.length >= 5) {
    let dlen = rxBuf[4];
    let total = dlen + 6;               // 5 header + data + 1 checksum
    if (total > 64) {                   // absurd length -> drop the sync byte
      rxBuf.splice(0, 1);
      resync();
      continue;
    }
    if (rxBuf.length < total) { return; }   // wait for more bytes

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
  }
  fails = 0;
  let t = f[1];

  if (t === 0x7A || t === 0x7B) {          // CONNECT ok
    cur.connected = true;
    state = ST_IDLE;
    pollIdx = 0;
    nextCycleAt = 0;
    print("[cn105] Connected to heat pump (0x" + hex(t) + ")");
    return;
  }
  if (t === 0x61) {                        // write ACK
    if (state === ST_WAIT_ACK) { state = ST_IDLE; }
    return;
  }
  if (t === 0x62) {                        // data response
    handleInfo(f);
    return;
  }
  dbg("unknown packet type 0x" + hex(t));
}

function handleInfo(f) {
  // data[i] in ESPHome == f[5 + i]
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

// ═══════════════════════════════════════════════════════════════════
//  DECODERS
// ═══════════════════════════════════════════════════════════════════
function decodeSettings(f) {
  let d3 = f[8], d4 = f[9], d5 = f[10], d6 = f[11], d7 = f[12];
  let d10 = f[15], d11 = f[16];

  cur.power = mapByte(POWER_B, POWER_M, d3, cur.power);
  cur.iSee = (d4 > 0x08);
  let modeByte = cur.iSee ? (d4 - 0x08) : d4;
  cur.mode = mapByte(MODE_B, MODE_M, modeByte, cur.mode);

  if (d11 !== 0x00) {
    cur.temp = (d11 - 128) / 2;
    useTempEncB = true;                     // half-degree resolution supported
  } else {
    cur.temp = 31 - d5;                     // TEMP_MAP: 0x00=31 ... 0x0F=16
  }

  cur.fan = mapByte(FAN_B, FAN_M, d6, cur.fan);
  cur.vane = mapByte(VANE_B, VANE_M, d7, cur.vane);

  if (d10 !== 0) {
    cur.wideVane = mapByte(WVANE_B, WVANE_M, d10 & 0x0F, cur.wideVane);
    wideVaneAdj = ((d10 & 0xF0) === 0x80);
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
    cur.roomTemp = d3 + 10;                 // ROOM_TEMP_MAP: 0x00=10 ... 0x1F=41
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
  // 0x09: d3 = sub mode, d4 = stage, d5 = auto sub mode. Diagnostics only.
  dbg("standby sub=0x" + hex(f[8]) + " stage=0x" + hex(f[9]) + " auto=0x" + hex(f[10]));
}

// ═══════════════════════════════════════════════════════════════════
//  WRITE: SETTINGS PACKET (0x41 / 0x01)
// ═══════════════════════════════════════════════════════════════════
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
      b[19] = (Math.round(t * 2) + 128) & 0xFF;      // encoding B, 0.5 degrees
    } else {
      b[10] = (31 - Math.round(t)) & 0x0F;           // legacy TEMP table
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
    if (i >= 0) { b[18] = WVANE_B[i] | (wideVaneAdj ? 0x80 : 0x00); c2 |= C2_WVANE; }
  }

  if (c1 === 0 && c2 === 0) { clearWant(); return; }

  b[6] = c1;
  b[7] = c2;
  sendFrame(b, ST_WAIT_ACK);
  clearWant();
  pollIdx = 0;
  nextCycleAt = 0;               // poll again right away so the state refreshes
}

function clearWant() {
  want.power = null; want.mode = null; want.temp = -1;
  want.fan = null; want.vane = null; want.wideVane = null;
  want.dirty = false;
}

// ═══════════════════════════════════════════════════════════════════
//  WRITE: REMOTE TEMPERATURE (0x41 / 0x07)
// ═══════════════════════════════════════════════════════════════════
function sendRemoteTemp() {
  let b = newSetPacket(0x07);
  if (remoteTemp > 0) {
    let r = Math.round(remoteTemp * 2);
    b[6] = 0x01;
    b[7] = (r - 16) & 0xFF;       // encoding A (legacy)
    b[8] = (r + 128) & 0xFF;      // encoding B
  } else {
    b[6] = 0x00;
    b[8] = 0x80;                  // MHK1 sends 0x80 -> revert to internal sensor
  }
  sendFrame(b, ST_WAIT_ACK);
  remoteTempSentAt = Date.now();
  remoteTempPending = false;
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

// ═══════════════════════════════════════════════════════════════════
//  STATE MACHINE CLOCK
// ═══════════════════════════════════════════════════════════════════
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
    if (fails >= CFG.MAX_FAILS) {
      print("[cn105] Connection lost, reconnecting");
      fails = 0;
      sendConnect();
      return;
    }
    state = ST_IDLE;
  }

  // ST_IDLE
  if (want.dirty) { sendSet(); return; }
  if (remoteTempDue(now)) { sendRemoteTemp(); return; }
  if (pollIdx > 0 || now >= nextCycleAt) {
    sendFrame(newInfoPacket(CFG.POLL[pollIdx]), ST_WAIT_RESP);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  COMMAND INTERFACE
// ═══════════════════════════════════════════════════════════════════
function applyCommand(o) {
  let touched = false;
  if (o.power !== undefined && idxOfStr(POWER_M, o.power) >= 0) { want.power = o.power; touched = true; }
  if (o.mode !== undefined && idxOfStr(MODE_M, o.mode) >= 0) { want.mode = o.mode; touched = true; }
  if (o.fan !== undefined && idxOfStr(FAN_M, o.fan) >= 0) { want.fan = o.fan; touched = true; }
  if (o.vane !== undefined && idxOfStr(VANE_M, o.vane) >= 0) { want.vane = o.vane; touched = true; }
  if (o.wideVane !== undefined && idxOfStr(WVANE_M, o.wideVane) >= 0) { want.wideVane = o.wideVane; touched = true; }
  if (o.temp !== undefined) {
    let t = o.temp * 1;
    if (t >= CFG.MIN_TEMP && t <= CFG.MAX_TEMP) { want.temp = t; touched = true; }
  }
  if (o.remote_temp !== undefined) {
    let rt = o.remote_temp * 1;
    remoteTemp = (rt >= 1 && rt <= 40) ? rt : 0;
    remoteTempSetAt = Date.now();
    remoteTempPending = true;
  }
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
    remote_temp: remoteTemp
  });
}

function publishState() {
  print("[cn105] " + stateJson());
  vcSync();
  if (CFG.MQTT_ENABLE && typeof MQTT !== "undefined" && MQTT.isConnected()) {
    MQTT.publish(CFG.MQTT_PREFIX + "/state", stateJson(), 0, false);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  MQTT BROKER AUTO-CONFIG (device level)
//  Writes CFG.MQTT_HOST/PORT/USER/PASS/PREFIX into the Pill's own MQTT
//  component once and reboots to apply. A signature of the applied values
//  is kept in KVS so a changed password is re-applied but an unchanged
//  config never causes a reboot loop (max 3 attempts, then it gives up).
//  Runs as the LAST boot stage, after the virtual components are created,
//  and keeps at most two RPCs in flight.
// ═══════════════════════════════════════════════════════════════════
let MQTT_KVS_KEY = "cn105_mqtt_applied";
let mqttCurCfg = null;

function mqttServer() {
  return CFG.MQTT_HOST + ":" + JSON.stringify(CFG.MQTT_PORT);
}

// change-detection signature only (not a secret hash)
function mqttSig() {
  let h = 0;
  for (let i = 0; i < CFG.MQTT_PASS.length; i++) {
    h = ((h * 31) + CFG.MQTT_PASS.charCodeAt(i)) & 0xFFFFFF;
  }
  return mqttServer() + "|" + CFG.MQTT_USER + "|" + CFG.MQTT_PREFIX + "|" + JSON.stringify(h);
}

function mqttEnsure() {
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
             (prevSig === sig);
  if (same) {
    if (cnt !== 0) { Shelly.call("KVS.Set", { key: MQTT_KVS_KEY, value: sig + "#0" }, null, null); }
    mqttPrefixCheck();
    return;
  }
  if (prevSig === sig && cnt >= 3) {
    print("[cn105] ERROR: MQTT config did not persist after 3 attempts — configure MQTT in the web UI");
    return;
  }
  let attempt = (prevSig === sig) ? cnt + 1 : 1;
  print("[cn105] Applying MQTT broker " + mqttServer() + " user=" + (CFG.MQTT_USER || "(none)") +
        " prefix=" + CFG.MQTT_PREFIX + " (attempt " + JSON.stringify(attempt) + ")");
  Shelly.call("KVS.Set", { key: MQTT_KVS_KEY, value: sig + "#" + JSON.stringify(attempt) }, null, null);
  Shelly.call("Mqtt.SetConfig", { config: {
    enable: true,
    server: mqttServer(),
    user: CFG.MQTT_USER ? CFG.MQTT_USER : null,
    pass: CFG.MQTT_PASS ? CFG.MQTT_PASS : null,
    topic_prefix: CFG.MQTT_PREFIX
  } }, mqttEnsureCb3, null);
}

function mqttEnsureCb3(res, err, msg, ud) {
  if (err !== 0) { print("[cn105] Mqtt.SetConfig failed: " + msg); return; }
  if (res && res.restart_required) {
    print("[cn105] MQTT config applied — rebooting once to activate it");
    Timer.set(2000, false, function () { Shelly.call("Shelly.Reboot", {}, null, null); }, null);
  } else {
    mqttPrefixCheck();
  }
}

// The HA package expects availability on <MQTT_PREFIX>/online, which is the
// Pill's own LWT topic <mqtt.topic_prefix>/online -> the two must be equal.
function mqttPrefixCheck() {
  Shelly.call("Mqtt.GetConfig", {}, function (res, err, msg, ud) {
    if (err !== 0 || !res) { return; }
    if (!res.enable) {
      print("[cn105] WARNING: device MQTT is disabled — set MQTT_HOST in CFG or enable it in the web UI");
      return;
    }
    if (res.topic_prefix !== CFG.MQTT_PREFIX) {
      print("[cn105] WARNING: Shelly MQTT prefix is \"" + res.topic_prefix + "\" but CFG.MQTT_PREFIX is \"" +
            CFG.MQTT_PREFIX + "\" — the HA package availability topic will not match. " +
            "Set the web UI MQTT prefix to \"" + CFG.MQTT_PREFIX + "\" (or set MQTT_HOST to let the script do it).");
    }
  }, null);
}

// ═══════════════════════════════════════════════════════════════════
//  HOME ASSISTANT MQTT DISCOVERY (Option B, retained, self-healing)
//  Published on boot once MQTT is up, and re-published every time HA
//  sends its birth message — so the climate entity survives broker
//  restarts, wiped retained topics and HA restarts without manual work.
// ═══════════════════════════════════════════════════════════════════
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
    action_template: "{% if value_json.power == 'OFF' %}off{% elif not value_json.operating %}idle{% else %}{{ {'HEAT':'heating','COOL':'cooling','DRY':'drying','FAN':'fan','AUTO':'idle'}.get(value_json.mode,'idle') }}{% endif %}"
  };
  // Availability from the device's own LWT topic (<mqtt.topic_prefix>/online)
  try {
    let mc = Shelly.getComponentConfig("mqtt");
    if (mc && mc.topic_prefix) {
      d.availability_topic = mc.topic_prefix + "/online";
      d.payload_available = "true";
      d.payload_not_available = "false";
    }
  } catch (eMc) { }
  // configuration_url from the current IP -> survives DHCP address changes
  try {
    let ws = Shelly.getComponentStatus("wifi");
    if (ws && ws.sta_ip) { d.device.configuration_url = "http://" + ws.sta_ip + "/"; }
  } catch (eWs) { }
  return JSON.stringify(d);
}

function haDiscoveryPublish() {
  if (!CFG.HA_DISCOVERY || typeof MQTT === "undefined" || !MQTT.isConnected()) { return; }
  MQTT.publish(CFG.HA_DISC_PREFIX + "/climate/" + CFG.HA_DISC_ID + "/config",
               haDiscoveryJson(), 0, true);
  haDiscPublished = true;
  print("[cn105] HA discovery published (retained)");
}

function haStatusCb(topic, msg) {
  // HA publishes "online" on its birth topic on every (re)connect and restart
  if (msg === "online") { haDiscoveryPublish(); }
}

function haDiscoveryInit() {
  if (!CFG.HA_DISCOVERY || typeof MQTT === "undefined") { return; }
  MQTT.subscribe(CFG.HA_DISC_PREFIX + "/status", haStatusCb, null);
  Timer.set(10000, true, function () {
    if (!haDiscPublished) { haDiscoveryPublish(); }
  }, null);
  haDiscoveryPublish();
}

// ═══════════════════════════════════════════════════════════════════
//  VIRTUAL COMPONENTS — Shelly app control, group CFG.VC_GROUP_NAME
//  Created by the script itself (Virtual.Add) with fixed ids, bound to
//  Virtual.getHandle handles. Change in the app -> applyCommand;
//  pump state -> components on every poll cycle.
// ═══════════════════════════════════════════════════════════════════
let VC_GROUP_ID = 206;
let VC_DEFS = [
  { ns: "Boolean", type: "boolean", id: 200, cfg: { name: "Power" } },
  { ns: "Enum",    type: "enum",    id: 201, cfg: { name: "Mode",  options: MODE_M } },
  { ns: "Enum",    type: "enum",    id: 202, cfg: { name: "Fan",   options: FAN_M } },
  { ns: "Enum",    type: "enum",    id: 203, cfg: { name: "Vane",  options: VANE_M } },
  { ns: "Enum",    type: "enum",    id: 204, cfg: { name: "WVane", options: WVANE_M } },
  { ns: "Number",  type: "number",  id: 205, cfg: { name: "Target temperature",
                     min: CFG.MIN_TEMP, max: CFG.MAX_TEMP,
                     // REQUIRED inside min..max: the implicit default 0 would be rejected at creation
                     default_value: Math.round((CFG.MIN_TEMP + CFG.MAX_TEMP) / 2),
                     meta: { ui: { view: "slider", unit: "°C", step: 0.5 } } } },
  { ns: "Number",  type: "number",  id: 207, cfg: { name: "Room temperature", min: 0, max: 50,
                     default_value: 20,
                     meta: { ui: { view: "label", unit: "°C", step: 0.5 } } } },
  { ns: "Group",   type: "group",   id: 206, cfg: { name: CFG.VC_GROUP_NAME } }
];

let vcH = { power: null, mode: null, fan: null, vane: null, wvane: null, temp: null, room: null };
let vcIdx = 0;

function ensureVcs() {
  if (typeof Virtual === "undefined") {
    print("[cn105] Virtual API not available — app control disabled");
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
    // exists -> refresh the config (e.g. option lists stay up to date);
    // advance only in the callback -> one RPC in flight at a time
    Shelly.call(d.ns + ".SetConfig", { id: d.id, config: d.cfg }, vcAdvanceCb, null);
    return;
  }
  Shelly.call("Virtual.Add", { type: d.type, id: d.id, config: d.cfg }, vcAddCb, null);
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
  vcH.room  = Virtual.getHandle("number:207");   // read-only display, no listener
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
    // fallback: listen to component status changes instead
    Shelly.addStatusHandler(vcStatusFallback, null);
    print("[cn105] VC on(change) not supported — falling back to status handler");
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

// Loop guard: our own sync fires a change event whose source is "script:N"
// or "sys" depending on the firmware -> additionally skip any value that
// already matches the pump state, which covers every source string.
function vcFromScript(ev) {
  return (ev && typeof ev.source === "string" && ev.source.indexOf("script") >= 0);
}

function onVcPower(ev) {
  if (vcFromScript(ev)) { return; }
  let p = ev.value ? "ON" : "OFF";
  if (p === cur.power) { return; }
  applyCommand({ power: p });
}
function onVcMode(ev) {
  if (vcFromScript(ev) || ev.value === cur.mode) { return; }
  applyCommand({ mode: ev.value });
}
function onVcFan(ev) {
  if (vcFromScript(ev) || ev.value === cur.fan) { return; }
  applyCommand({ fan: ev.value });
}
function onVcVane(ev) {
  if (vcFromScript(ev) || ev.value === cur.vane) { return; }
  applyCommand({ vane: ev.value });
}
function onVcWVane(ev) {
  if (vcFromScript(ev) || ev.value === cur.wideVane) { return; }
  applyCommand({ wideVane: ev.value });
}
function onVcTemp(ev) {
  if (vcFromScript(ev) || ev.value === cur.temp) { return; }
  applyCommand({ temp: ev.value });
}

function vcSet(h, v) {
  if (!h || v === null || v === undefined) { return; }
  if (h.getValue() === v) { return; }
  h.setValue(v);
}

function vcSync() {
  if (cur.power !== null) { vcSet(vcH.power, cur.power === "ON"); }
  vcSet(vcH.mode, cur.mode);
  vcSet(vcH.fan, cur.fan);
  vcSet(vcH.vane, cur.vane);
  vcSet(vcH.wvane, cur.wideVane);
  if (cur.temp > 0) { vcSet(vcH.temp, cur.temp); }
  vcSet(vcH.room, cur.roomTemp);
}

// ═══════════════════════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════════════════════
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

  // The official key is "format"; older builds used "mode" and silently
  // ignored unknown keys (parity would stay 8N1), so both keys are sent and
  // both failure styles are handled (return false / throw). On fw 2.0.1 the
  // Serial component set above already owns baud and framing.
  let ok = false;
  try { ok = (uart.configure({ baud: CFG.BAUD, mode: CFG.FORMAT, format: CFG.FORMAT }) !== false); } catch (e3) { ok = false; }
  if (!ok) {
    try { ok = (uart.configure({ baud: CFG.BAUD, mode: CFG.FORMAT }) !== false); } catch (e4) { ok = false; }
  }
  if (!ok) {
    try { ok = (uart.configure({ baud: CFG.BAUD, format: CFG.FORMAT }) !== false); } catch (e5) { ok = false; }
  }
  if (!ok && serialCfgOk) {
    // fw 2.0.1: the Serial component owns baud/format -> already verified
    print("[cn105] uart.configure unavailable; Serial component is " +
          JSON.stringify(CFG.BAUD) + " " + CFG.FORMAT + " -> continuing");
    ok = true;
  }
  if (!ok) {
    print("[cn105] ERROR: uart.configure failed (baud=" + JSON.stringify(CFG.BAUD) + " " + CFG.FORMAT + ")");
    return;
  }
  if (C(0).length !== 1) {
    print("[cn105] ERROR: zero-byte string building is broken — packets would be truncated. Aborting.");
    return;
  }
  print("[cn105] UART " + JSON.stringify(CFG.BAUD) + " " + CFG.FORMAT);

  uart.recv(function (data) {
    if (CFG.DEBUG && data.length > 0) {
      let h = "";
      for (let j = 0; j < data.length; j++) { h += hex(B(data, j)) + " "; }
      print("[cn105] raw RX (" + JSON.stringify(data.length) + "): " + h);
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
    MQTT.subscribe(CFG.MQTT_PREFIX + "/set", function (topic, msg) {
      try { applyCommand(JSON.parse(msg)); } catch (e6) { print("[cn105] MQTT parse fail"); }
    }, null);
  }

  Timer.set(CFG.TICK_MS, true, function () { tick(); }, null);
  sendConnect();
}

// Report the Serial/Pill component state before opening the UART
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
      print("[cn105] !!! Pill is NOT in js_uart mode — run Pill.SetConfig {\"config\":{\"mode\":\"js_uart\"}} and reboot.");
    }
    // reserved pins show which IOs the UART claimed (e.g. pin0+pin1 -> IO1/IO2)
  }, null);
}

// Serial mode names: "jsuart" (docs / earlier builds), "js_uart" (Pill fw 2.0.1)
function isJsUart(m) { return m === "jsuart" || m === "js_uart"; }

let serialCfgOk = false;   // Serial component verified/set to jsuart BAUD FORMAT
let bootTries = 0;

// Diagnostics, virtual components and HA discovery only after the UART is
// up -> never more than a couple of RPCs in flight at boot.
function startAux() {
  startDiag();
  Timer.set(1500, false, function () { ensureVcs(); haDiscoveryInit(); }, null);
}

// Last boot stage: MQTT broker settings. Called when the virtual components
// are done, so the one-time reboot it may trigger never interrupts them.
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
    // wrong mode name for this firmware -> try the other spelling once
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
    print("[cn105] No Serial component on this firmware (" + msg + ") — using the direct UART API");
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
  // keep the firmware's own spelling; unknown mode -> fw 2.0.1 name first
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
