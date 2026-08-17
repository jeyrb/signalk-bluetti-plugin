"use strict";

const EventEmitter = require("events");
const ProtocolSession = require("./protocol-session");

// UUIDs used by most Bluetti devices
const SERVICE_UUID = "ff00";
const NOTIFY_UUID = "ff01";
const WRITE_UUID = "ff02";

// Fallback UUIDs seen on some older/alternate firmwares
const ALT_SERVICE_UUID = "ffe0";
const ALT_CHAR_UUID = "ffe1";

// node-ble's GattService1/GattCharacteristic1 `UUID` D-Bus properties always report
// the full 128-bit form, even for standard 16-bit Bluetooth Base UUIDs, and
// getPrimaryService()/getCharacteristic() key on that exact string — so short UUIDs
// like "ff00" must be expanded before lookup or they never match.
const toFullUuid = (shortUuid) => `0000${shortUuid}-0000-1000-8000-00805f9b34fb`;

const RECONNECT_DELAYS = [5000, 10000, 20000, 30000, 60000]; // ms, capped at last value
const CONNECT_TIMEOUT_MS = 30000;
const DISCOVER_TIMEOUT_MS = 20000;

// Owns the BLE GATT connection lifecycle for one device via node-ble/BlueZ
// (connect, reconnect, service/characteristic discovery, subscribe). The
// Modbus/V2-handshake protocol itself lives in ProtocolSession, which this
// class drives by feeding it notification bytes and writing the frames it
// produces back out over the write characteristic.
class BluettiDevice extends EventEmitter {
  constructor({ address, name, device, fields, pollIntervalMs = 10000, xorKey = null, log }) {
    super();
    this._address = address;
    this._name = name;
    this._device = device; // node-ble Device (D-Bus backed, persists across disconnects)
    this._log = log;

    this._connected = false;
    this._notifyChar = null;
    this._writeChar = null;
    this._reconnectAttempt = 0;
    this._stopped = false;
    this._disconnectHandler = null; // stored so we can remove it on reconnect

    this._session = new ProtocolSession({
      name,
      fields,
      xorKey: xorKey ? Buffer.from(xorKey, "hex") : null,
      pollIntervalMs,
      log,
      sendFrame: (buf) => this._writeRaw(buf),
    });
    this._session.on("registers", (registers) => this.emit("registers", registers));
    this._session.on("protocolError", () => {
      if (this._connected) this._device.disconnect().catch(() => {});
    });
  }

  start() {
    this._stopped = false;
    void this._connect();
  }

  stop() {
    this._stopped = true;
    this._session.stop();
    if (this._disconnectHandler) {
      this._device.removeListener("disconnect", this._disconnectHandler);
      this._disconnectHandler = null;
    }
    if (this._connected) {
      this._device.disconnect().catch(() => {});
    }
    this._device.helper?.removeAllListeners?.("PropertiesChanged");
  }

  // ── Connection lifecycle ─────────────────────────────────────────────────

  async _connect() {
    if (this._stopped) return;
    // Cancel any lingering BlueZ connection state (e.g. a previous attempt that
    // timed out on our side but is still in progress inside BlueZ).
    if (!this._connected) {
      try {
        await this._device.disconnect();
      } catch {}
    }
    this._log(`[${this._name}] Connecting to ${this._address} …`);

    // Clear any stale disconnect handler from a previous attempt.
    if (this._disconnectHandler) {
      this._device.removeListener("disconnect", this._disconnectHandler);
      this._disconnectHandler = null;
    }

    // node-ble's Device#connect() adds a fresh 'PropertiesChanged' D-Bus listener on every
    // call and only clears it via a *successful* disconnect() — our speculative disconnect()
    // above routinely fails (nothing to disconnect) and swallows the error, so every reconnect
    // attempt leaks one listener on the long-lived Device object, eventually tripping Node's
    // MaxListenersExceededWarning. Clear it directly before each attempt so at most one is ever
    // outstanding. (github.com/naugehyde/node-ble — fix proposed upstream, not yet released.)
    this._device.helper?.removeAllListeners?.("PropertiesChanged");

    let settled = false;
    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this._log(`[${this._name}] Connect timed out after ${CONNECT_TIMEOUT_MS / 1000}s — will retry`);
      this._scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);

    try {
      await this._device.connect();
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      this._log(`[${this._name}] Connect error: ${err.message}`);
      this._scheduleReconnect();
      return;
    }

    if (settled) return; // timed out while awaiting
    settled = true;
    clearTimeout(connectTimer);

    this._log(`[${this._name}] Connected`);
    this._reconnectAttempt = 0;

    // Register disconnect handler — stored so it can be removed on reconnect.
    this._disconnectHandler = () => {
      if (this._stopped) return;
      this._connected = false;
      this._notifyChar = null;
      this._writeChar = null;
      this._disconnectHandler = null;
      this._session.stop();
      this._log(`[${this._name}] Disconnected`);
      this._scheduleReconnect();
    };
    this._device.once("disconnect", this._disconnectHandler);

    let discoverSettled = false;
    const discoverTimer = setTimeout(() => {
      if (discoverSettled) return;
      discoverSettled = true;
      this._log(`[${this._name}] Service discovery timed out — will retry`);
      this._scheduleReconnect();
    }, DISCOVER_TIMEOUT_MS);

    await this._discoverServices(() => !discoverSettled);
    discoverSettled = true;
    clearTimeout(discoverTimer);
  }

  async _discoverServices(isActive) {
    let gatt;
    try {
      gatt = await this._device.gatt();
    } catch (err) {
      this._log(`[${this._name}] GATT error: ${err.message}`);
      if (isActive()) this._scheduleReconnect();
      return;
    }

    let service;
    for (const uuid of [SERVICE_UUID, ALT_SERVICE_UUID]) {
      try {
        service = await gatt.getPrimaryService(toFullUuid(uuid));
        break;
      } catch {}
    }
    if (!service) {
      this._log(`[${this._name}] Could not find BLE service (tried ${SERVICE_UUID}, ${ALT_SERVICE_UUID})`);
      if (isActive()) this._scheduleReconnect();
      return;
    }

    let notifyChar;
    for (const uuid of [NOTIFY_UUID, ALT_CHAR_UUID]) {
      try {
        notifyChar = await service.getCharacteristic(toFullUuid(uuid));
        break;
      } catch {}
    }

    let writeChar;
    for (const uuid of [WRITE_UUID, ALT_CHAR_UUID]) {
      try {
        writeChar = await service.getCharacteristic(toFullUuid(uuid));
        break;
      } catch {}
    }

    if (!notifyChar || !writeChar) {
      this._log(`[${this._name}] Could not find required GATT characteristics`);
      if (isActive()) this._scheduleReconnect();
      return;
    }

    try {
      await notifyChar.startNotifications();
    } catch (err) {
      this._log(`[${this._name}] Subscribe error: ${err.message}`);
      if (isActive()) this._scheduleReconnect();
      return;
    }

    notifyChar.on("valuechanged", (data) => this._session.feed(data));

    this._notifyChar = notifyChar;
    this._writeChar = writeChar;
    this._connected = true;
    this.emit("connected");
    this._session.start();
  }

  _writeRaw(buf) {
    this._writeChar.writeValueWithoutResponse(buf).catch((err) => {
      this._log(`[${this._name}] Write error: ${err.message}`);
    });
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    const delay = RECONNECT_DELAYS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this._reconnectAttempt++;
    this._log(`[${this._name}] Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempt})`);
    // The node-ble Device object is D-Bus backed and persists across disconnects —
    // no need to rescan for a fresh peripheral; just call connect() again.
    setTimeout(() => {
      if (!this._stopped) void this._connect();
    }, delay);
  }
}

module.exports = BluettiDevice;
