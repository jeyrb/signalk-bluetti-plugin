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

// The BLE Manager API's discoverServices() reports UUIDs in full 128-bit form
// (see lib/device.js's toFullUuid for the same story with node-ble/BlueZ).
const toFullUuid = (shortUuid) => `0000${shortUuid}-0000-1000-8000-00805f9b34fb`;

const RECONNECT_DELAYS = [5000, 10000, 20000, 30000, 60000]; // ms, capped at last value

// Owns the GATT connection lifecycle for one device via the SignalK server's
// BLE Manager API (app.bleApi, SignalK server >= 2.31.0) — the raw
// connectGATT() escape hatch, since Bluetti's Modbus-over-BLE protocol is a
// request/response RPC (each read batch waits on the previous reply) rather
// than the fixed-interval polling/notify pattern subscribeGATT() targets.
// The Modbus/V2-handshake protocol itself lives in ProtocolSession, which
// this class drives by feeding it notification bytes and writing the frames
// it produces back out over the write characteristic.
class BleManagerDevice extends EventEmitter {
  constructor({ app, pluginId, address, name, fields, pollIntervalMs = 10000, xorKey = null, log }) {
    super();
    this._app = app;
    this._pluginId = pluginId;
    this._address = address;
    this._name = name;
    this._log = log;

    this._conn = null;
    this._serviceUuid = null;
    this._writeUuid = null;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._stopped = false;

    this._session = new ProtocolSession({
      name,
      fields,
      xorKey: xorKey ? Buffer.from(xorKey, "hex") : null,
      pollIntervalMs,
      log,
      sendFrame: (buf) => this._writeRaw(buf),
    });
    this._session.on("registers", (registers) => this.emit("registers", registers));
    this._session.on("protocolError", () => this._handleDisconnect("protocol error"));
  }

  start() {
    this._stopped = false;
    void this._connect();
  }

  stop() {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._session.stop();
    const conn = this._conn;
    this._conn = null;
    if (conn) conn.disconnect().catch(() => {});
  }

  // ── Connection lifecycle ─────────────────────────────────────────────────

  async _connect() {
    if (this._stopped) return;
    this._log(`[${this._name}] Connecting to ${this._address} via BLE Manager API …`);

    let conn;
    try {
      conn = await this._app.bleApi.connectGATT(this._address, this._pluginId);
    } catch (err) {
      if (this._stopped) return;
      this._log(`[${this._name}] Connect error: ${err.message}`);
      this._scheduleReconnect();
      return;
    }
    if (this._stopped) {
      conn.disconnect().catch(() => {});
      return;
    }

    this._conn = conn;
    conn.onDisconnect(() => this._handleDisconnect("Disconnected"));

    let services;
    try {
      services = await conn.discoverServices();
    } catch (err) {
      this._log(`[${this._name}] Service discovery error: ${err.message}`);
      this._handleDisconnect("service discovery failed");
      return;
    }

    const service =
      services.find((s) => s.uuid === toFullUuid(SERVICE_UUID)) || services.find((s) => s.uuid === toFullUuid(ALT_SERVICE_UUID));
    if (!service) {
      this._log(`[${this._name}] Could not find BLE service (tried ${SERVICE_UUID}, ${ALT_SERVICE_UUID})`);
      this._handleDisconnect("service not found");
      return;
    }

    const charUuids = new Set(service.characteristics.map((c) => c.uuid));
    const notifyUuid = [NOTIFY_UUID, ALT_CHAR_UUID].map(toFullUuid).find((u) => charUuids.has(u));
    const writeUuid = [WRITE_UUID, ALT_CHAR_UUID].map(toFullUuid).find((u) => charUuids.has(u));
    if (!notifyUuid || !writeUuid) {
      this._log(`[${this._name}] Could not find required GATT characteristics`);
      this._handleDisconnect("characteristics not found");
      return;
    }

    try {
      await conn.startNotifications(service.uuid, notifyUuid, (data) => this._session.feed(data));
    } catch (err) {
      this._log(`[${this._name}] Subscribe error: ${err.message}`);
      this._handleDisconnect("subscribe failed");
      return;
    }

    this._serviceUuid = service.uuid;
    this._writeUuid = writeUuid;
    this._reconnectAttempt = 0;
    this._log(`[${this._name}] Connected (BLE Manager API)`);
    this.emit("connected");
    this._session.start();
  }

  _writeRaw(buf) {
    if (!this._conn) return;
    this._conn.write(this._serviceUuid, this._writeUuid, buf, false).catch((err) => {
      this._log(`[${this._name}] Write error: ${err.message}`);
    });
  }

  _handleDisconnect(reason) {
    if (this._stopped || !this._conn) return; // already handled (or never connected)
    this._log(`[${this._name}] ${reason}`);
    this._session.stop();
    const conn = this._conn;
    this._conn = null;
    this._serviceUuid = null;
    this._writeUuid = null;
    conn.disconnect().catch(() => {});
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    const delay = RECONNECT_DELAYS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this._reconnectAttempt++;
    this._log(`[${this._name}] Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempt})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._stopped) void this._connect();
    }, delay);
  }
}

module.exports = BleManagerDevice;
