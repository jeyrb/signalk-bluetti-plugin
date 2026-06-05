'use strict';

const EventEmitter = require('events');
const { buildReadRequest, completeFrameLength, parseReadResponse, applyXor, groupRegisters } = require('./protocol');

// UUIDs used by most Bluetti devices
const SERVICE_UUID     = 'ff00';
const NOTIFY_UUID      = 'ff01';
const WRITE_UUID       = 'ff02';

// Fallback UUIDs seen on some older/alternate firmwares
const ALT_SERVICE_UUID = 'ffe0';
const ALT_CHAR_UUID    = 'ffe1';

const RECONNECT_DELAYS    = [5000, 10000, 20000, 30000, 60000];  // ms, capped at last value
const CONNECT_TIMEOUT_MS  = 30000;
const DISCOVER_TIMEOUT_MS = 20000;

class BluettiDevice extends EventEmitter {
  constructor({ address, name, device, fields, pollIntervalMs = 10000, xorKey = null, log }) {
    super();
    this._address        = address;
    this._name           = name;
    this._device         = device;   // node-ble Device (D-Bus backed, persists across disconnects)
    this._fields         = fields;
    this._pollIntervalMs = pollIntervalMs;
    this._xorKey         = xorKey ? Buffer.from(xorKey, 'hex') : null;
    this._log            = log;

    this._connected          = false;
    this._notifyChar         = null;
    this._writeChar          = null;
    this._rxBuf              = Buffer.alloc(0);
    this._currentBatch       = null;   // { start, count } being awaited
    this._batchQueue         = [];
    this._pollTimer          = null;
    this._reconnectAttempt   = 0;
    this._stopped            = false;
    this._disconnectHandler  = null;   // stored so we can remove it on reconnect

    const addrs = [...new Set(fields.flatMap(f => Array.from({ length: f.count }, (_, i) => f.register + i)))];
    this._batches = groupRegisters(addrs);
    this._log(`[${name}] Poll plan: ${this._batches.length} batch(es) covering ${addrs.length} registers`);
  }

  start() {
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    this._stopPolling();
    if (this._disconnectHandler) {
      this._device.removeListener('disconnect', this._disconnectHandler);
      this._disconnectHandler = null;
    }
    if (this._connected) {
      this._device.disconnect().catch(() => {});
    }
  }

  // ── Connection lifecycle ─────────────────────────────────────────────────

  async _connect() {
    if (this._stopped) return;
    // Cancel any lingering BlueZ connection state (e.g. a previous attempt that
    // timed out on our side but is still in progress inside BlueZ).
    if (!this._connected) {
      try { await this._device.disconnect(); } catch (_) {}
    }
    this._log(`[${this._name}] Connecting to ${this._address} …`);

    // Clear any stale disconnect handler from a previous attempt.
    if (this._disconnectHandler) {
      this._device.removeListener('disconnect', this._disconnectHandler);
      this._disconnectHandler = null;
    }

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

    if (settled) return;   // timed out while awaiting
    settled = true;
    clearTimeout(connectTimer);

    this._log(`[${this._name}] Connected`);
    this._reconnectAttempt = 0;

    // Register disconnect handler — stored so it can be removed on reconnect.
    this._disconnectHandler = () => {
      if (this._stopped) return;
      this._connected          = false;
      this._notifyChar         = null;
      this._writeChar          = null;
      this._disconnectHandler  = null;
      this._log(`[${this._name}] Disconnected`);
      this._stopPolling();
      this._scheduleReconnect();
    };
    this._device.once('disconnect', this._disconnectHandler);

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
        service = await gatt.getPrimaryService(uuid);
        break;
      } catch (_) {}
    }
    if (!service) {
      this._log(`[${this._name}] Could not find BLE service (tried ${SERVICE_UUID}, ${ALT_SERVICE_UUID})`);
      if (isActive()) this._scheduleReconnect();
      return;
    }

    let notifyChar;
    for (const uuid of [NOTIFY_UUID, ALT_CHAR_UUID]) {
      try { notifyChar = await service.getCharacteristic(uuid); break; } catch (_) {}
    }

    let writeChar;
    for (const uuid of [WRITE_UUID, ALT_CHAR_UUID]) {
      try { writeChar = await service.getCharacteristic(uuid); break; } catch (_) {}
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

    notifyChar.on('valuechanged', (data) => this._onData(data));

    this._notifyChar = notifyChar;
    this._writeChar  = writeChar;
    this._connected  = true;
    this.emit('connected');
    this._startPolling();
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    const delay = RECONNECT_DELAYS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this._reconnectAttempt++;
    this._log(`[${this._name}] Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempt})`);
    // The node-ble Device object is D-Bus backed and persists across disconnects —
    // no need to rescan for a fresh peripheral; just call connect() again.
    setTimeout(() => {
      if (!this._stopped) this._connect();
    }, delay);
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  _startPolling() {
    this._stopPolling();
    this._poll();
    this._pollTimer = setInterval(() => this._poll(), this._pollIntervalMs);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._batchQueue   = [];
    this._currentBatch = null;
  }

  _poll() {
    if (!this._connected || this._batches.length === 0) return;
    this._batchQueue = [...this._batches];
    this._rxBuf = Buffer.alloc(0);
    this._sendNextBatch();
  }

  _sendNextBatch() {
    if (!this._connected || this._batchQueue.length === 0) return;
    this._currentBatch = this._batchQueue.shift();
    const { start, count } = this._currentBatch;
    let frame = buildReadRequest(start, count);
    if (this._xorKey) frame = applyXor(frame, this._xorKey);
    this._rxBuf = Buffer.alloc(0);
    this._writeChar.writeValueWithoutResponse(frame).catch((err) => {
      this._log(`[${this._name}] Write error: ${err.message}`);
    });
  }

  // ── Receive ──────────────────────────────────────────────────────────────

  _onData(data) {
    const chunk = this._xorKey ? applyXor(data, this._xorKey) : data;
    this._rxBuf = Buffer.concat([this._rxBuf, chunk]);

    const frameLen = completeFrameLength(this._rxBuf);
    if (frameLen === 0) return;   // waiting for more BLE packets

    const frame = this._rxBuf.slice(0, frameLen);
    this._rxBuf = this._rxBuf.slice(frameLen);

    if (!this._currentBatch) return;
    const result = parseReadResponse(frame, this._currentBatch.start);
    if (result) {
      this.emit('registers', result.registers);
    } else {
      this._log(`[${this._name}] CRC error or unexpected frame, skipping batch`);
    }

    this._sendNextBatch();
  }
}

module.exports = BluettiDevice;
