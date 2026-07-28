"use strict";

const EventEmitter = require("events");

const BLUETTI_NAME_PREFIXES = ["BT-TH-", "BLUETTI", "AC", "EP", "EB", "EL"];

// Retry/backoff for BLE adapter init — covers the case where SignalK (and this
// plugin) starts before bluetoothd/D-Bus is up, e.g. on boot when service
// ordering isn't configured. Retries forever with capped exponential backoff
// rather than giving up after one attempt.
const ADAPTER_INIT_RETRY_INITIAL_MS = 2000;
const ADAPTER_INIT_RETRY_MAX_MS = 30000;

function isBluettiDevice(name) {
  if (!name) return false;
  return BLUETTI_NAME_PREFIXES.some((p) => name.toUpperCase().startsWith(p.toUpperCase()));
}

class Scanner extends EventEmitter {
  constructor(log, { includeAll = false } = {}) {
    super();
    this._log = log;
    this._includeAll = includeAll; // when true, emit non-Bluetti BLE devices too
    this._bluetooth = null;
    this._destroy = null;
    this._adapter = null;
    this._scanning = false;
    this._scanTimer = null;
    this._pollTimer = null;
    this._found = new Map(); // normalised address → { address, name, device, isBluetti }
    this._stopped = false;
    this._retryTimer = null;
    this._retryResolve = null;
  }

  async _init() {
    if (this._adapter) return;
    const { createBluetooth } = require("@naugehyde/node-ble");
    const bt = createBluetooth();
    try {
      this._adapter = await bt.bluetooth.defaultAdapter();
    } catch (err) {
      // Don't leak the D-Bus connection on a failed attempt — a retry will
      // create a fresh one.
      try {
        bt.destroy();
      } catch {}
      throw err;
    }
    this._bluetooth = bt.bluetooth;
    // Call through `bt` rather than destructuring — destroy() is a method on the
    // returned object and must keep its receiver.
    this._destroy = () => bt.destroy();
  }

  // Retries _init() with capped exponential backoff until it succeeds or
  // stopAll()/stopScan() cancels the wait (this._stopped).
  async _initWithRetry() {
    let delay = ADAPTER_INIT_RETRY_INITIAL_MS;
    for (;;) {
      try {
        await this._init();
        return;
      } catch (err) {
        if (this._stopped) throw err;
        this._log(`BLE adapter not ready (${err.message}) — retrying in ${Math.round(delay / 1000)}s …`);
        await this._delay(delay);
        if (this._stopped) throw new Error("scanner stopped while waiting for BLE adapter");
        delay = Math.min(delay * 2, ADAPTER_INIT_RETRY_MAX_MS);
      }
    }
  }

  _delay(ms) {
    return new Promise((resolve) => {
      this._retryResolve = resolve;
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        this._retryResolve = null;
        resolve();
      }, ms);
    });
  }

  // Cancels a pending _delay() wait immediately, if one is in flight.
  _cancelRetryWait() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._retryResolve) {
      const resolve = this._retryResolve;
      this._retryResolve = null;
      resolve();
    }
  }

  // `durationMs` — auto-stop (and release BlueZ discovery) after this long.
  // Pass `null` for an open-ended scan that runs until stopScan() is called
  // explicitly; used for long-lived "keep looking" scans so we don't churn
  // the adapter's shared discovery session (see stopScan()).
  async startScan(durationMs = 15000) {
    if (this._scanning) return;
    this._stopped = false;

    try {
      await this._initWithRetry();
    } catch {
      // Cancelled via stopAll()/stopScan() while waiting for the adapter.
      return;
    }
    if (this._stopped) return;

    this._found.clear();
    this._scanning = true;
    this._log(durationMs ? `Scanning for Bluetti devices for ${durationMs / 1000}s …` : "Scanning for Bluetti devices …");

    try {
      if (!(await this._adapter.isDiscovering())) {
        await this._adapter.startDiscovery();
      }
    } catch (err) {
      this._log(`Failed to start BLE discovery: ${err.message}`);
      this._scanning = false;
      return;
    }

    if (durationMs) {
      this._scanTimer = setTimeout(() => this.stopScan(), durationMs);
    }
    this._pollTimer = setInterval(() => this._poll(), 1000);
    void this._poll(); // check immediately for already-known devices
  }

  async _poll() {
    if (!this._adapter || !this._scanning) return;
    let addresses;
    try {
      addresses = await this._adapter.devices();
    } catch {
      return;
    }
    for (const addr of addresses) {
      if (!this._scanning) break; // scanner stopped while we were iterating
      const normAddr = addr.toLowerCase().replace(/:/g, "");
      if (this._found.has(normAddr)) continue;
      // Reserve the slot immediately to prevent concurrent _poll() calls from
      // both processing the same address before either stores the device.
      this._found.set(normAddr, null);
      try {
        const device = await this._adapter.getDevice(addr);
        const name = (await Promise.resolve(device.getName()).catch(() => "")) || "";
        if (!this._scanning) break;
        const isBluetti = isBluettiDevice(name);
        if (!isBluetti && !this._includeAll) {
          this._found.delete(normAddr);
          continue;
        }
        this._found.set(normAddr, { address: addr, name, device, isBluetti });
        this._log(`Discovered ${isBluetti ? "Bluetti" : "BLE"} device: ${name || "(unnamed)"} [${addr}]`);
        this.emit("discovered", { address: addr, name, device, isBluetti });
      } catch {
        this._found.delete(normAddr); // allow retry on transient D-Bus error
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
    const found = [...this._found.values()].filter((v) => v !== null);
    this._log(`Scan complete. Found ${found.length} device(s).`);
    this.emit(
      "scanComplete",
      found.map(({ address, name, isBluetti }) => ({ address, name, isBluetti })),
    );
  }

  stopAll() {
    this._stopped = true;
    this._cancelRetryWait();
    this.stopScan();
    if (this._destroy) {
      try {
        this._destroy();
      } catch {}
      this._destroy = null;
      this._adapter = null;
      this._bluetooth = null;
    }
  }
}

module.exports = Scanner;
module.exports.isBluettiDevice = isBluettiDevice;
