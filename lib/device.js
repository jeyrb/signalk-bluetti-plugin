"use strict";

const EventEmitter = require("events");
const { buildReadRequest, completeFrameLength, parseReadResponse, applyXor, groupRegisters } = require("./protocol");
const { BluettiV2Handshake, Message, MessageType } = require("./v2-encryption");

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

// Some Bluetti models ("V2" protocol — EL100V2, EL30V2, PR100V2, PR30V2, ...)
// push an unencrypted handshake CHALLENGE as soon as notifications are enabled,
// before we've sent anything. If nothing arrives in this window, assume the
// device speaks the plain/XOR protocol and start polling normally.
const HANDSHAKE_DETECT_MS = 3000;

class BluettiDevice extends EventEmitter {
  constructor({ address, name, device, fields, pollIntervalMs = 10000, xorKey = null, log }) {
    super();
    this._address = address;
    this._name = name;
    this._device = device; // node-ble Device (D-Bus backed, persists across disconnects)
    this._fields = fields;
    this._pollIntervalMs = pollIntervalMs;
    this._xorKey = xorKey ? Buffer.from(xorKey, "hex") : null;
    this._log = log;

    this._connected = false;
    this._notifyChar = null;
    this._writeChar = null;
    this._rxBuf = Buffer.alloc(0);
    this._currentBatch = null; // { start, count } being awaited
    this._batchQueue = [];
    this._pollTimer = null;
    this._reconnectAttempt = 0;
    this._stopped = false;
    this._disconnectHandler = null; // stored so we can remove it on reconnect

    // V2 handshake state — see _armHandshakeDetection().
    this._mode = null; // "detecting" | "legacy" | "handshaking" | "secure"
    this._handshake = null;
    this._encBuf = Buffer.alloc(0);
    this._detectTimer = null;

    const addrs = [...new Set(fields.flatMap((f) => Array.from({ length: f.count }, (_, i) => f.register + i)))];
    this._batches = groupRegisters(addrs);
    this._log(`[${name}] Poll plan: ${this._batches.length} batch(es) covering ${addrs.length} registers`);
  }

  start() {
    this._stopped = false;
    void this._connect();
  }

  stop() {
    this._stopped = true;
    this._stopPolling();
    if (this._detectTimer) {
      clearTimeout(this._detectTimer);
      this._detectTimer = null;
    }
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
      if (this._detectTimer) {
        clearTimeout(this._detectTimer);
        this._detectTimer = null;
      }
      this._mode = null;
      this._handshake = null;
      this._encBuf = Buffer.alloc(0);
      this._log(`[${this._name}] Disconnected`);
      this._stopPolling();
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

    notifyChar.on("valuechanged", (data) => this._onData(data));

    this._notifyChar = notifyChar;
    this._writeChar = writeChar;
    this._connected = true;
    this._handshake = new BluettiV2Handshake();
    this._encBuf = Buffer.alloc(0);
    this.emit("connected");
    this._armHandshakeDetection();
  }

  // Wait briefly for a spontaneous V2 handshake CHALLENGE before assuming this
  // device speaks the plain/XOR protocol. See HANDSHAKE_DETECT_MS.
  _armHandshakeDetection() {
    this._mode = "detecting";
    this._detectTimer = setTimeout(() => {
      this._detectTimer = null;
      if (this._mode === "detecting") {
        this._mode = "legacy";
        this._startPolling();
      }
    }, HANDSHAKE_DETECT_MS);
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
    this._batchQueue = [...this._batches];
    this._rxBuf = Buffer.alloc(0);
    this._encBuf = Buffer.alloc(0);
    this._sendNextBatch();
  }

  _sendNextBatch() {
    if (!this._connected || this._batchQueue.length === 0) return;
    this._currentBatch = this._batchQueue.shift();
    const { start, count } = this._currentBatch;
    let frame = buildReadRequest(start, count);
    if (this._mode === "secure") {
      frame = this._handshake.aesEncrypt(frame, this._handshake.secureAesKey, null);
    } else if (this._xorKey) {
      frame = applyXor(frame, this._xorKey);
    }
    this._rxBuf = Buffer.alloc(0);
    this._writeRaw(frame);
  }

  _writeRaw(buf) {
    this._writeChar.writeValueWithoutResponse(buf).catch((err) => {
      this._log(`[${this._name}] Write error: ${err.message}`);
    });
  }

  // ── Receive ──────────────────────────────────────────────────────────────

  _onData(data) {
    if (this._mode === "detecting" || this._mode === "handshaking") {
      this._handleHandshakeData(data);
      return;
    }
    if (this._mode === "secure") {
      this._handleSecureData(data);
      return;
    }
    this._handleLegacyData(data);
  }

  _handleLegacyData(data) {
    const chunk = this._xorKey ? applyXor(data, this._xorKey) : data;
    this._rxBuf = Buffer.concat([this._rxBuf, chunk]);

    const frameLen = completeFrameLength(this._rxBuf);
    if (frameLen === 0) return; // waiting for more BLE packets

    const frame = this._rxBuf.slice(0, frameLen);
    this._rxBuf = this._rxBuf.slice(frameLen);

    if (!this._currentBatch) return;
    const result = parseReadResponse(frame, this._currentBatch.start);
    if (result) {
      this.emit("registers", result.registers);
    } else {
      this._log(`[${this._name}] CRC error or unexpected frame, skipping batch`);
    }

    this._sendNextBatch();
  }

  // Length-prefixed AES envelope framing shared by the handshake and secure
  // phases: 2-byte plaintext length, then (4-byte IV seed + ciphertext) or
  // (ciphertext alone) depending on whether the IV is fixed for this key.
  // See BluettiV2Handshake.aesEncrypt/aesDecrypt.
  _expectedEncryptedLength(buf) {
    if (buf.length < 2) return null;
    const dataLen = (buf[0] << 8) | buf[1];
    const [, iv] = this._handshake.getKeyIv();
    const headerSize = iv === null ? 6 : 2;
    const paddedLen = Math.ceil(dataLen / 16) * 16;
    return headerSize + paddedLen;
  }

  _handleHandshakeData(data) {
    if (this._mode === "detecting") {
      if (!(data.length >= 4 && data[0] === 0x2a && data[1] === 0x2a)) return; // not a V2 challenge
      clearTimeout(this._detectTimer);
      this._detectTimer = null;
      this._mode = "handshaking";
    }

    const message = new Message(data);
    if (message.isPreKeyExchange) {
      if (message.type === MessageType.CHALLENGE) {
        try {
          this._writeRaw(this._handshake.handleChallenge(message));
        } catch (err) {
          this._log(`[${this._name}] Handshake error: ${err.message}`);
          this._scheduleReconnect();
        }
      }
      // CHALLENGE_ACCEPTED: nothing to do but wait for the encrypted pubkey exchange.
      return;
    }

    if (this._handshake.unsecureAesKey === null) {
      this._log(`[${this._name}] Received encrypted handshake message before key init`);
      return;
    }

    this._encBuf = Buffer.concat([this._encBuf, data]);
    const expectedLen = this._expectedEncryptedLength(this._encBuf);
    if (expectedLen === null || this._encBuf.length < expectedLen) return;
    const complete = this._encBuf.subarray(0, expectedLen);
    this._encBuf = this._encBuf.subarray(expectedLen);

    const [key, iv] = this._handshake.getKeyIv();
    let decrypted;
    try {
      decrypted = this._handshake.aesDecrypt(complete, key, iv);
    } catch (err) {
      this._log(`[${this._name}] Handshake decrypt error: ${err.message}`);
      this._encBuf = Buffer.alloc(0);
      return;
    }

    const inner = new Message(decrypted);
    if (!inner.isPreKeyExchange) return;

    try {
      if (inner.type === MessageType.PEER_PUBKEY) {
        this._writeRaw(this._handshake.handlePeerPubkey(inner));
        return;
      }
      if (inner.type === MessageType.PUBKEY_ACCEPTED) {
        this._handshake.handleKeyAccepted(inner);
        this._mode = "secure";
        this._encBuf = Buffer.alloc(0);
        this._log(`[${this._name}] Secure session established`);
        this._startPolling();
      }
    } catch (err) {
      this._log(`[${this._name}] Handshake error: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  _handleSecureData(data) {
    this._encBuf = Buffer.concat([this._encBuf, data]);
    const expectedLen = this._expectedEncryptedLength(this._encBuf);
    if (expectedLen === null || this._encBuf.length < expectedLen) return;
    const complete = this._encBuf.subarray(0, expectedLen);
    this._encBuf = this._encBuf.subarray(expectedLen);

    const [key, iv] = this._handshake.getKeyIv();
    let frame;
    try {
      frame = this._handshake.aesDecrypt(complete, key, iv);
    } catch (err) {
      this._log(`[${this._name}] Decrypt error: ${err.message}`);
      return;
    }

    if (!this._currentBatch) return;
    const result = parseReadResponse(frame, this._currentBatch.start);
    if (result) {
      this.emit("registers", result.registers);
    } else {
      this._log(`[${this._name}] CRC error or unexpected frame, skipping batch`);
    }

    this._sendNextBatch();
  }
}

module.exports = BluettiDevice;
