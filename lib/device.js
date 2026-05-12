'use strict';

const EventEmitter = require('events');
const { buildReadRequest, completeFrameLength, parseReadResponse, applyXor, groupRegisters } = require('./protocol');

// UUIDs used by most Bluetti devices (short form — noble strips dashes and lowercases)
const SERVICE_UUID  = 'ff00';
const NOTIFY_UUID   = 'ff01';
const WRITE_UUID    = 'ff02';

// Fallback UUIDs seen on some older/alternate firmwares
const ALT_SERVICE_UUID = 'ffe0';
const ALT_CHAR_UUID    = 'ffe1';

const RECONNECT_DELAYS = [5000, 10000, 20000, 30000, 60000];  // ms, capped at last value

class BluettiDevice extends EventEmitter {
  constructor({ address, name, peripheral, fields, pollIntervalMs = 10000, xorKey = null, log }) {
    super();
    this._address       = address;
    this._name          = name;
    this._peripheral    = peripheral;
    this._fields        = fields;
    this._pollIntervalMs = pollIntervalMs;
    this._xorKey        = xorKey ? Buffer.from(xorKey, 'hex') : null;
    this._log           = log;

    this._connected     = false;
    this._notifyChar    = null;
    this._writeChar     = null;
    this._rxBuf         = Buffer.alloc(0);
    this._currentBatch  = null;   // { start, count } being awaited
    this._batchQueue    = [];
    this._pollTimer     = null;
    this._reconnectAttempt = 0;
    this._stopped       = false;

    // Pre-compute register poll batches from field list
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
    if (this._peripheral && this._connected) {
      try { this._peripheral.disconnect(); } catch (_) {}
    }
  }

  // ── Connection lifecycle ─────────────────────────────────────────────────

  _connect() {
    if (this._stopped) return;
    this._log(`[${this._name}] Connecting to ${this._address} …`);

    this._peripheral.connect((err) => {
      if (err) {
        this._log(`[${this._name}] Connect error: ${err.message}`);
        this._scheduleReconnect();
        return;
      }
      this._log(`[${this._name}] Connected`);
      this._reconnectAttempt = 0;
      this._discoverServices();
    });

    this._peripheral.once('disconnect', () => {
      if (this._stopped) return;
      this._connected = false;
      this._notifyChar = null;
      this._writeChar  = null;
      this._log(`[${this._name}] Disconnected`);
      this._stopPolling();
      this._scheduleReconnect();
    });
  }

  _discoverServices() {
    this._peripheral.discoverAllServicesAndCharacteristics((err, _services, chars) => {
      if (err) {
        this._log(`[${this._name}] Service discovery error: ${err.message}`);
        this._scheduleReconnect();
        return;
      }

      const notifyChar = chars.find(c => c.uuid === NOTIFY_UUID) ||
                         chars.find(c => c.uuid === ALT_CHAR_UUID);
      const writeChar  = chars.find(c => c.uuid === WRITE_UUID)  ||
                         chars.find(c => c.uuid === ALT_CHAR_UUID);

      if (!notifyChar || !writeChar) {
        const uuids = chars.map(c => c.uuid).join(', ');
        this._log(`[${this._name}] Could not find required characteristics. Found: ${uuids}`);
        this._scheduleReconnect();
        return;
      }

      this._notifyChar = notifyChar;
      this._writeChar  = writeChar;

      notifyChar.subscribe((err) => {
        if (err) {
          this._log(`[${this._name}] Subscribe error: ${err.message}`);
          this._scheduleReconnect();
          return;
        }
        notifyChar.on('data', (data) => this._onData(data));
        this._connected = true;
        this.emit('connected');
        this._startPolling();
      });
    });
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    const delay = RECONNECT_DELAYS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this._reconnectAttempt++;
    this._log(`[${this._name}] Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempt})`);
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
    this._batchQueue = [];
    this._currentBatch = null;
  }

  _poll() {
    if (!this._connected || this._batches.length === 0) return;
    // Queue all batches; they'll be sent one at a time as responses arrive
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
    this._writeChar.write(frame, false, (err) => {
      if (err) this._log(`[${this._name}] Write error: ${err.message}`);
    });
  }

  // ── Receive ──────────────────────────────────────────────────────────────

  _onData(data) {
    // Undo XOR on incoming data if encryption is in use
    const chunk = this._xorKey ? applyXor(data, this._xorKey) : data;
    this._rxBuf = Buffer.concat([this._rxBuf, chunk]);

    const frameLen = completeFrameLength(this._rxBuf);
    if (frameLen === 0) return;  // waiting for more BLE packets

    const frame = this._rxBuf.slice(0, frameLen);
    this._rxBuf = this._rxBuf.slice(frameLen);

    if (!this._currentBatch) return;
    const result = parseReadResponse(frame, this._currentBatch.start);
    if (result) {
      this.emit('registers', result.registers);
    } else {
      this._log(`[${this._name}] CRC error or unexpected frame, skipping batch`);
    }

    // Move to next batch
    this._sendNextBatch();
  }
}

module.exports = BluettiDevice;
