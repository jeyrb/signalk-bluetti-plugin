'use strict';

const path = require('path');
const fs   = require('fs');

const PLUGIN_ID     = 'signalk-bluetti-plugin';
const REGISTERS_DIR = path.join(__dirname, 'registers');

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

  let scanner       = null;
  let activeDevices = [];
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
              default: '',
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

    scanner.on('discovered', ({ address, name }) => {
      scanResultCache.push({ address, name });
      app.setPluginStatus(`Discovered: ${name} [${address}] — copy address into plugin config`);
    });

    scanner.on('scanComplete', (found) => {
      if (found.length === 0) {
        app.setPluginStatus('Scan complete — no Bluetti devices found nearby.');
      } else {
        const list = found.map(d => `${d.name} [${d.address}]`).join(', ');
        app.setPluginStatus(`Scan complete. Found: ${list}`);
      }
    });

    const devices = (options.devices || []).filter(d => d.enabled !== false);

    if (devices.length === 0) {
      if (options.scanOnStart !== false) {
        app.setPluginStatus('No devices configured — scanning for Bluetti devices …');
        scanner.startScan(15000);
      } else {
        app.setPluginStatus('No devices configured. Add a device in plugin settings.');
      }
      return;
    }

    if (options.scanOnStart !== false) {
      scanner.startScan(15000);
    }

    for (const cfg of devices) {
      startDevice(cfg, { BluettiDevice, loadCsv, buildDelta, readEncryptionKey });
    }

    app.setPluginStatus(`Connecting to ${devices.length} device(s) …`);
  };

  function resolveRegisterMapPath(cfg) {
    const { builtinModel, csvPath } = cfg;
    if (!builtinModel || builtinModel === 'custom') {
      if (!csvPath) throw new Error('No register map: select a built-in model or provide a custom CSV path');
      return csvPath;
    }
    return path.join(REGISTERS_DIR, `${builtinModel}.csv`);
  }

  function startDevice(cfg, { BluettiDevice, loadCsv, buildDelta, readEncryptionKey }) {
    const { address, name, encryptionCsvPath = '', pollIntervalSeconds = 10 } = cfg;

    if (!address || !name) {
      log('Skipping device — missing address or name');
      return;
    }

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

    let xorKey = null;
    if (encryptionCsvPath) {
      try {
        xorKey = readEncryptionKey(encryptionCsvPath);
        log(`[${name}] Loaded encryption key from ${encryptionCsvPath}`);
      } catch (err) {
        app.setPluginError(`[${name}] Failed to read encryption key: ${err.message}`);
        return;
      }
    }

    const peripheral = getPeripheral(address);
    if (!peripheral) {
      app.setPluginError(`[${name}] No BLE peripheral for ${address}. Enable "Scan on start" and restart.`);
      return;
    }

    const device = new BluettiDevice({
      address,
      name,
      peripheral,
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

  function getPeripheral(address) {
    if (scanner) {
      const p = scanner.getPeripheral(address);
      if (p) return p;
    }
    try {
      const noble = require('@abandonware/noble');
      if (noble._peripherals) {
        const key = address.toLowerCase().replace(/:/g, '');
        return noble._peripherals[address] || noble._peripherals[key] || null;
      }
    } catch (_) {}
    return null;
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
