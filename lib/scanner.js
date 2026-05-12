'use strict';

const EventEmitter = require('events');

// Bluetti devices advertise with names matching these prefixes.
// BT-TH-XXXXXXXXXX is the most common; some models use BLUETTI or model names directly.
const BLUETTI_NAME_PREFIXES = ['BT-TH-', 'BLUETTI', 'AC200', 'AC300', 'AC500', 'EP500', 'EB'];

function isBluettiDevice(peripheral) {
  const name = (peripheral.advertisement && peripheral.advertisement.localName) || '';
  return BLUETTI_NAME_PREFIXES.some(p => name.toUpperCase().startsWith(p.toUpperCase()));
}

class Scanner extends EventEmitter {
  constructor(log) {
    super();
    this._log = log;
    this._noble = null;
    this._scanning = false;
    this._found = new Map();   // address → peripheral
  }

  // Returns a promise that resolves once noble is powered on.
  _initNoble() {
    if (this._noble) return Promise.resolve();

    return new Promise((resolve, reject) => {
      let noble;
      try {
        noble = require('@abandonware/noble');
      } catch (e) {
        return reject(new Error('@abandonware/noble not installed — run: npm install'));
      }

      this._noble = noble;

      noble.on('discover', (peripheral) => {
        if (!isBluettiDevice(peripheral)) return;
        const addr = peripheral.address || peripheral.id;
        const name = (peripheral.advertisement.localName || 'unknown').trim();
        if (!this._found.has(addr)) {
          this._found.set(addr, peripheral);
          this._log(`Discovered Bluetti device: ${name} [${addr}]`);
          this.emit('discovered', { address: addr, name, peripheral });
        }
      });

      noble.on('stateChange', (state) => {
        this._log(`BLE adapter state: ${state}`);
        if (state === 'poweredOn') {
          resolve();
        } else if (state === 'poweredOff' || state === 'unsupported') {
          reject(new Error(`BLE adapter state: ${state}`));
        }
      });

      // Already powered on (noble initialised before our listener)
      if (noble.state === 'poweredOn') resolve();
    });
  }

  async startScan(durationMs = 15000) {
    if (this._scanning) return;
    await this._initNoble();
    this._found.clear();
    this._scanning = true;
    this._log(`Scanning for Bluetti devices for ${durationMs / 1000}s …`);
    this._noble.startScanning([], false);
    this._scanTimer = setTimeout(() => this.stopScan(), durationMs);
  }

  stopScan() {
    if (!this._scanning) return;
    clearTimeout(this._scanTimer);
    this._scanning = false;
    if (this._noble) this._noble.stopScanning();
    this._log(`Scan complete. Found ${this._found.size} Bluetti device(s).`);
    this.emit('scanComplete', [...this._found.values()].map(p => ({
      address: p.address || p.id,
      name: (p.advertisement.localName || 'unknown').trim(),
    })));
  }

  // Retrieve a previously-discovered peripheral by address (for reconnect).
  getPeripheral(address) {
    return this._found.get(address) || null;
  }

  // Start a persistent background scan (noble keeps discovering; don't auto-stop).
  startPassiveScan() {
    this._initNoble().then(() => {
      this._scanning = true;
      this._noble.startScanning([], true);   // allowDuplicates=true so we see RSSI updates
    }).catch(err => {
      this._log(`BLE init failed: ${err.message}`);
      this.emit('error', err);
    });
  }

  stopAll() {
    this.stopScan();
    if (this._noble) {
      try { this._noble.stopScanning(); } catch (_) {}
    }
  }
}

module.exports = Scanner;
