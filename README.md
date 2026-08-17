# SignalK Bluetti Power Station Monitoring

[![npm version](https://img.shields.io/npm/v/@rhizomatics/signalk-bluetti-plugin.svg)](https://www.npmjs.com/package/@rhizomatics/signalk-bluetti-plugin)
[![npm downloads](https://img.shields.io/npm/dm/@rhizomatics/signalk-bluetti-plugin.svg)](https://www.npmjs.com/package/@rhizomatics/signalk-bluetti-plugin)
[![SignalK Plugin CI](https://github.com/rhizomatics/signalk-bluetti-plugin/actions/workflows/signalk-ci.yml/badge.svg)](https://github.com/rhizomatics/signalk-bluetti-plugin/actions/workflows/signalk-ci.yml)
![code style: oxfmt](https://img.shields.io/badge/code_style-oxfmt-blue.svg)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/rhizomatics/signalk-bluetti-plugin/blob/main/LICENSE)
[![boat tech directory](https://boat-tech-directory.rhizomatics.org.uk/images/badge.svg)](https://boat-tech-directory.rhizomatics.org.uk)

A SignalK plugin to display data from Bluetti power stations over a Bluetooth Low Energy (BLE) connection. Supports 20+ stations, extensible by configuration. Also offers a CLI for easier exploring and debugging, and optional support for the BLE Manager API introduced in SignalK Server 2.31.0.

![Example Data](docs/assets/screenshots/bluetti_data.png)

## Pre-requisites

The requirements below are only to make SignalK work with Bluetooth Low Energy, which is good thing to have anyway, since vendors like Victron, Switchbot, Ruuvi and others have BLE enabled hardware that's useful to have on a boat. Ignore if BLE already being used.

### SignalK BLE Manager

SignalK server 2.31.0 added a server-managed [BLE API](https://demo.signalk.org/documentation/Developing/REST_APIs/BLE_API.html) so multiple BLE plugins can share one adapter (or a remote gateway) through the server instead of each opening its own BlueZ session.

This plugin supports this with the **Use the SignalK BLE Manager API** setting (off by default, and only shown once your server is on 2.31.0+). It also requires either a local bluetooth adapter, or a BLE gateway to be configured - switch on the server's own **Local Bluetooth Adapter** in **Server → Settings → Bluetooth** and monitor it in the **Data -> BLE Manager** page.

#### SignalK server

- **Linux** is required if using a Bluetooth adapter on the server
- MacOS and Windows aren't supported by the [BLE interface layer](https://www.npmjs.com/package/@naugehyde/node-ble) or SignalK BLE API, however they can be used for template development and debugging (everything except `scan` and `paint`)
- Linux isn't a requirement if a BLE Gateway is used, using [SensESP](https://github.com/dirkwa/SensESP)

#### Bluetooth Low Energy (BLE) Integration

##### Local BLE adapter

1. Choosing an adapter

- Bluetooth adapters for Linux can be tricky, TP-Link UB400 and Asus USB-BT500 are two well-known and available ones
- Some Raspberry Pi models come with suitable Bluetooth built in
- Don't worry about the very latest Bluetooth versions, 4.0 is minimum for BLE, 5.0 is nice
- Home Assistant is massively more popular than SignalK, and often also run on Raspberry Pi and similar, so good source of advice

2. `bluez` and `dbus` packages installed

- No need to do this if you have a Raspberry Pi with recent Raspian version, since `bluez` comes built in.
- If you're not running a Raspberry Pi, then ensure that the `dbus` package is installed

3. Choose BLE API or self-managed BLE integration

- SignalK BLE via **Server → Settings → Bluetooth** and **Data -> BLE Manager**
- Or built-in BLE integration by switching off **Use the SignalK BLE Manager API** in the settings

##### BLE Gateway

Buy or build a gateway using [SensESP](https://github.com/dirkwa/SensESP). Ensure the BLE API usage is switched on, in the plugin and the Server Settings.

#### Bluetti Encryption Key

If using a later model that needs encryption, email [service@bluettipower.com](mailto:service@bluettipower.com) to raise a support query for key. Official API site is at see https://github.com/bluetti-official/bluetti-bluetooth-lib.

Key will be in the form of a CSV file, which be stored in your SignalK server, for example in a home directory, and referenced in the Bluetti Monitoring plugin configuration.

### Other uses for BLE

Once you have all of that, it may be worth also installing plugins like [signalk-victron-ble](https://github.com/stefanor/signalk-victron-ble), [signalk-ruuvitag-plugin](https://github.com/vokkim/signalk-ruuvitag-plugin) or [bt-sensors-plugin](https://github.com/naugehyde/bt-sensors-plugin-sk) to pull in data from other sensors and equipment.

## Installation

Look for **Bluetti Monitoring** in the **SignalK AppStore** on your server ( under _Apps & Plugins_ on the latest version).

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

### `dump [mac]`

Connect to a single device by MAC address and print low-level details: name, alias, RSSI, pairing state, manufacturer data, and its raw GATT services/characteristics — including each characteristic's flags (read/write/notify/…) and, for readable ones, its current value as hex. Useful for figuring out a new/unknown device's UUIDs before wiring up a register map. If `mac` is omitted, scans and connects to the first Bluetti-matching device found.

```bash
node cli.js dump aa:bb:cc:dd:ee:ff
node cli.js dump                                   # scan and use the first Bluetti device found
node cli.js dump aa:bb:cc:dd:ee:ff --timeout 30   # discovery timeout if device isn't already known to BlueZ (default: 20)
```

### `info [mac]`

Connect to a device and decode its live register values the same way the plugin itself does — same GATT UUIDs, same encryption handshake (including the AES/ECDH handshake used by "V2"-protocol models like the EL100V2), same register parsing. Requires `--registers`. If `mac` is omitted, scans and connects to the first Bluetti-matching device found.

```bash
# Decode live registers using a bundled device configuration (see devices/*.yaml for available models)
node cli.js info aa:bb:cc:dd:ee:ff --registers ac200p
node cli.js info --registers ac200p                # scan and use the first Bluetti device found

# Or a custom YAML, plus an encryption key file for legacy models that XOR-scramble frames
# (not needed for V2-protocol models — those are auto-detected and handshake automatically)
node cli.js info aa:bb:cc:dd:ee:ff --registers ./my-device-registers.yaml --encryption-key ~/19e1646709e0421b755fa9dda74.csv

node cli.js info aa:bb:cc:dd:ee:ff --registers ac200p --timeout 30   # discovery timeout if device isn't already known to BlueZ (default: 20)
```

### `models`

List every device configuration the CLI (and the plugin) can find — bundled ones plus anything dropped into the custom directory (`~/.signalk/bluetti` by default) — with a field and constant count per model. No device connection needed.

```bash
node cli.js models
```

## FAQ

### Capacity figures show in Joules, how do I make it useful?

SignalK stores all data in SI units rather than any customary units used anywhere, for example temperatures are all held in Kelvin and unit preferences allow them to be converted in the display to C or F.

Unfortunately the default sets of preset unit preferences don't include the `energy` category used for capacity and more unfortunately as of SignalK v2.30.0 there's no easy way to override individual paths.

The fiddly way to do it should be as below (however there's a current [misconfiguration](https://github.com/SignalK/signalk-server/issues/2878) in the SignalK code which gets in the way):

1. Download your preferred set of unit preferences from the [SignalK repo](https://github.com/SignalK/signalk-server/tree/ac368c548fba923db0acf8a314cbdc6552b2b8cf/unitpreferences/presets)
2. Edit the downloaded file

- Change the `targetUnit` of `energy` category to `Wh`
- Change the `name` at the top of the file to reflect the change, for example `"Nautical (Metric, Wh capacity)"`

3. Go to the _Unit Preferences_ section of the _Data_ menu in SignalK
4. Use the _Upload_ button to upload your amended preferences preset and select it in the preset dropdown

### SignalK starts before the Bluetooth daemon — does the plugin need `bluetoothd` running at boot?

The plugin retries BLE adapter initialisation with backoff (starting at 2s, capping at 30s) if `bluetoothd`/D-Bus isn't up yet when the plugin starts, so a slow-starting Bluetooth stack on boot will no longer strand it — it keeps retrying until the adapter appears rather than failing once and giving up. You'll see `BLE adapter not ready … — retrying in Ns …` in the SignalK logs in the meantime.

That said, it's cleaner to fix the boot ordering at the systemd level so the plugin finds the adapter ready on its first attempt. If SignalK runs as a systemd service (`systemctl status signalk`) and its unit file has no `[Unit]` section (check with `systemctl cat signalk`), add one:

```bash
sudo systemctl edit signalk.service
```

This opens an override file — add:

```ini
[Unit]
After=bluetooth.target
Wants=bluetooth.target
```

Save and exit, then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart signalk
```

This tells systemd to start `bluetoothd` first and wait for it before starting SignalK, rather than relying on both racing to start in parallel at boot.

### My station isn't supported

Additional products can be added using a YAML file mapping modbus registers and providing static values — see [`docs/examples/model_definition.yaml`](docs/examples/model_definition.yaml) in the repo for an annotated template, and `devices/*.yaml` for real examples.

Drop your file into the plugin's **Custom Device Configuration Directory** (a plugin setting, defaulting to `~/.signalk/bluetti`) and it'll appear in the **Device Configuration** dropdown for a device, named after the file (without `.yaml`). A file there takes priority over a bundled one of the same name, so it also doubles as a way to override a built-in map.

Check one of these projects to see if some of the mapping work has been done:

- https://github.com/Patrick762/bluetti-bt-lib
- https://github.com/warhammerkid/bluetti_mqtt
