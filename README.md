# Shelly Pill heat pump and air conditioner control

Control a heat pump or air conditioner indoor unit through its **service port** with a
**Shelly Pill** and one Shelly script. The script speaks the unit's own UART protocol, so
there is no ESPHome and no extra microcontroller. Requires **Pill firmware 2.0.1 or later**
(the `js_uart` peripheral mode).

Each supported unit has its own folder with the script, an installation guide, a wiring
diagram and, where available, a Home Assistant package. **The README in the folder is the
installation guide.** This page only shows what exists and where to find it.

## Compatibility

| Brand | Port / connector | Script | Status | Folder |
|---|---|---|---|---|
| Mitsubishi Electric | CN105, 5-pin JST PA | `mitsubishi_cn105.shelly.js` | production | [`mitsubishi/cn105/`](mitsubishi/cn105/) |
| Panasonic | CN-CNT, 5-pin JST PA (different pin order from CN105) | `panasonic_cncnt.shelly.js` | in development | [`panasonic/cncnt/`](panasonic/cncnt/) |
| Toshiba (Seiya, Suzumi, Shorai, Daiseikai) | CN22, 5-pin JST PA | — | analysed, not started | — |
| Midea and rebrands (Qlima, Electrolux, Comfee, …) | Wi-Fi dongle port | — | analysed, not started | — |
| Gree / Sinclair | Wi-Fi dongle port | — | analysed, not started | — |
| Samsung | F1/F2 (RS-485) | — | waiting for the Pill RS-485 add-on | — |
| Mitsubishi Heavy Industries | CNS (SPI) | — | not feasible with a script (SPI, the unit is the master) | — |
| Ouman EH-800B (heating controller) | USB service port via a CH376S USB-host module (HW-252) | `ouman_eh800b_usb.shelly.js` + `ouman_eh800b_companion.shelly.js` | in development | [`ouman/eh800b-usb/`](ouman/eh800b-usb/) |

*production* = runs on a real unit with firmware 2.0.1 · *in development* = script exists and
is being tested · *analysed* = protocol studied from open-source implementations, no script yet.

Mitsubishi **Electric** and Mitsubishi **Heavy** are different manufacturers with different
ports. The CN105 script works only on Mitsubishi Electric units.

## Hardware: read this before wiring

The CN105, CN-CNT, CN22 and dongle ports use **5 V logic**; the Pill uses 3.3 V.

* Use a **bidirectional level shifter with its own 3.3 V LDO** (for example an MH-type
  2-channel module with a 662K / XC6206 regulator). The Pill's terminals do not provide 3.3 V.
  Without that reference the Pill **reads the unit but its commands never arrive**
  ("reads but does not write").
* Pill UART pins on firmware 2.0.1: **IO1 = TX, IO2 = RX**; leave IO3 unconnected.
* **Never connect a 12 V pin to a signal line.** Ports that share the same JST housing have
  different pin orders, so wire each adapter for its own port only.
* Each folder has a `wiring.png` for its port. Switch the indoor unit off at the mains before
  opening it.
* The Ouman EH-800B is different: it has a **USB** service port. The Pill talks to it through a
  CH376S USB-host module (3.3 V logic, no level shifter); see [`ouman/eh800b-usb/`](ouman/eh800b-usb/).

## Install from the Script Library

In the Pill's web UI: **Scripts** → **Library** → **Configure URL**, enter

```
https://raw.githubusercontent.com/Teme-V/Shelly-pill-AC-control/main/manifest.json
```

and pick the script for your unit. Then follow the README in its folder (peripheral mode,
`CFG` block, optional MQTT / Home Assistant). Copying the script by hand into
**Scripts** → **Add script** works as well.

The Library URL is set in the Pill's own web UI (firmware 2.0.1). Installing through the
Shelly app or the cloud has not been verified yet.

## Repository layout

```
LICENSE, NOTICE                   Apache License 2.0 and the credits it refers to
manifest.json                     Script Library list
docs/                             pictures shared by all brands (Pill peripheral mode)
mitsubishi/cn105/
  mitsubishi_cn105.shelly.js      the script
  README.md                       installation guide
  wiring.png, wiring.svg          wiring diagram and its source
  homeassistant/mitsubishi_ac.yaml
```

Conventions: one folder per brand and port, `<brand>/<port>/`, with the script named
`<brand>_<port>.shelly.js`. Scripts carry a JSDoc header (`@title`, `@description`,
`@status experimental|production`, `@link`) and an SPDX license header. A brand's folder is
added when its script is published.

Releases are tagged per brand and port. The current Mitsubishi CN105 kit is
[`v1.1-mitsubishi-cn105`](https://github.com/Teme-V/Shelly-pill-AC-control/releases/tag/v1.1-mitsubishi-cn105).
The original single-file layout (`cn105_pill.js` in the repository root) is kept in the tag
[`v1.0-mitsubishi-cn105`](https://github.com/Teme-V/Shelly-pill-AC-control/tree/v1.0-mitsubishi-cn105),
so links to it keep working.

## License and credits

Licensed under the [Apache License 2.0](LICENSE), Copyright 2026 Teemu Virta. [NOTICE](NOTICE)
lists the projects whose protocol work the scripts build on, with their license status.

* Mitsubishi Electric CN105: protocol knowledge is based on the reverse-engineering work of
  [SwiCago/HeatPump](https://github.com/SwiCago/HeatPump) (GPL-3.0) and
  [echavet/MitsubishiCN105ESPHome](https://github.com/echavet/MitsubishiCN105ESPHome).
  The script is an independent implementation for the Shelly scripting engine (Espruino) and
  does not contain code from those projects.

The sources for other brands are credited in their folders when those are published.

Provided as-is. You are connecting to the service port of a mains-powered appliance; use at
your own risk.
