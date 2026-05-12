'use strict';

const path = require('path');
const Scanner = require('./lib/scanner');
const BluettiDevice = require('./lib/device');
const { loadCsv } = require('./lib/csv-loader');
const { buildDelta } = require('./lib/path-mapper');

const PLUGIN_ID = 'signalk-bluetti-plugin';

module.exports = function (app) {
  const log = (msg) => app.debug(msg);

  let scanner = null;
  let activeDevices = [];   // BluettiDevice instances
  let scanResultCache = []; // { address, name } from last scan

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
              description: 'Leave blank for unencrypted devices. For encrypted models, enter the hex key from your CSV or Bluetti documentation.',
              default: '',
            },
          },
        },
        default: [],
      },
    },
  };

  // ── uiSchema — hints for the SignalK admin UI ──────────────────────────

  plugin.uiSchema = {
    devices: {
      items: {
        address:  { 'ui:placeholder': 'aa:bb:cc:dd:ee:ff' },
        name:     { 'ui:placeholder': 'house' },
        csvPath:  { 'ui:placeholder': '/home/pi/bluetti-registers.csv' },
        xorKey:   { 'ui:placeholder': 'Leave blank if not encrypted' },
      },
    },
  };

  // ── Start ──────────────────────────────────────────────────────────────

  plugin.start = function (options) {
    scanner = new Scanner(log);

    // Relay scan discoveries to plugin status so the admin UI shows them.
    scanner.on('discovered', ({ address, name }) => {
      scanResultCache.push({ address, name });
      app.setPluginStatus(`Discovered: ${name} [${address}]. Configure in plugin settings.`);
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

    if (devices.length === 0 && options.scanOnStart !== false) {
      app.setPluginStatus('No devices configured — scanning for Bluetti devices …');
      scanner.startScan(15000);
      return;
    }

    if (options.scanOnStart !== false) {
      // Scan in background while also starting configured devices
      scanner.startScan(15000);
    }

    for (const cfg of devices) {
      startDevice(cfg);
    }

    if (devices.length > 0) {
      app.setPluginStatus(`Connecting to ${devices.length} device(s) …`);
    }
  };

  function startDevice(cfg) {
    const { address, name, csvPath, pollIntervalSeconds = 10, xorKey = '' } = cfg;

    // Validate address
    if (!address || !name) {
      log(`Skipping device with missing address or name`);
      return;
    }

    // Load register map
    let fields;
    try {
      fields = loadCsv(csvPath);
      log(`[${name}] Loaded ${fields.length} registers from ${csvPath}`);
    } catch (err) {
      app.setPluginError(`[${name}] Failed to load CSV: ${err.message}`);
      return;
    }

    // Get peripheral — either from scan cache or trigger a fresh connect via noble
    const peripheral = scanner.getPeripheral(address) || createPeripheral(address);
    if (!peripheral) {
      app.setPluginError(`[${name}] No BLE peripheral found for ${address}. Try enabling scanOnStart.`);
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

    device.on('error', (err) => {
      log(`[${name}] Error: ${err.message}`);
    });

    device.start();
    activeDevices.push(device);
  }

  // noble doesn't expose a simple "connect by address without scanning" API —
  // on Linux we must scan first to get a peripheral object. This placeholder
  // handles the case where the user configures an address before scanning.
  function createPeripheral(address) {
    // noble stores discovered peripherals internally; attempt to retrieve via internal map
    const noble = (() => { try { return require('@abandonware/noble'); } catch (_) { return null; } })();
    if (!noble) return null;

    // noble._peripherals is an internal map keyed by id (= address on Linux)
    const key = address.toLowerCase().replace(/:/g, '');
    return (noble._peripherals && (noble._peripherals[address] || noble._peripherals[key])) || null;
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
