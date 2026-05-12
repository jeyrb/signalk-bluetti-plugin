'use strict';

const PLUGIN_ID = 'signalk-bluetti-plugin';

module.exports = function (app) {
  const log = (msg) => app.debug(msg);

  let scanner      = null;
  let activeDevices = [];
  let scanResultCache = [];

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
          required: ['address', 'name', 'csvPath'],
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
            csvPath: {
              type: 'string',
              title: 'Register map CSV path',
              description: 'Absolute path to the Bluetti register definition CSV file.',
            },
            pollIntervalSeconds: {
              type: 'number',
              title: 'Poll interval (seconds)',
              default: 10,
              minimum: 2,
            },
            xorKey: {
              type: 'string',
              title: 'XOR encryption key (hex, optional)',
              description: 'Leave blank for unencrypted devices. For encrypted models enter the hex key from your CSV.',
              default: '',
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
        address: { 'ui:placeholder': 'aa:bb:cc:dd:ee:ff' },
        name:    { 'ui:placeholder': 'house' },
        csvPath: { 'ui:placeholder': '/home/user/bluetti-registers.csv' },
        xorKey:  { 'ui:placeholder': 'Leave blank if not encrypted' },
      },
    },
  };

  // ── Start ──────────────────────────────────────────────────────────────

  plugin.start = function (options) {
    // Defer all third-party requires to here so a missing dep shows as a
    // plugin status error rather than silently removing the plugin from the list.
    let Scanner, BluettiDevice, loadCsv, buildDelta;
    try {
      Scanner       = require('./lib/scanner');
      BluettiDevice = require('./lib/device');
      ({ loadCsv }    = require('./lib/csv-loader'));
      ({ buildDelta } = require('./lib/path-mapper'));
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
      startDevice(cfg, { Scanner, BluettiDevice, loadCsv, buildDelta });
    }

    app.setPluginStatus(`Connecting to ${devices.length} device(s) …`);
  };

  function startDevice(cfg, { BluettiDevice, loadCsv, buildDelta }) {
    const { address, name, csvPath, pollIntervalSeconds = 10, xorKey = '' } = cfg;

    if (!address || !name || !csvPath) {
      log(`Skipping device — missing address, name, or csvPath`);
      return;
    }

    let fields;
    try {
      fields = loadCsv(csvPath);
      log(`[${name}] Loaded ${fields.length} registers from ${csvPath}`);
    } catch (err) {
      app.setPluginError(`[${name}] Failed to load CSV "${csvPath}": ${err.message}`);
      return;
    }

    // noble peripheral lookup — must have scanned first or use internal map
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
      xorKey: xorKey || null,
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
    // Try the scanner's cache first (populated by startScan)
    if (scanner) {
      const p = scanner.getPeripheral(address);
      if (p) return p;
    }
    // Fallback: noble's internal peripheral map (populated by any prior scan)
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
