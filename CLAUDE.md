# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies (requires Node.js with native addon support for @stoprocent/noble)
node index.js        # run standalone (limited use — normally loaded by SignalK server)
```

There is no build step, no linter config, and no test suite. The plugin is loaded by the SignalK server from `index.js`.

To exercise the plugin locally, install it into a running SignalK server:
```bash
cd ~/.signalk/node_modules && ln -s /path/to/signalk-bluetti-plugin @rhizomatics/signalk-bluetti-plugin
```

## Architecture

The plugin is a SignalK server plugin (CommonJS module exporting a factory function). `index.js` is the entry point; `lib/` contains the core logic split into five focused modules.

### Data flow

```
Scanner (BLE discovery)
  → index.js (matches discovered peripheral to configured devices)
    → BluettiDevice (BLE GATT connection + Modbus polling loop)
      → protocol.js (frame building, CRC16, XOR decryption, frame reassembly)
        → csv-loader.js (decode typed register values from Map<addr, uint16>)
          → path-mapper.js (convert units to SI, build SignalK delta)
            → app.handleMessage() (publishes to SignalK)
```

### Module responsibilities

- **`index.js`** — Plugin lifecycle (`start`/`stop`), config schema, device orchestration. Lazy-requires all `lib/` modules inside `start()` so dependency load failures surface as plugin errors rather than crashes.

- **`lib/scanner.js`** — Wraps `@stoprocent/noble`. Emits `discovered` (per device) and `scanComplete` (after timeout). Noble cannot scan and connect simultaneously — `index.js` calls `scanner.stopScan()` before handing a peripheral to `BluettiDevice`.

- **`lib/device.js`** — Manages the BLE GATT connection for one device. On connect, subscribes to the notify characteristic (UUID `ff01` / fallback `ffe1`), then starts a polling loop. Each poll sends all register batches sequentially — the next request is sent only after the previous response is received. Reconnects with exponential backoff on disconnect.

- **`lib/protocol.js`** — Modbus RTU over BLE: builds FC03 (read holding registers) requests, validates CRC16 on responses, handles frame reassembly across multiple BLE packets. `groupRegisters()` converts a flat list of register addresses into contiguous batches (max gap 10, max 50 registers/batch) to minimise round-trips.

- **`lib/csv-loader.js`** — Parses register map CSVs with flexible column name aliases (supports both English and Chinese headers from Bluetti's own documentation). Decodes typed values (`uint16`, `int16`, `uint32`, `int32`, `float32`, `bool`) with `scale`/`offset` applied.

- **`lib/path-mapper.js`** — Converts decoded register values to SignalK SI units (°C→K, Wh→J, %→0–1 ratio). Resolves SignalK paths from the CSV's `signalk_path` column, or auto-generates paths from field name keywords as a fallback. Produces a SignalK delta object for `app.handleMessage()`.

### Register maps

CSV files in `registers/` are bundled with the plugin. Each row describes one Modbus holding register: address, data type, scale/offset, unit, and an optional explicit SignalK path. The `{name}` placeholder in SignalK paths is substituted with the per-device name from config.

### Encryption

Some Bluetti models XOR-scramble BLE frames. The key is a 4-line CSV Bluetti provides per device (line 4 is the hex key string). The plugin auto-detects this file in `$HOME` by matching the BLE device name, or the user can configure the path explicitly. `lib/encryption.js` reads the key; `applyXor()` in `protocol.js` applies it symmetrically to both outgoing requests and incoming responses.
