#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const REGISTERS_DIR = path.join(__dirname, "registers");

function listBuiltinModels() {
  try {
    return fs
      .readdirSync(REGISTERS_DIR)
      .filter((f) => f.endsWith(".csv"))
      .map((f) => f.replace(/\.csv$/, ""))
      .sort();
  } catch {
    return [];
  }
}

function usage() {
  const builtins = listBuiltinModels();
  console.log(`
Bluetti BLE CLI — scan for and inspect Bluetti power stations.

Usage: bluetti-cli <command> [options]

Commands:
  scan                        Scan for Bluetti devices
    --all                       Also show non-Bluetti BLE devices
    --timeout <seconds>          Scan duration (default: 15)

  dump [mac]                   Connect to a device and print its raw GATT
                                services/characteristics, with flags and
                                readable values (low-level inspection)
                                If mac is omitted, scans and uses the first
                                Bluetti device found.
    --timeout <seconds>          Discovery/scan timeout if not already known (default: 20)

  info [mac]                   Connect and decode live registers the same way
                                the plugin does
                                If mac is omitted, scans and uses the first
                                Bluetti device found.
    --registers <model|path>     Built-in model (${builtins.join(", ") || "none bundled"}) or a CSV path (required)
    --encryption-key <path>      Path to the Bluetti-provided encryption CSV
                                  (only needed for legacy XOR-scrambled models)
    --timeout <seconds>          Discovery/scan timeout if not already known (default: 20)

  help                         Show this help

Examples:
  bluetti-cli scan
  bluetti-cli scan --all --timeout 30
  bluetti-cli dump aa:bb:cc:dd:ee:ff
  bluetti-cli dump
  bluetti-cli info aa:bb:cc:dd:ee:ff --registers ac200p
  bluetti-cli info --registers ac200p
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function printTable(rows, columns) {
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join("  ");
  console.log(line(columns.map((c) => c.toUpperCase())));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(columns.map((c) => row[c] ?? "")));
}

// ── scan ─────────────────────────────────────────────────────────────────

async function cmdScan(args) {
  const Scanner = require("./lib/scanner");
  const all = !!args.all;
  const timeoutMs = (args.timeout ? parseFloat(args.timeout) : 15) * 1000;

  const scanner = new Scanner((msg) => console.error(`[scan] ${msg}`), { includeAll: all });
  const rows = [];

  scanner.on("discovered", ({ address, name, isBluetti }) => {
    rows.push({ address, name: name || "(unnamed)", bluetti: isBluetti ? "yes" : "no" });
  });

  await new Promise((resolve) => {
    scanner.once("scanComplete", resolve);
    scanner.once("error", resolve);
    void scanner.startScan(timeoutMs);
  });
  scanner.stopAll();

  if (rows.length === 0) {
    console.log(all ? "No BLE devices found." : "No Bluetti devices found. Try --all to see every BLE device nearby.");
    return;
  }

  printTable(rows, all ? ["address", "name", "bluetti"] : ["address", "name"]);
}

// ── info ─────────────────────────────────────────────────────────────────

async function findDevice(adapter, mac, timeoutMs) {
  try {
    return await adapter.getDevice(mac);
  } catch {
    // Not yet known to BlueZ — fall through to an active scan below.
  }

  const startedDiscovery = !(await adapter.isDiscovering());
  if (startedDiscovery) await adapter.startDiscovery();

  try {
    return await adapter.waitDevice(mac, timeoutMs, 1000);
  } catch (err) {
    if (/timed out/i.test(err.message)) return null;
    throw err;
  } finally {
    if (startedDiscovery) await adapter.stopDiscovery().catch(() => {});
  }
}

function resolveRegistersArg(value) {
  const builtinPath = path.join(REGISTERS_DIR, `${value}.csv`);
  if (fs.existsSync(builtinPath)) return builtinPath;
  if (fs.existsSync(value)) return value;
  const builtins = listBuiltinModels();
  throw new Error(`Register map not found: "${value}" (not a built-in model [${builtins.join(", ")}] or an existing file path)`);
}

async function printDeviceSummary(bleDevice, mac) {
  const { isBluettiDevice } = require("./lib/scanner");

  const [name, alias, addressType, rssi, paired] = await Promise.all([
    bleDevice.getName().catch(() => null),
    bleDevice.getAlias().catch(() => null),
    bleDevice.getAddressType().catch(() => null),
    bleDevice.getRSSI().catch(() => null),
    bleDevice.isPaired().catch(() => null),
  ]);

  console.log(`Name:          ${name || "(unknown)"}`);
  if (alias && alias !== name) console.log(`Alias:         ${alias}`);
  console.log(`Address:       ${mac}`);
  if (addressType) console.log(`Address type:  ${addressType}`);
  if (rssi !== null && rssi !== undefined) console.log(`RSSI:          ${rssi} dBm`);
  if (paired !== null) console.log(`Paired:        ${paired ? "yes" : "no"}`);
  console.log(`Bluetti match: ${isBluettiDevice(name) ? "yes" : "no"}`);

  let manufacturerData = null;
  try {
    manufacturerData = await bleDevice.getManufacturerData();
  } catch {}
  if (manufacturerData && Object.keys(manufacturerData).length > 0) {
    console.log("Manufacturer data:");
    for (const [id, data] of Object.entries(manufacturerData)) {
      console.log(`  ${id}: ${Buffer.isBuffer(data) ? data.toString("hex") : JSON.stringify(data)}`);
    }
  }
}

async function printGattTree(bleDevice) {
  const alreadyConnected = await bleDevice.isConnected().catch(() => false);
  console.log(`\n${alreadyConnected ? "Already connected" : "Connecting…"}`);
  if (!alreadyConnected) await bleDevice.connect();

  try {
    console.log("Discovering GATT services…\n");
    const gatt = await bleDevice.gatt();
    const serviceUuids = await gatt.services();
    if (serviceUuids.length === 0) console.log("No GATT services discovered.");
    for (const uuid of serviceUuids) {
      console.log(`Service ${uuid}`);
      const service = await gatt.getPrimaryService(uuid);
      const charUuids = await service.characteristics();
      for (const cUuid of charUuids) {
        const characteristic = await service.getCharacteristic(cUuid);
        const flags = await characteristic.getFlags().catch(() => []);

        let valueStr = "";
        if (flags.includes("read")) {
          try {
            const value = await characteristic.readValue();
            valueStr = ` = ${value.length ? value.toString("hex") : "(empty)"}`;
          } catch (err) {
            valueStr = ` = (read failed: ${err.message})`;
          }
        }
        console.log(`  Characteristic ${cUuid} [${flags.join(", ") || "?"}]${valueStr}`);
      }
    }
  } finally {
    if (!alreadyConnected) await bleDevice.disconnect().catch(() => {});
  }
}

async function printRegisterValues(bleDevice, mac, args) {
  const { loadCsv, decodeValue } = require("./lib/csv-loader");
  const { resolvePath, convertUnits } = require("./lib/path-mapper");
  const { readEncryptionKey } = require("./lib/encryption");
  const { groupRegisters } = require("./lib/protocol");
  const BluettiDevice = require("./lib/device");

  const registerPath = resolveRegistersArg(args.registers);
  const fields = loadCsv(registerPath);
  console.log(`\nLoaded ${fields.length} register field(s) from ${registerPath}`);

  const addrs = [...new Set(fields.flatMap((f) => Array.from({ length: f.count }, (_, i) => f.register + i)))];
  const expectedBatches = groupRegisters(addrs).length;

  let xorKey = null;
  if (args["encryption-key"]) {
    xorKey = readEncryptionKey(args["encryption-key"]);
    console.log(`Loaded encryption key from ${args["encryption-key"]}`);
  }

  const device = new BluettiDevice({
    address: mac,
    name: mac,
    device: bleDevice,
    fields,
    pollIntervalMs: 3600000, // CLI only needs a single pass — see below
    xorKey,
    log: (msg) => console.error(`[device] ${msg}`),
  });

  console.log("\nConnecting and polling registers (one pass)…\n");

  const allRegisters = new Map();
  let received = 0;
  const timeoutMs = (args.timeout ? parseFloat(args.timeout) : 30) * 1000;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for register data")), timeoutMs);
    device.on("registers", (regs) => {
      for (const [addr, val] of regs) allRegisters.set(addr, val);
      received++;
      if (received >= expectedBatches) {
        clearTimeout(timer);
        resolve();
      }
    });
    device.start();
  });
  device.stop();

  const rows = [];
  for (const field of fields) {
    const raw = decodeValue(field, allRegisters);
    if (raw === null) continue;
    rows.push({
      register: field.register,
      field: field.fieldName,
      type: field.dataType,
      value: convertUnits(raw, field.unit),
      unit: field.unit || "",
      path: resolvePath(field, mac),
    });
  }

  if (rows.length === 0) {
    console.log("No register values decoded from the response.");
  } else {
    printTable(rows, ["register", "field", "type", "value", "unit", "path"]);
  }
}

// Scans for the first Bluetti-matching device and resolves its address, or
// null if none turned up before durationMs. Used to default `[mac]` CLI
// arguments when the user doesn't already know the address.
async function findFirstBluettiAddress(durationMs, log) {
  const Scanner = require("./lib/scanner");
  const scanner = new Scanner(log, { includeAll: false });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      scanner.stopAll();
      resolve(result);
    };
    scanner.once("discovered", ({ address, name }) => finish({ address, name }));
    scanner.once("scanComplete", () => finish(null));
    scanner.once("error", () => finish(null));
    void scanner.startScan(durationMs);
  });
}

async function withConnectedDevice(args, usageLine, body) {
  let mac = args._[0];
  const timeoutMs = (args.timeout ? parseFloat(args.timeout) : 20) * 1000;

  if (!mac) {
    console.error(`No MAC address given — scanning for a Bluetti device (up to ${timeoutMs / 1000}s)…`);
    const found = await findFirstBluettiAddress(timeoutMs, (msg) => console.error(`[scan] ${msg}`));
    if (!found) {
      console.error(`No Bluetti device found. Usage: ${usageLine}`);
      process.exitCode = 1;
      return;
    }
    mac = found.address;
    console.error(`Found ${found.name || "(unnamed)"} [${mac}]`);
  }

  const { createBluetooth } = require("@naugehyde/node-ble");
  const bt = createBluetooth();

  try {
    const adapter = await bt.bluetooth.defaultAdapter();
    const bleDevice = await findDevice(adapter, mac, timeoutMs);
    if (!bleDevice) {
      console.error(`Device ${mac} not found (scanned for ${timeoutMs / 1000}s).`);
      process.exitCode = 1;
      return;
    }

    await printDeviceSummary(bleDevice, mac);
    await body(bleDevice, mac);
  } finally {
    try {
      bt.destroy();
    } catch {}
  }
}

async function cmdDump(args) {
  await withConnectedDevice(args, "bluetti-cli dump [mac]", (bleDevice) => printGattTree(bleDevice));
}

async function cmdInfo(args) {
  if (!args.registers) {
    console.error("Error: --registers <model|path> is required. Usage: bluetti-cli info [mac] --registers <model|path>");
    process.exitCode = 1;
    return;
  }
  await withConnectedDevice(args, "bluetti-cli info [mac] --registers <model|path>", (bleDevice, mac) =>
    printRegisterValues(bleDevice, mac, args),
  );
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);

  switch (command) {
    case "scan":
      await cmdScan(args);
      break;
    case "dump":
      await cmdDump(args);
      break;
    case "info":
      await cmdInfo(args);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      usage();
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      usage();
      process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
