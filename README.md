# SignalK Bluetti Power Station Monitoring

[![npm version](https://img.shields.io/npm/v/@rhizomatics/signalk-bluetti-plugin.svg)](https://www.npmjs.com/package/@rhizomatics/signalk-bluetti-plugin)
[![npm downloads](https://img.shields.io/npm/dm/@rhizomatics/signalk-bluetti-plugin.svg)](https://www.npmjs.com/package/@rhizomatics/signalk-bluetti-plugin)
[![SignalK Plugin CI](https://github.com/jeyrb/signalk-bluetti-plugin/actions/workflows/signalk-ci.yml/badge.svg)](https://github.com/jeyrb/signalk-bluetti-plugin/actions/workflows/signalk-ci.yml)
![code style: oxfmt](https://img.shields.io/badge/code_style-oxfmt-blue.svg)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/rhizomatics/signalk-bluetti-plugin/blob/main/LICENSE)

A SignalK plugin to display data from Bluetti power stations over a Bluetooth Low Energy (BLE) connection. ALPHA status

## Pre-requisites

The requirements below are only to make SignalK work with Bluetooth Low Energy, which is good thing to have anyway, since vendors like Victron, Switchbot, Ruuvi and others have BLE enabled hardware that's useful to have on a boat. Ignore if BLE already being used. [Direct BLE support](https://github.com/SignalK/signalk-server/issues/2411) in SignalK is being planned in 2026 and this plugin will support that when it comes.

1. A SignalK server, **running Linux**

- MacOS and Windows aren't supported by the [BLE interface layer](https://www.npmjs.com/package/@naugehyde/node-ble), however they can be used for template development and
  debugging (everything except `scan` and `paint`)

2. A Bluetooth adapter, that can handle BLE (Bluetooth Low Energy).

- Bluetooth adapters for Linux can be tricky, TP-Link UB400 and Asus USB-BT500 are two well-known and available ones
- Some Raspberry Pi models come with suitable Bluetooth built in
- Don't worry about the very latest Bluetooth versions, 4.0 is minimum for BLE, 5.0 is nice
- Home Assistant is massively more popular than SignalK, and often also run on Raspberry Pi and similar, so good source of advice

3. `bluez` package installed in Linux

- No need to do this if you have a Raspberry Pi with recent Raspian version, since bluez comes built in.
- If you're not running a Raspberry Pi, then ensure that the `dbus` package is installed

Once you have all of that, it may be worth also installing [signalk-victron-ble](https://github.com/stefanor/signalk-victron-ble), [signalk-ruuvitag-plugin](https://github.com/vokkim/signalk-ruuvitag-plugin) or [bt-sensors-plugin](https://github.com/naugehyde/bt-sensors-plugin-sk) to pull in data from other sensors and equipment.

4. Bluetti Encryption Key

If using a later model that needs encryption, email [service@bluettipower.com](mailto:service@bluettipower.com) to raise a support query for key. Official API site is at see https://github.com/bluetti-official/bluetti-bluetooth-lib. Key will be in the form of a CSV file, which be stored in your SignalK server, for example in a home directory, and referenced in the Bluetti Monitoring plugin configuration.

## Installation

Look for **Bluetti Monitoring** in the **SignalK AppStore** on your
server ( under _Apps & Plugins_ on the latest version).

## CLI

A `bluetti-cli` command is bundled for finding and inspecting devices without a running SignalK server. Run it from the plugin directory with `node cli.js <command>` (or `npm run cli -- <command>`); if installed globally/linked, `bluetti-cli <command>` works directly.

Requires a Linux host with BlueZ/D-Bus (same as the plugin itself) — it won't work on macOS/Windows.

### `scan`

Scan for nearby Bluetti devices and print their address and name.

```bash
node cli.js scan
node cli.js scan --all              # show every BLE device, not just Bluetti-matching ones
node cli.js scan --timeout 30       # scan duration in seconds (default: 15)
```

### `info <mac>`

Connect to a single device by MAC address and show details: name, alias, RSSI, pairing state, manufacturer data, and either its GATT services/characteristics or — if `--registers` is given — a live one-shot dump of decoded register values.

```bash
node cli.js info aa:bb:cc:dd:ee:ff

# Decode live registers using a bundled register map (see registers/*.csv for available models)
node cli.js info aa:bb:cc:dd:ee:ff --registers ac200p

# Or a custom CSV, plus an encryption key file for models that scramble frames
node cli.js info aa:bb:cc:dd:ee:ff --registers ./my-device-registers.csv --encryption-key ~/19e1646709e0421b755fa9dda74.csv

node cli.js info aa:bb:cc:dd:ee:ff --timeout 30   # discovery timeout if device isn't already known to BlueZ (default: 20)
```
