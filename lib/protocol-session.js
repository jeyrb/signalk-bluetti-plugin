"use strict";

const EventEmitter = require("events");
const { buildReadRequest, completeFrameLength, parseReadResponse, applyXor, groupRegisters } = require("./protocol");
const { BluettiV2Handshake, Message, MessageType } = require("./v2-encryption");

// Some Bluetti models ("V2" protocol — EL100V2, EL30V2, PR100V2, PR30V2, ...)
// push an unencrypted handshake CHALLENGE as soon as notifications are enabled,
// before we've sent anything. If nothing arrives in this window, assume the
// device speaks the plain/XOR protocol and start polling normally.
const HANDSHAKE_DETECT_MS = 3000;

// Runs the Modbus-over-BLE protocol (legacy XOR framing, and the V2 ECDH/AES
// handshake) against register batches — independent of how bytes actually
// reach the device. A transport (lib/device.js for direct BlueZ, or
// lib/ble-manager-device.js for the SignalK BLE Manager API) owns the GATT
// connection lifecycle: it calls start() once subscribed, feed() with each
// notification payload, and stop() on disconnect; this class calls back into
// the transport-supplied `sendFrame` to write bytes, and emits 'registers'
// when a batch decodes successfully, or 'protocolError' when the handshake
// fails in a way that requires reconnecting.
class ProtocolSession extends EventEmitter {
  constructor({ name, fields, xorKey = null, pollIntervalMs = 10000, log, sendFrame }) {
    super();
    this._name = name;
    this._xorKey = xorKey;
    this._pollIntervalMs = pollIntervalMs;
    this._log = log;
    this._sendFrame = sendFrame;

    this._rxBuf = Buffer.alloc(0);
    this._currentBatch = null; // { start, count } being awaited
    this._batchQueue = [];
    this._pollTimer = null;

    // V2 handshake state — see _armHandshakeDetection().
    this._mode = null; // "detecting" | "legacy" | "handshaking" | "secure"
    this._handshake = null;
    this._encBuf = Buffer.alloc(0);
    this._detectTimer = null;

    const addrs = [...new Set(fields.flatMap((f) => Array.from({ length: f.count }, (_, i) => f.register + i)))];
    this._batches = groupRegisters(addrs);
    this._log(`[${name}] Poll plan: ${this._batches.length} batch(es) covering ${addrs.length} registers`);
  }

  // Call once the GATT connection is established and notifications are subscribed.
  start() {
    this._mode = "detecting";
    this._handshake = new BluettiV2Handshake();
    this._encBuf = Buffer.alloc(0);
    this._armHandshakeDetection();
  }

  // Call on disconnect. The transport is expected to call start() again after
  // it reconnects.
  stop() {
    this._stopPolling();
    if (this._detectTimer) {
      clearTimeout(this._detectTimer);
      this._detectTimer = null;
    }
    this._mode = null;
    this._handshake = null;
    this._encBuf = Buffer.alloc(0);
  }

  // Call with each raw notification payload received from the BLE characteristic.
  feed(data) {
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

  // Wait briefly for a spontaneous V2 handshake CHALLENGE before assuming this
  // device speaks the plain/XOR protocol. See HANDSHAKE_DETECT_MS.
  _armHandshakeDetection() {
    this._detectTimer = setTimeout(() => {
      this._detectTimer = null;
      if (this._mode === "detecting") {
        this._mode = "legacy";
        this._startPolling();
      }
    }, HANDSHAKE_DETECT_MS);
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
    if (this._batches.length === 0) return;
    this._batchQueue = [...this._batches];
    this._rxBuf = Buffer.alloc(0);
    this._encBuf = Buffer.alloc(0);
    this._sendNextBatch();
  }

  _sendNextBatch() {
    if (this._batchQueue.length === 0) return;
    this._currentBatch = this._batchQueue.shift();
    const { start, count } = this._currentBatch;
    let frame = buildReadRequest(start, count);
    if (this._mode === "secure") {
      frame = this._handshake.aesEncrypt(frame, this._handshake.secureAesKey, null);
    } else if (this._xorKey) {
      frame = applyXor(frame, this._xorKey);
    }
    this._rxBuf = Buffer.alloc(0);
    this._sendFrame(frame);
  }

  // ── Receive ──────────────────────────────────────────────────────────────

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
          this._sendFrame(this._handshake.handleChallenge(message));
        } catch (err) {
          this._log(`[${this._name}] Handshake error: ${err.message}`);
          this.emit("protocolError", err);
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
        this._sendFrame(this._handshake.handlePeerPubkey(inner));
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
      this.emit("protocolError", err);
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

module.exports = ProtocolSession;
