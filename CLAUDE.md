# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install              # install dependencies (requires Node.js with native addon support for @naugehyde/node-ble)
node index.js            # run standalone (limited use — normally loaded by SignalK server)
npm test                 # run the test suite (node:test, no extra deps)
npm run test:coverage    # same, plus coverage report with 80% line/branch/function thresholds
npm run lint             # oxlint
npm run fmt:check        # oxfmt --check
```

There is no build step. The plugin is loaded by the SignalK server from `index.js`.

Tests live in `test/*.test.js` and cover the deterministic core — `lib/protocol.js`, `lib/csv-loader.js`, `lib/path-mapper.js`, `lib/encryption.js`, `lib/v2-encryption.js` — plus an end-to-end regression check against the real bundled `registers/*.csv` files. `lib/device.js` and `lib/scanner.js` are BLE-hardware integration glue and are excluded from the coverage target (`test:coverage`'s `--test-coverage-exclude`) rather than mocked.

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

- **`lib/scanner.js`** — Wraps `@naugehyde/node-ble` (BlueZ D-Bus). Calls `adapter.startDiscovery()` then polls `adapter.devices()` every second, emitting `discovered` (per Bluetti device found) and `scanComplete` (after timeout). Uses `device: <node-ble Device>` in the discovered payload (not `peripheral`).

- **`lib/device.js`** — Manages the BLE GATT connection for one device via the `node-ble` Device object (D-Bus backed, persists across disconnects — no rescan needed on reconnect). On connect, calls `device.gatt()` → `getPrimaryService()` → `getCharacteristic()` → `startNotifications()`, then starts a polling loop. Each poll sends all register batches sequentially — the next request is sent only after the previous response is received. Reconnects with exponential backoff by calling `device.connect()` again on the same object. After subscribing, waits up to `HANDSHAKE_DETECT_MS` for a spontaneous V2 handshake CHALLENGE (see Encryption below) before assuming the plain/XOR protocol and starting to poll.

- **`lib/protocol.js`** — Modbus RTU over BLE: builds FC03 (read holding registers) requests, validates CRC16 on responses, handles frame reassembly across multiple BLE packets. `groupRegisters()` converts a flat list of register addresses into contiguous batches (max gap 10, max 50 registers/batch) to minimise round-trips.

- **`lib/csv-loader.js`** — Parses register map CSVs with flexible column name aliases (supports both English and Chinese headers from Bluetti's own documentation). Decodes typed values (`uint16`, `int16`, `uint32`, `int32`, `float32`, `bool`) with `scale`/`offset` applied. A row with no `register_address` and a `constant_value` instead is a fixed, non-register fact about the device (e.g. nominal capacity, chemistry) — `decodeValue()` returns it as-is (numeric constants still go through the same unit conversion as register-backed fields; text constants don't).

- **`lib/path-mapper.js`** — Converts decoded values to SignalK SI units (°C→K, Wh→J, %→0–1 ratio). Resolves SignalK paths for a field in priority order: the CSV's `signalk_path` column (override, only needed for a register the code doesn't recognise) → the `STANDARD_FIELD_PATHS` registry keyed by `field_name` (covers all the well-known Bluetti register names — this is what bundled CSVs rely on, so they only need to list `field_name` + register info) → a best-effort keyword guess (`autoPath()`) as a last resort. Also derives values Bluetti doesn't report directly, using a per-device cache (`opts.cache`, owned by the caller) to remember each field's last-known value across polls/batches: AC-input current from power÷voltage (unless a real current register exists), DC-output-port current from power÷a CSV-supplied fixed voltage, and remaining battery capacity from nominal capacity × state of charge. Produces a SignalK delta object for `app.handleMessage()`.

### Register maps

CSV files in `registers/` are bundled with the plugin. Each row describes either one Modbus holding register (address, data type, scale/offset, unit) or, if `register_address` is left blank, a fixed constant (`constant_value`) — e.g. a model's nominal capacity, chemistry, or manufacturer info. `field_name` should be one of the standard names `lib/path-mapper.js` recognises wherever possible, since the SignalK path is then resolved by the code; `signalk_path` is an override column for exposing a register the code doesn't know about. The `{name}` placeholder in an explicit `signalk_path` is substituted with the per-device name from config.

### Encryption

Two unrelated schemes exist across Bluetti's device generations, both handled by `lib/device.js`:

- **Legacy XOR** — some models scramble BLE frames with a simple per-device XOR key. The key comes from a 4-line CSV Bluetti provides per device (line 4 is the hex key string). The plugin auto-detects this file in `$HOME` by matching the BLE device name, or the user can configure the path explicitly. `lib/encryption.js` reads the key; `applyXor()` in `protocol.js` applies it symmetrically to both outgoing requests and incoming responses.

- **V2 protocol** (EL100V2, EL30V2, PR100V2, PR30V2, ...) — these reject plaintext/XOR frames outright and require a real handshake: an ECDSA-signed ephemeral ECDH key exchange (secp256r1) bootstrapped by an AES-128-CBC "unsecure" key derived from a device-sent challenge, followed by AES-256-CBC for the session. Unlike the legacy scheme, this needs no per-device secret — it uses fixed constants common to all V2 devices. `lib/v2-encryption.js` implements the wire protocol and crypto (Node's built-in `crypto`, no new deps); `lib/device.js` detects it at runtime by waiting briefly after subscribing for a spontaneous handshake CHALLENGE, falling back to the legacy/plain path if none arrives. Ported from the wire format documented by `Patrick762/bluetti-bt-lib`, itself based on `nhurman/bluetti_mqtt` — validated against a real EL100V2's captured CHALLENGE frame before use.
