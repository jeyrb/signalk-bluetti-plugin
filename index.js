'use strict';

const os   = require('os');
const path = require('path');
const fs   = require('fs');

const PLUGIN_ID     = 'signalk-bluetti-plugin';
const REGISTERS_DIR = path.join(__dirname, 'registers');

// Bluetti device BLE name prefixes (mirrors scanner.js).
const BLUETTI_PREFIXES = ['BT-TH-', 'BLUETTI', 'AC', 'EP', 'EB', 'EL'];

// Search $HOME for exactly one CSV whose stem looks like a Bluetti device ID.
// Returns the full path if exactly one match, empty string otherwise.
function findBluettiEncryptionCsvInHome() {
  try {
    const homeDir = os.homedir();
    const matches = fs.readdirSync(homeDir).filter(f => {
      if (!f.toLowerCase().endsWith('.csv')) return false;
      const stem = f.slice(0, -4).toUpperCase();
      return BLUETTI_PREFIXES.some(p => stem.startsWith(p));
    });
    return matches.length === 1 ? path.join(os.homedir(), matches[0]) : '';
  } catch (_) {
    return '';
  }
}

function builtinModelNames() {
  try {
    return fs.readdirSync(REGISTERS_DIR)
      .filter(f => f.endsWith('.csv'))
      .map(f => f.replace(/\.csv$/, ''))
      .sort();
  } catch (_) {
    return [];
  }
}

module.exports = function (app) {
  const log = (msg) => app.debug(msg);

  let scanner         = null;
  let activeDevices   = [];
  let scanResultCache = [];

  const builtins = builtinModelNames();

  // ── Plugin metadata ────────────────────────────────────────────────────

  const plugin = {
    id:          PLUGIN_ID,
    name:        'Bluetti Power Station (BLE)',
    description: 'Monitors Bluetti power devices via Bluetooth LE and publishes to electrical.* paths',
  };

  // ── Config schema ──────────────────────────────────────────────────────

  plugin.schema = {
    type: 'object',
    required: [],
    properties: {
      scanOnStart: {
        type: 'boolean',
        title: 'Scan for new devices on plugin start',
        description: 'Runs a 15-second BLE scan and logs discovered Bluetti devices. Useful for finding device addresses.',
        default: true,
      },
      devices: {
        type: 'array',
        title: 'Devices',
        description: 'One entry per Bluetti device you want to monitor.',
        items: {
          type: 'object',
          required: ['address', 'name'],
          properties: {
            enabled: {
              type: 'boolean',
              title: 'Enabled',
              default: true,
            },
            address: {
              type: 'string',
              title: 'BLE MAC address',
              description: 'e.g. aa:bb:cc:dd:ee:ff  — run a scan to find this',
            },
            name: {
              type: 'string',
              title: 'Device name (used in SignalK path)',
              description: 'e.g. "house" → electrical.batteries.house.voltage',
            },
            builtinModel: {
              type: 'string',
              title: 'Built-in register map',
              description: 'Select a bundled register map for your device model, or "custom" to supply your own CSV path below.',
              enum: ['custom', ...builtins],
              default: builtins.length > 0 ? builtins[0] : 'custom',
            },
            csvPath: {
              type: 'string',
              title: 'Custom register map CSV path',
              description: 'Absolute path to a register definition CSV. Only used when "custom" is selected above.',
              default: '',
            },
            encryptionCsvPath: {
              type: 'string',
              title: 'Bluetti encryption CSV path (optional)',
              description: 'Path to the encrypted CSV file provided by Bluetti for your device. Leave blank for unencrypted devices.',
              default: findBluettiEncryptionCsvInHome(),
            },
            pollIntervalSeconds: {
              type: 'number',
              title: 'Poll interval (seconds)',
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
    devices: {
      items: {
        address:           { 'ui:placeholder': 'aa:bb:cc:dd:ee:ff' },
        name:              { 'ui:placeholder': 'house' },
        csvPath:           { 'ui:placeholder': '/home/pi/my-device-registers.csv' },
        encryptionCsvPath: { 'ui:placeholder': '/home/pi/19e1646709e0421b755fa9dda74.csv' },
      },
    },
  };

  // ── Start ──────────────────────────────────────────────────────────────

  plugin.start = function (options) {
    let Scanner, BluettiDevice, loadCsv, buildDelta, readEncryptionKey;
    try {
      Scanner              = require('./lib/scanner');
      BluettiDevice        = require('./lib/device');
      ({ loadCsv }         = require('./lib/csv-loader'));
      ({ buildDelta }      = require('./lib/path-mapper'));
      ({ readEncryptionKey } = require('./lib/encryption'));
    } catch (err) {
      app.setPluginError(`Dependency load failed: ${err.message}. Run: npm install inside the plugin directory.`);
      return;
    }

    scanner = new Scanner(log);

    const devices = (options.devices || []).filter(d => d.enabled !== false);

    if (devices.length === 0) {
      // Discovery-only mode: log anything Bluetti-shaped that appears
      scanner.on('discovered', ({ address, name }) => {
        scanResultCache.push({ address, name });
        app.setPluginStatus(`Discovered: ${name} [${address}] — copy address into plugin config`);
      });
      scanner.on('scanComplete', (found) => {
        if (found.length === 0) app.setPluginStatus('Scan complete — no Bluetti devices found nearby.');
      });
      if (options.scanOnStart !== false) {
        app.setPluginStatus('No devices configured — scanning for Bluetti devices …');
        scanner.startScan(15000);
      } else {
        app.setPluginStatus('No devices configured. Add a device in plugin settings.');
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
    const normalise = (addr) => addr.toLowerCase().replace(/:/g, '');
    const pending   = new Map(devices.map(cfg => [normalise(cfg.address), cfg]));
    const deps      = { BluettiDevice, loadCsv, buildDelta, readEncryptionKey };

    scanner.on('discovered', ({ address, name, device: bleDevice }) => {
      scanResultCache.push({ address, name });
      const cfg = pending.get(normalise(address));
      if (cfg) {
        pending.delete(normalise(address));
        app.setPluginStatus(`Found ${name} [${address}] — connecting …`);
        // Stop our discovery session before connecting (keeps the poll loop quiet).
        // BlueZ handles scan+connect coexistence at the adapter level.
        scanner.stopScan();
        startDevice(cfg, bleDevice, name, deps);
      } else {
        log(`Discovered unconfigured Bluetti device: ${name} [${address}]`);
      }
    });

    scanner.on('scanComplete', () => {
      if (pending.size > 0) {
        const missing = [...pending.values()].map(c => `${c.name} [${c.address}]`).join(', ');
        app.setPluginStatus(`Waiting for device(s): ${missing} — rescanning …`);
        setTimeout(() => {
          if (pending.size > 0 && scanner) scanner.startScan(30000);
        }, 5000);
      }
    });

    app.setPluginStatus(`Scanning for ${devices.length} configured device(s) …`);
    scanner.startScan(30000);
  };

  // Search $HOME for an encryption CSV for bleName.
  // Priority: 1) <bleName>.csv  2) bluetti_device_licence.csv
  function findEncryptionCsvInHome(bleName) {
    const homeDir = os.homedir();
    try {
      const files = fs.readdirSync(homeDir);
      const specific = files.find(f => f.toLowerCase() === `${bleName.toLowerCase()}.csv`);
      if (specific) return path.join(homeDir, specific);
      const generic = files.find(f => f.toLowerCase() === 'bluetti_device_licence.csv');
      if (generic) return path.join(homeDir, generic);
    } catch (_) {}
    return null;
  }

  function validateEncryptionCsvPath(csvPath, deviceName) {
    try {
      fs.accessSync(csvPath, fs.constants.R_OK);
    } catch (_) {
      return `[${deviceName}] Encryption CSV not found or not readable: ${csvPath}`;
    }
    let lines;
    try {
      lines = fs.readFileSync(csvPath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
    } catch (err) {
      return `[${deviceName}] Could not read encryption CSV "${csvPath}": ${err.message}`;
    }
    if (lines[0] !== 'bluetti') {
      return `[${deviceName}] Encryption CSV does not look like a Bluetti key file (expected first line "bluetti"): ${csvPath}`;
    }
    if (lines.length < 4) {
      return `[${deviceName}] Encryption CSV is missing the key line (expected 4 lines): ${csvPath}`;
    }
    return null;
  }

  function resolveRegisterMapPath(cfg) {
    const { builtinModel, csvPath } = cfg;
    if (!builtinModel || builtinModel === 'custom') {
      if (!csvPath) throw new Error('No register map: select a built-in model or provide a custom CSV path');
      return csvPath;
    }
    return path.join(REGISTERS_DIR, `${builtinModel}.csv`);
  }

  function startDevice(cfg, bleDevice, bleName, { BluettiDevice, loadCsv, buildDelta, readEncryptionKey }) {
    const { address, name, encryptionCsvPath = '', pollIntervalSeconds = 10 } = cfg;

    let registerPath;
    try {
      registerPath = resolveRegisterMapPath(cfg);
    } catch (err) {
      app.setPluginError(`[${name}] ${err.message}`);
      return;
    }

    let fields;
    try {
      fields = loadCsv(registerPath);
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

    device.on('connected', () => {
      app.setPluginStatus(`Connected to ${name} [${address}]`);
    });

    device.on('registers', (registers) => {
      const delta = buildDelta(registers, fields, name, PLUGIN_ID);
      if (delta) app.handleMessage(PLUGIN_ID, delta);
    });

    device.start();
    activeDevices.push(device);
  }

  // ── Stop ───────────────────────────────────────────────────────────────

  plugin.stop = function () {
    activeDevices.forEach(d => d.stop());
    activeDevices = [];
    if (scanner) {
      scanner.stopAll();
      scanner = null;
    }
    scanResultCache = [];
  };

  return plugin;
};
