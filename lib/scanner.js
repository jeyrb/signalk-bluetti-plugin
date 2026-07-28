'use strict';

const EventEmitter = require('events');

const BLUETTI_NAME_PREFIXES = ['BT-TH-', 'BLUETTI', 'AC', 'EP', 'EB', 'EL'];

function isBluettiDevice(name) {
  if (!name) return false;
  return BLUETTI_NAME_PREFIXES.some(p => name.toUpperCase().startsWith(p.toUpperCase()));
}

class Scanner extends EventEmitter {
  constructor(log, { includeAll = false } = {}) {
    super();
    this._log        = log;
    this._includeAll = includeAll;   // when true, emit non-Bluetti BLE devices too
    this._bluetooth  = null;
    this._destroy    = null;
    this._adapter    = null;
    this._scanning   = false;
    this._scanTimer  = null;
    this._pollTimer  = null;
    this._found      = new Map();   // normalised address → { address, name, device, isBluetti }
  }

  async _init() {
    if (this._adapter) return;
    const { createBluetooth } = require('@naugehyde/node-ble');
    const { bluetooth, destroy } = createBluetooth();
    this._bluetooth = bluetooth;
    this._destroy   = destroy;
    this._adapter   = await bluetooth.defaultAdapter();
  }

  async startScan(durationMs = 15000) {
    if (this._scanning) return;

    try {
      await this._init();
    } catch (err) {
      this._log(`BLE adapter init failed: ${err.message}`);
      this.emit('error', err);
      return;
    }

    this._found.clear();
    this._scanning = true;
    this._log(`Scanning for Bluetti devices for ${durationMs / 1000}s …`);

    try {
      if (!await this._adapter.isDiscovering()) {
        await this._adapter.startDiscovery();
      }
    } catch (err) {
      this._log(`Failed to start BLE discovery: ${err.message}`);
      this._scanning = false;
      return;
    }

    this._scanTimer = setTimeout(() => this.stopScan(), durationMs);
    this._pollTimer = setInterval(() => this._poll(), 1000);
    this._poll();   // check immediately for already-known devices
  }

  async _poll() {
    if (!this._adapter || !this._scanning) return;
    let addresses;
    try {
      addresses = await this._adapter.devices();
    } catch (_) {
      return;
    }
    for (const addr of addresses) {
      if (!this._scanning) break;  // scanner stopped while we were iterating
      const normAddr = addr.toLowerCase().replace(/:/g, '');
      if (this._found.has(normAddr)) continue;
      // Reserve the slot immediately to prevent concurrent _poll() calls from
      // both processing the same address before either stores the device.
      this._found.set(normAddr, null);
      try {
        const device = await this._adapter.getDevice(addr);
        const name   = await Promise.resolve(device.getName()).catch(() => '') || '';
        if (!this._scanning) break;
        const isBluetti = isBluettiDevice(name);
        if (!isBluetti && !this._includeAll) { this._found.delete(normAddr); continue; }
        this._found.set(normAddr, { address: addr, name, device, isBluetti });
        this._log(`Discovered ${isBluetti ? 'Bluetti' : 'BLE'} device: ${name || '(unnamed)'} [${addr}]`);
        this.emit('discovered', { address: addr, name, device, isBluetti });
      } catch (_) {
        this._found.delete(normAddr);  // allow retry on transient D-Bus error
      }
    }
  }

  stopScan() {
    if (!this._scanning) return;
    clearTimeout(this._scanTimer);
    clearInterval(this._pollTimer);
    this._scanning = false;
    // Decrement BlueZ discovery reference count — other plugins' sessions keep scanning.
    if (this._adapter) this._adapter.stopDiscovery().catch(() => {});
    const found = [...this._found.values()].filter(v => v !== null);
    this._log(`Scan complete. Found ${found.length} device(s).`);
    this.emit('scanComplete', found.map(({ address, name, isBluetti }) => ({ address, name, isBluetti })));
  }

  stopAll() {
    this.stopScan();
    if (this._destroy) {
      try { this._destroy(); } catch (_) {}
      this._destroy   = null;
      this._adapter   = null;
      this._bluetooth = null;
    }
  }
}

module.exports = Scanner;
module.exports.isBluettiDevice = isBluettiDevice;
