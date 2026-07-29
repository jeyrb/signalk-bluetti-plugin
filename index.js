"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");

const PLUGIN_ID = "signalk-bluetti-plugin";
const REGISTERS_DIR = path.join(__dirname, "registers");

// Bluetti device BLE name prefixes (mirrors scanner.js).
const BLUETTI_PREFIXES = ["BT-TH-", "BLUETTI", "AC", "EP", "EB", "EL", "PR", "AP"];

// Search $HOME for exactly one CSV whose stem looks like a Bluetti device ID.
// Returns the full path if exactly one match, empty string otherwise.
function findBluettiEncryptionCsvInHome() {
  try {
    const homeDir = os.homedir();
    const matches = fs.readdirSync(homeDir).filter((f) => {
      if (!f.toLowerCase().endsWith(".csv")) return false;
      const stem = f.slice(0, -4).toUpperCase();
      return BLUETTI_PREFIXES.some((p) => stem.startsWith(p));
    });
    return matches.length === 1 ? path.join(os.homedir(), matches[0]) : "";
  } catch {
    return "";
  }
}

function yamlModelNames(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => f.replace(/\.ya?ml$/, ""))
      .sort();
  } catch {
    return [];
  }
}

// The directory a user can drop their own register map YAML files into,
// without needing to fork/publish the plugin — defaults to a `bluetti`
// subdirectory of the SignalK home directory (e.g. ~/.signalk/bluetti).
// `app.config.configPath` isn't part of the documented plugin API but is the
// long-established way plugins locate the SignalK home directory.
function defaultUserRegistersDir(app) {
  const home = app && app.config && app.config.configPath;
  return home ? path.join(home, "bluetti") : null;
}

module.exports = function (app) {
  const log = (msg) => app.debug(msg);

  let scanner = null;
  let activeDevices = [];
  let scanResultCache = [];
  let waitingStatusTimer = null;

  const defaultUserDir = defaultUserRegistersDir(app);
  const builtins = yamlModelNames(REGISTERS_DIR);
  // Models available for the dropdown at schema-render time — bundled plus
  // whatever's already sitting in the default user directory. If `registersDir`
  // is overridden away from the default, models unique to that directory won't
  // appear here until the plugin restarts with the new setting saved.
  const allModels = [...new Set([...builtins, ...(defaultUserDir ? yamlModelNames(defaultUserDir) : [])])].sort((a, b) =>
    a.localeCompare(b),
  );

  // ── Plugin metadata ────────────────────────────────────────────────────

  const plugin = {
    id: PLUGIN_ID,
    name: "Bluetti Power Station (BLE)",
    description: "Monitors Bluetti power devices via Bluetooth LE and publishes to electrical.* paths",
  };

  // ── Config schema ──────────────────────────────────────────────────────

  plugin.schema = {
    type: "object",
    required: [],
    properties: {
      scanOnStart: {
        type: "boolean",
        title: "Scan for new devices on plugin start",
        description: "Runs a 15-second BLE scan and logs discovered Bluetti devices. Useful for finding device addresses.",
        default: true,
      },
      registersDir: {
        type: "string",
        title: "Custom register maps directory",
        description: `Directory to scan for your own register map YAML files (e.g. for a model this plugin doesn't bundle yet), in addition to the ones built in. Leave blank to use the default: ${defaultUserDir || "<SignalK home>/bluetti"}.`,
        default: "",
      },
      devices: {
        type: "array",
        title: "Devices",
        description: "One entry per Bluetti device you want to monitor.",
        items: {
          type: "object",
          required: ["address", "name"],
          properties: {
            enabled: {
              type: "boolean",
              title: "Enabled",
              default: true,
            },
            address: {
              type: "string",
              title: "BLE MAC address",
              description: "e.g. aa:bb:cc:dd:ee:ff  — run a scan to find this",
            },
            name: {
              type: "string",
              title: "Device name (used in SignalK path)",
              description: 'e.g. "house" → electrical.batteries.house.voltage',
            },
            builtinModel: {
              type: "string",
              title: "Register map",
              description:
                'Select a register map for your device model — bundled with the plugin, or dropped into the custom register maps directory above — or "custom" to supply an explicit YAML file path below.',
              enum: ["custom", ...allModels],
              default: allModels.length > 0 ? allModels[0] : "custom",
            },
            registerMapPath: {
              type: "string",
              title: "Custom register map YAML path",
              description: 'Absolute path to a register map YAML file. Only used when "custom" is selected above.',
              default: "",
            },
            encryptionCsvPath: {
              type: "string",
              title: "Bluetti encryption CSV path (optional)",
              description: "Path to the encrypted CSV file provided by Bluetti for your device. Leave blank for unencrypted devices.",
              default: findBluettiEncryptionCsvInHome(),
            },
            pollIntervalSeconds: {
              type: "number",
              title: "Poll interval (seconds)",
              default: 10,
              minimum: 2,
            },
          },
        },
        default: [],
      },
    },
  };

  plugin.uiSchema = {
    registersDir: { "ui:placeholder": defaultUserDir || "e.g. /home/pi/.signalk/bluetti" },
    devices: {
      items: {
        address: { "ui:placeholder": "aa:bb:cc:dd:ee:ff" },
        name: { "ui:placeholder": "house" },
        registerMapPath: { "ui:placeholder": "e.g. /path/to/my-device-registers.yaml" },
        encryptionCsvPath: { "ui:placeholder": "e.g. /path/to/19e1646709e0421b755fa9dda74.csv" },
      },
    },
  };

  // ── Start ──────────────────────────────────────────────────────────────

  plugin.start = function (options) {
    let Scanner, BluettiDevice, loadRegisters, buildDelta, readEncryptionKey;
    try {
      Scanner = require("./lib/scanner");
      BluettiDevice = require("./lib/device");
      ({ loadRegisters } = require("./lib/register-loader"));
      ({ buildDelta } = require("./lib/path-mapper"));
      ({ readEncryptionKey } = require("./lib/encryption"));
    } catch (err) {
      app.setPluginError(`Dependency load failed: ${err.message}. Run: npm install inside the plugin directory.`);
      return;
    }

    const userRegistersDir = options.registersDir || defaultUserDir;
    if (userRegistersDir) {
      try {
        fs.mkdirSync(userRegistersDir, { recursive: true });
      } catch (err) {
        log(`Could not create custom register maps directory "${userRegistersDir}": ${err.message}`);
      }
    }

    scanner = new Scanner(log);

    const devices = (options.devices || []).filter((d) => d.enabled !== false);

    if (devices.length === 0) {
      // Discovery-only mode: log anything Bluetti-shaped that appears
      scanner.on("discovered", ({ address, name }) => {
        scanResultCache.push({ address, name });
        app.setPluginStatus(`Discovered: ${name} [${address}] — copy address into plugin config`);
      });
      scanner.on("scanComplete", (found) => {
        if (found.length === 0) app.setPluginStatus("Scan complete — no Bluetti devices found nearby.");
      });
      if (options.scanOnStart !== false) {
        app.setPluginStatus("No devices configured — scanning for Bluetti devices …");
        void scanner.startScan(15000);
      } else {
        app.setPluginStatus("No devices configured. Add a device in plugin settings.");
      }
      return;
    }

    // Validate any explicitly-configured encryption CSV paths up front.
    for (const cfg of devices) {
      if (cfg.encryptionCsvPath) {
        const err = validateEncryptionCsvPath(cfg.encryptionCsvPath, cfg.name);
        if (err) {
          app.setPluginError(err);
          return;
        }
      }
    }

    // Build address → cfg lookup (normalise to lowercase, no colons)
    const normalise = (addr) => addr.toLowerCase().replace(/:/g, "");
    const pending = new Map(devices.map((cfg) => [normalise(cfg.address), cfg]));
    const deps = { BluettiDevice, loadRegisters, buildDelta, readEncryptionKey, userRegistersDir };

    scanner.on("discovered", ({ address, name, device: bleDevice }) => {
      scanResultCache.push({ address, name });
      const cfg = pending.get(normalise(address));
      if (cfg) {
        pending.delete(normalise(address));
        app.setPluginStatus(`Found ${name} [${address}] — connecting …`);
        startDevice(cfg, bleDevice, name, deps);
        if (pending.size === 0) {
          clearInterval(waitingStatusTimer);
          waitingStatusTimer = null;
          // All configured devices found — release our discovery session.
          // BlueZ handles scan+connect coexistence at the adapter level, so this
          // doesn't affect the just-started connection.
          scanner.stopScan();
        }
      } else {
        log(`Discovered unconfigured Bluetti device: ${name} [${address}]`);
      }
    });

    // Periodic status update only — does not touch the scan/discovery session,
    // which is left running continuously (see startScan(null) below) so we don't
    // repeatedly tear down and restart BlueZ discovery shared with other plugins.
    waitingStatusTimer = setInterval(() => {
      if (pending.size > 0) {
        const missing = [...pending.values()].map((c) => `${c.name} [${c.address}]`).join(", ");
        app.setPluginStatus(`Waiting for device(s): ${missing} …`);
      }
    }, 30000);

    app.setPluginStatus(`Scanning for ${devices.length} configured device(s) …`);
    void scanner.startScan(null);
  };

  // Search $HOME for an encryption CSV for bleName.
  // Priority: 1) <bleName>.csv  2) bluetti_device_licence.csv
  function findEncryptionCsvInHome(bleName) {
    const homeDir = os.homedir();
    try {
      const files = fs.readdirSync(homeDir);
      const specific = files.find((f) => f.toLowerCase() === `${bleName.toLowerCase()}.csv`);
      if (specific) return path.join(homeDir, specific);
      const generic = files.find((f) => f.toLowerCase() === "bluetti_device_licence.csv");
      if (generic) return path.join(homeDir, generic);
    } catch {}
    return null;
  }

  function validateEncryptionCsvPath(csvPath, deviceName) {
    try {
      fs.accessSync(csvPath, fs.constants.R_OK);
    } catch {
      return `[${deviceName}] Encryption CSV not found or not readable: ${csvPath}`;
    }
    let lines;
    try {
      lines = fs
        .readFileSync(csvPath, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch (err) {
      return `[${deviceName}] Could not read encryption CSV "${csvPath}": ${err.message}`;
    }
    if (lines[0] !== "bluetti") {
      return `[${deviceName}] Encryption CSV does not look like a Bluetti key file (expected first line "bluetti"): ${csvPath}`;
    }
    if (lines.length < 4) {
      return `[${deviceName}] Encryption CSV is missing the key line (expected 4 lines): ${csvPath}`;
    }
    return null;
  }

  // Finds <model>.yaml (or .yml), checking the custom directory before the
  // bundled one so a user's own file can override a built-in of the same name.
  function findModelFile(model, userRegistersDir) {
    const dirs = [userRegistersDir, REGISTERS_DIR].filter(Boolean);
    for (const dir of dirs) {
      for (const ext of [".yaml", ".yml"]) {
        const p = path.join(dir, `${model}${ext}`);
        if (fs.existsSync(p)) return p;
      }
    }
    return null;
  }

  function resolveRegisterMapPath(cfg, userRegistersDir) {
    const { builtinModel, registerMapPath } = cfg;
    if (!builtinModel || builtinModel === "custom") {
      if (!registerMapPath) throw new Error("No register map: select a model or provide a custom YAML path");
      return registerMapPath;
    }
    const found = findModelFile(builtinModel, userRegistersDir);
    if (!found)
      throw new Error(
        `Register map "${builtinModel}" not found (checked ${userRegistersDir ? `${userRegistersDir} and ` : ""}${REGISTERS_DIR})`,
      );
    return found;
  }

  function startDevice(cfg, bleDevice, bleName, { BluettiDevice, loadRegisters, buildDelta, readEncryptionKey, userRegistersDir }) {
    const { address, name, encryptionCsvPath = "", pollIntervalSeconds = 10 } = cfg;
    const registerCache = new Map(); // last-known value per field_name, across polls — see buildDelta

    let registerPath;
    try {
      registerPath = resolveRegisterMapPath(cfg, userRegistersDir);
    } catch (err) {
      app.setPluginError(`[${name}] ${err.message}`);
      return;
    }

    let fields;
    try {
      fields = loadRegisters(registerPath);
      log(`[${name}] Loaded ${fields.length} registers from ${registerPath}`);
    } catch (err) {
      app.setPluginError(`[${name}] Failed to load register map "${registerPath}": ${err.message}`);
      return;
    }

    let effectiveEncryptionPath = encryptionCsvPath;
    if (!effectiveEncryptionPath && bleName) {
      const autoPath = findEncryptionCsvInHome(bleName);
      if (autoPath) {
        effectiveEncryptionPath = autoPath;
        log(`[${name}] Auto-detected encryption CSV for ${bleName}: ${autoPath}`);
      }
    }

    let xorKey = null;
    if (effectiveEncryptionPath) {
      try {
        xorKey = readEncryptionKey(effectiveEncryptionPath);
        log(`[${name}] Loaded encryption key from ${effectiveEncryptionPath}`);
      } catch (err) {
        app.setPluginError(`[${name}] Failed to read encryption key: ${err.message}`);
        return;
      }
    }

    const device = new BluettiDevice({
      address,
      name,
      device: bleDevice,
      fields,
      pollIntervalMs: pollIntervalSeconds * 1000,
      xorKey,
      log,
    });

    device.on("connected", () => {
      app.setPluginStatus(`Connected to ${name} [${address}]`);
    });

    device.on("registers", (registers) => {
      const delta = buildDelta(registers, fields, name, PLUGIN_ID, { cache: registerCache });
      if (delta) app.handleMessage(PLUGIN_ID, delta);
    });

    device.start();
    activeDevices.push(device);
  }

  // ── Stop ───────────────────────────────────────────────────────────────

  plugin.stop = function () {
    activeDevices.forEach((d) => d.stop());
    activeDevices = [];
    if (waitingStatusTimer) {
      clearInterval(waitingStatusTimer);
      waitingStatusTimer = null;
    }
    if (scanner) {
      scanner.stopAll();
      scanner = null;
    }
    scanResultCache = [];
  };

  return plugin;
};
