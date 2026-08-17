"use strict";

const EventEmitter = require("events");
const { isBluettiDevice } = require("./scanner");

// Discovery via the SignalK server's BLE Manager API (app.bleApi, SignalK
// server >= 2.31.0) instead of talking to BlueZ directly. Mirrors Scanner's
// EventEmitter API ('discovered' / 'scanComplete') so index.js can treat the
// two interchangeably.
class BleManagerScanner extends EventEmitter {
  constructor(app, pluginId, log, { includeAll = false } = {}) {
    super();
    this._app = app;
    this._pluginId = pluginId;
    this._log = log;
    this._includeAll = includeAll;
    this._unsubscribe = null;
    this._scanTimer = null;
    this._found = new Map(); // normalised mac → { address, name, isBluetti }
    this._scanning = false;
  }

  // `durationMs` — auto-stop after this long. Pass `null` for an open-ended
  // scan that runs until stopScan() is called explicitly.
  async startScan(durationMs = 15000) {
    if (this._scanning) return;
    this._scanning = true;
    this._found.clear();
    this._log(
      durationMs
        ? `Scanning for Bluetti devices for ${durationMs / 1000}s (BLE Manager API) …`
        : "Scanning for Bluetti devices (BLE Manager API) …",
    );

    this._unsubscribe = this._app.bleApi.onAdvertisement(this._pluginId, (adv) => this._onSeen(adv));

    // Pick up devices the server already knew about before we subscribed.
    try {
      const known = await this._app.bleApi.getDevices();
      for (const d of known) this._onSeen(d);
    } catch (err) {
      this._log(`BLE Manager getDevices() failed: ${err.message}`);
    }

    if (!this._scanning) return; // stopScan() ran while awaiting getDevices()

    if (durationMs) {
      this._scanTimer = setTimeout(() => this.stopScan(), durationMs);
    }
  }

  _onSeen({ mac, name }) {
    if (!this._scanning) return;
    const normAddr = mac.toLowerCase().replace(/:/g, "");
    if (this._found.has(normAddr)) return;
    const isBluetti = isBluettiDevice(name);
    if (!isBluetti && !this._includeAll) return;
    const entry = { address: mac, name: name || "", isBluetti };
    this._found.set(normAddr, entry);
    this._log(`Discovered ${isBluetti ? "Bluetti" : "BLE"} device: ${name || "(unnamed)"} [${mac}]`);
    this.emit("discovered", entry);
  }

  stopScan() {
    if (!this._scanning) return;
    clearTimeout(this._scanTimer);
    this._scanTimer = null;
    this._scanning = false;
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    const found = [...this._found.values()];
    this._log(`Scan complete. Found ${found.length} device(s).`);
    this.emit("scanComplete", found);
  }

  stopAll() {
    this.stopScan();
  }
}

module.exports = BleManagerScanner;
