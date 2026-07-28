# SignalK Bluetti Power Station Monitoring

BLE based monitoring. ALPHA status

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