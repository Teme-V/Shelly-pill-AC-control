/**
 * @title Ouman EH-800B companion: crash watchdog + Home Assistant discovery
 * @description Companion for ouman_eh800b_usb.shelly.js on the same Pill. Reboots
 *   the Pill when the main script has stopped on an error (out_of_memory etc.),
 *   because on firmware 2.0.1 a UART script only receives after a fresh boot,
 *   and publishes Home Assistant MQTT discovery for the main script's topics.
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
 * Install: add both scripts and enable "Run on startup" for both. This script
 * does not touch the UART. A main script stopped by hand (no error) is left
 * alone; at most WD_MAX_PER_DAY reboots per day (counter in KVS "ouman_wd").
 *
 * version 20261021-1
 */

let CFG = {
  MAIN_NAME: "ouman_eh800b_usb",   // script name of the main script (Script.List)
  WD_CHECK_S: 60,
  WD_MAX_PER_DAY: 6,
  MQTT_PREFIX: "ouman",            // same as the main script
  VC: true,                        // create virtual components 200-209 for the main script
  VC_GROUP_NAME: "Ouman",
  HA_DISCOVERY: true,
  HA_DISC_PREFIX: "homeassistant",
  HA_NAME: "Ouman EH-800B"
};

let mainId = -1, devId = "", haDone = false, discI = 0, vcI = 0, vcOk = 0;
let DEGC = String.fromCharCode(194, 176) + "C";   // UTF-8 degree sign (\u escapes are not allowed)
let MODE_N = ["auto", "forced_reduced", "forced_big_reduced", "forced_normal", "shutdown", "manual"];

// ---------------- virtual components for the main script ----------------
// number 200 outdoor, 201 supply, 202 room, 203 return, 204 DHW, 205 valve,
// 206 room setpoint, enum 207 mode, boolean 208 link, group 209.
// One RPC at a time; an existing component keeps the meta set in the app.
function vcDef(i) {
  let lbl = { ui: { view: "label", unit: DEGC, step: 0.1 } };
  let names = ["Outdoor", "Supply water", "Room", "Return water", "DHW tank"];
  if (i < 5) { return { ns: "Number", type: "number", cfg: { name: names[i], min: -60, max: 120, default_value: 0, meta: lbl } }; }
  if (i === 5) { return { ns: "Number", type: "number", cfg: { name: "Valve", min: 0, max: 100, default_value: 0, meta: { ui: { view: "label", unit: "%", step: 0.1 } } } }; }
  if (i === 6) { return { ns: "Number", type: "number", cfg: { name: "Room setpoint", min: 5, max: 30, default_value: 21, meta: { ui: { view: "slider", unit: DEGC, step: 0.5 } } } }; }
  if (i === 7) { return { ns: "Enum", type: "enum", cfg: { name: "Mode", options: MODE_N, default_value: "auto", meta: { ui: { view: "dropdown" } } } }; }
  if (i === 8) { return { ns: "Boolean", type: "boolean", cfg: { name: "Link", default_value: false, meta: { ui: { view: "label" } } } }; }
  return { ns: "Group", type: "group", cfg: { name: CFG.VC_GROUP_NAME } };
}
function vcNext() {
  if (vcI > 9) { vcFinish(); return; }
  Shelly.call(vcDef(vcI).ns + ".GetConfig", { id: 200 + vcI }, vcGetCb, null);
}
// SetConfig replaces meta as a whole: keep the device's meta (titles, icons
// set in the app) and only fill a view that was never set; "" = Hidden stays
function vcGetCb(res, err, msg, ud) {
  let d = vcDef(vcI);
  if (err === 0) {
    let old = (res && res.meta) ? res.meta : null;
    if (d.cfg.meta && old) {
      if (!old.ui) { old.ui = {}; }
      if (old.ui.view === undefined) { old.ui.view = d.cfg.meta.ui.view; }
      if (d.cfg.meta.ui.unit !== undefined && old.ui.unit === undefined) { old.ui.unit = d.cfg.meta.ui.unit; }
      if (d.cfg.meta.ui.step !== undefined && old.ui.step === undefined) { old.ui.step = d.cfg.meta.ui.step; }
      d.cfg.meta = old;
    }
    Shelly.call(d.ns + ".SetConfig", { id: 200 + vcI, config: d.cfg }, vcStepCb, null);
    return;
  }
  Shelly.call("Virtual.Add", { type: d.type, id: 200 + vcI, config: d.cfg }, vcStepCb, null);
}
function vcStepCb(res, err, msg, ud) {
  if (err === 0) { vcOk |= (1 << vcI); } else { print("[ouman-vc] " + JSON.stringify(200 + vcI) + " failed: " + msg); }
  vcI++;
  vcNext();
}
// the group only takes existing keys (Group.Set rejects the whole list otherwise)
function vcFinish() {
  let k = "number:200,number:201,number:202,number:203,number:204,number:205,number:206,enum:207,boolean:208".split(","), keys = [];
  for (let i = 0; i < 9; i++) { if (vcOk & (1 << i)) { keys.push(k[i]); } }
  if (vcOk & (1 << 9)) { Shelly.call("Group.Set", { id: 209, value: keys }, null, null); }
  print("[ouman-vc] virtual components ready (" + JSON.stringify(keys.length) + " + group)");
}

// ---------------- watchdog ----------------
function listCb(res, err, msg, ud) {
  if (err !== 0 || !res || !res.scripts) { return; }
  for (let i = 0; i < res.scripts.length; i++) {
    if (res.scripts[i].name === CFG.MAIN_NAME) { mainId = res.scripts[i].id; }
  }
  print("[ouman-wd] main script id " + JSON.stringify(mainId));
}
function statusCb(res, err, msg, ud) {
  if (err !== 0 || !res || res.running) { return; }
  if (!res.errors || res.errors.length === 0) { return; }   // stopped by hand
  print("[ouman-wd] main script stopped: " + JSON.stringify(res.errors));
  Shelly.call("KVS.Get", { key: "ouman_wd" }, kvsGetCb, JSON.stringify(res.errors));
}
function kvsGetCb(res, err, msg, why) {
  let day = Math.floor(Shelly.getComponentStatus("sys").unixtime / 86400), n = 0;
  if (err === 0 && res && res.value) {
    let p = res.value.split(":");
    if (Number(p[0]) === day) { n = Number(p[1]); }
  }
  if (n >= CFG.WD_MAX_PER_DAY) { print("[ouman-wd] reboot limit reached today, not rebooting"); return; }
  Shelly.call("KVS.Set", { key: "ouman_wd", value: JSON.stringify(day) + ":" + JSON.stringify(n + 1) + ":" + why.slice(0, 40) }, kvsSetCb, null);
}
function kvsSetCb(res, err, msg, ud) {
  print("[ouman-wd] rebooting the Pill");
  Shelly.call("Shelly.Reboot", {}, null, null);
}
function tick() {
  if (mainId < 0) { Shelly.call("Script.List", {}, listCb, null); }
  else { Shelly.call("Script.GetStatus", { id: mainId }, statusCb, null); }
  if (CFG.HA_DISCOVERY && !haDone) { discStart(); }
}

// ---------------- Home Assistant discovery ----------------
// one entity per line: component|key|name|unit|device_class|source
//   unit C = degree Celsius (\u escapes are not allowed in Shelly scripts)
//   source s = <prefix>/state key, r = /diag rows key, p = /diag props id (raw/10)
let ENT = "sensor|outdoor|Outdoor temperature|C|temperature|s\n" +
  "sensor|supply|Supply water|C|temperature|s\n" +
  "sensor|room|Room temperature|C|temperature|s\n" +
  "sensor|return|Return water|C|temperature|s\n" +
  "sensor|dhw|DHW tank|C|temperature|s\n" +
  "sensor|valve|Valve position|%||s\n" +
  "sensor|trend_age_s|Trend age|s|duration|s\n" +
  "sensor|supply_curve|Supply by curve|C|temperature|r\n" +
  "sensor|room_comp|Room compensation|C|temperature|r\n" +
  "sensor|room_comp_time|Room compensation time correction|C|temperature|r\n" +
  "sensor|supply_target|Supply target|C|temperature|r\n" +
  "sensor|outdoor_slow|Outdoor delayed|C|temperature|r\n" +
  "sensor|room_slow|Room delayed|C|temperature|r\n" +
  "sensor|valve_target|Valve target|%||r\n" +
  "sensor|l2_curve|L2 supply by curve|C|temperature|r\n" +
  "sensor|supply_setpoint|Supply setpoint|C|temperature|r\n" +
  "sensor|outdoor_delay|Outdoor delay effect|C|temperature|r\n" +
  "sensor|l2_target|L2 supply target|C|temperature|r\n" +
  "sensor|status|Status|||x\n" +
  "select|mode|Mode|||c\n" +
  "number|room_set|Room setpoint|C||c\n" +
  "number|fine_supply|Supply fine adjustment|C||c\n" +
  "number|supply_const|Constant supply setpoint|C||c\n" +
  "switch|away|Away|||c\n" +
  "binary_sensor|link|USB link|||c\n" +
  "climate|climate|Heating|||c";

function discStart() {
  if (typeof MQTT === "undefined" || !MQTT.isConnected()) { return; }
  devId = Shelly.getDeviceInfo().id;
  discI = 0;
  haDone = true;
  Timer.set(300, false, discNext, null);
}
function discNext() {
  let lines = ENT.split("\n");
  if (discI >= lines.length) { print("[ouman-ha] discovery published (" + JSON.stringify(discI) + ")"); return; }
  let f = lines[discI].split("|");
  discI++;
  try {
    MQTT.publish(CFG.HA_DISC_PREFIX + "/" + f[0] + "/" + devId + "/" + f[1] + "/config", JSON.stringify(entity(f)), 0, true);
  } catch (e) { print("[ouman-ha] publish " + f[1] + ": " + e); }
  Timer.set(250, false, discNext, null);
}
function avty(withLink) {
  let a = [{ t: Shelly.getComponentConfig("mqtt").topic_prefix + "/online", pl_avail: "true", pl_not_avail: "false" }];
  if (withLink) { a.push({ t: CFG.MQTT_PREFIX + "/state", val_tpl: "{{ 'online' if value_json.link else 'offline' }}" }); }
  return a;
}
function entity(f) {
  let st = CFG.MQTT_PREFIX + "/state", dg = CFG.MQTT_PREFIX + "/diag", cmd = CFG.MQTT_PREFIX + "/set";
  let ip = "";
  try { ip = Shelly.getComponentStatus("wifi").sta_ip; } catch (e) { }
  let e = {
    name: f[2], uniq_id: devId + "_ouman_" + f[1], obj_id: "ouman_" + f[1],
    dev: { ids: [devId + "_ouman"], name: CFG.HA_NAME, mf: "Ouman", mdl: "EH-800B (USB, Shelly Pill)", cu: ip ? "http://" + ip + "/" : undefined },
    avty: avty(f[1] !== "link"), avty_mode: "all"
  };
  if (f[3]) { e.unit_of_meas = (f[3] === "C") ? String.fromCharCode(194, 176) + "C" : f[3]; }
  if (f[4]) { e.dev_cla = f[4]; }
  if (f[0] === "sensor" && f[3]) { e.stat_cla = "measurement"; }
  if (f[5] === "s") { e.stat_t = st; e.val_tpl = "{{ value_json['" + f[1] + "'] }}"; }
  else if (f[5] === "r") { e.stat_t = dg; e.val_tpl = "{{ value_json.rows.get('" + f[1] + "') if value_json.rows is defined else None }}"; e.ent_cat = "diagnostic"; }
  else if (f[5] === "x") { e.stat_t = dg; e.val_tpl = "{{ value_json.status if value_json.status is defined else None }}"; e.ent_cat = "diagnostic"; }
  if (f[1] === "trend_age_s") { e.ent_cat = "diagnostic"; }
  if (f[1] === "mode") {
    e.stat_t = st; e.val_tpl = "{{ value_json.mode }}"; e.cmd_t = cmd; e.cmd_tpl = "{\"mode\":\"{{ value }}\"}";
    e.ops = ["auto", "forced_reduced", "forced_big_reduced", "forced_normal", "shutdown", "manual"];
  } else if (f[1] === "room_set") {
    e.stat_t = st; e.val_tpl = "{{ value_json.room_set }}"; e.cmd_t = cmd; e.cmd_tpl = "{\"room_set\": {{ value }} }";
    e.min = 5; e.max = 30; e.step = 0.5; e.mode = "box";
  } else if (f[1] === "fine_supply" || f[1] === "supply_const") {
    let id = f[1] === "fine_supply" ? "134" : "127";
    e.stat_t = dg;
    e.val_tpl = "{% set v = value_json.props.get('" + id + "') if value_json.props is defined else None %}{{ v / 10 if v is not none else None }}";
    e.cmd_t = cmd; e.cmd_tpl = "{\"prop\":" + id + ",\"raw\": {{ (value * 10) | round | int }} }";
    if (id === "134") { e.min = -4; e.max = 4; e.step = 0.1; } else { e.min = 0; e.max = 95; e.step = 0.5; }
    e.mode = "box"; e.ent_cat = "config";
  } else if (f[1] === "away") {
    e.stat_t = st; e.val_tpl = "{{ 'ON' if value_json.away else 'OFF' }}"; e.cmd_t = cmd;
    e.pl_on = "{\"away\":true}"; e.pl_off = "{\"away\":false}"; e.stat_on = "ON"; e.stat_off = "OFF";
  } else if (f[1] === "link") {
    e.stat_t = st; e.val_tpl = "{{ 'ON' if value_json.link else 'OFF' }}"; e.dev_cla = "connectivity"; e.ent_cat = "diagnostic";
  } else if (f[1] === "climate") {
    e.name = null; e.modes = ["heat"]; e.mode_stat_t = st; e.mode_stat_tpl = "heat";
    e.temp_cmd_t = cmd; e.temp_cmd_tpl = "{\"room_set\": {{ value }} }";
    e.temp_stat_t = st; e.temp_stat_tpl = "{{ value_json.room_set }}";
    e.curr_temp_t = st; e.curr_temp_tpl = "{{ value_json.room if value_json.room is not none else value_json.supply }}";
    e.min_temp = 5; e.max_temp = 30; e.temp_step = 0.5; e.precision = 0.1;
    e.pr_mode_cmd_t = cmd; e.pr_mode_cmd_tpl = "{\"mode\":\"{{ value }}\"}";
    e.pr_mode_stat_t = st; e.pr_mode_val_tpl = "{{ value_json.mode }}";
    e.pr_modes = ["auto", "forced_reduced", "forced_big_reduced", "forced_normal", "shutdown", "manual"];
    e.act_t = st; e.act_tpl = "{{ 'heating' if (value_json.valve or 0) > 0 else 'idle' }}";
  }
  return e;
}
function haStatus(topic, msg) { if (msg === "online") { haDone = false; discStart(); } }

// ---------------- start ----------------
try { if (CFG.HA_DISCOVERY) { MQTT.subscribe(CFG.HA_DISC_PREFIX + "/status", haStatus); } } catch (e) { print("[ouman-ha] MQTT disabled"); }
Timer.set(CFG.WD_CHECK_S * 1000, true, tick, null);
Timer.set(5000, false, tick, null);
if (CFG.VC && typeof Virtual !== "undefined") { vcNext(); }
