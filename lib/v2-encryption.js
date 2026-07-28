"use strict";

// Bluetti "V2" BLE encryption handshake (EL100V2, EL30V2, PR100V2, PR30V2, ...).
//
// These devices reject plaintext Modbus frames and instead run a handshake over
// the same notify/write characteristics used for register polling:
//   1. Device sends an unencrypted CHALLENGE (4 random bytes).
//   2. We derive an "unsecure" AES-128-CBC key/IV from the challenge (MD5 + XOR
//      against a fixed local key) and echo back a CHALLENGE_ACCEPTED.
//   3. Device sends its ECDSA-signed ephemeral public key (secp256r1), encrypted
//      with the unsecure key. We verify the signature against a fixed well-known
//      public key, generate our own ephemeral keypair, sign it with a fixed
//      well-known private key, and send it back (still under the unsecure key).
//   4. Device confirms; we derive the session key via ECDH and switch to it
//      (AES-256-CBC, random IV per message) for all further traffic, which is
//      then ordinary Modbus RTU framing (see protocol.js) wrapped in AES.
//
// Ported from the wire format documented by Patrick762/bluetti-bt-lib
// (bluetti_bt_lib/bluetooth/encryption.py), itself based on
// nhurman/bluetti_mqtt. Validated against a real EL100V2's captured CHALLENGE
// frame (checksum matched exactly) before use here.

const crypto = require("crypto");

const KEX_MAGIC = Buffer.from([0x2a, 0x2a]);
const AES_BLOCK_SIZE = 16;
const CURVE = "prime256v1"; // secp256r1 / P-256

// Fixed, well-known constants baked into every Bluetti "V2" client — not
// per-device secrets. Same for every unit of these models.
const LOCAL_AES_KEY = Buffer.from("459FC535808941F17091E0993EE3E93D", "hex");
const PRIVATE_KEY_L1_HEX = "4F19A16E3E87BDD9BD24D3E5495B88041511943CBC8B969ADE9641D0F56AF337";
const PUBLIC_KEY_K2_DER = Buffer.from(
  "3059301306072a8648ce3d020106082a8648ce3d03010703420004" +
    "A73ABF5D2232C8C1C72E68304343C272495E3A8FD6F30EA96DE2F4B3CE60B251EE21AC667CF8A71E18B46B664EAEFFE3C489F24F695B6411DB7E22CCC85A8594",
  "hex",
);

const MessageType = {
  CHALLENGE: 1,
  CHALLENGE_ACCEPTED: 3,
  PEER_PUBKEY: 4,
  PUBKEY_ACCEPTED: 6,
};

function hexsum2(buf) {
  let sum = 0;
  for (const b of buf) sum += b;
  const out = Buffer.alloc(2);
  out.writeUInt16BE(sum & 0xffff, 0);
  return out;
}

function xorBuffers(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i % b.length];
  return out;
}

// Converts a hex-encoded big integer to a fixed-length 32-byte big-endian
// buffer, regardless of leading zero padding/truncation in the source hex.
function scalarFromHex32(hex) {
  const n = BigInt(`0x${hex}`);
  let h = n.toString(16);
  if (h.length % 2) h = `0${h}`;
  let buf = Buffer.from(h, "hex");
  if (buf.length < 32) buf = Buffer.concat([Buffer.alloc(32 - buf.length), buf]);
  else if (buf.length > 32) buf = buf.subarray(buf.length - 32);
  return buf;
}

function ecPrivateKeyFromScalar(scalar32) {
  const ecdh = crypto.createECDH(CURVE);
  ecdh.setPrivateKey(scalar32);
  const pub = ecdh.getPublicKey(); // 0x04 || X(32) || Y(32)
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: scalar32.toString("base64url"),
    x: pub.subarray(1, 33).toString("base64url"),
    y: pub.subarray(33, 65).toString("base64url"),
  };
  return crypto.createPrivateKey({ key: jwk, format: "jwk" });
}

const PRIVATE_KEY_L1 = ecPrivateKeyFromScalar(scalarFromHex32(PRIVATE_KEY_L1_HEX));
const PUBLIC_KEY_K2 = crypto.createPublicKey({ key: PUBLIC_KEY_K2_DER, format: "der", type: "spki" });

function verifyAndExtractSignedData(message, signedDataSuffix) {
  if (message.length !== 128) throw new Error("Unexpected message length");
  const data = message.subarray(0, 64);
  const signature = message.subarray(64);
  const signedData = Buffer.concat([data, signedDataSuffix]);
  const ok = crypto.verify("sha256", signedData, { key: PUBLIC_KEY_K2, dsaEncoding: "ieee-p1363" }, signature);
  if (!ok) throw new Error("Invalid signature on peer pubkey");
  return data;
}

// Pre-key-exchange framing: 2a2a <body...> <checksum(2)>, where body[0] is the
// message type. Also reused for the plaintext of decrypted PEER_PUBKEY /
// PUBKEY_ACCEPTED messages, which carry the same envelope.
class Message {
  constructor(buffer) {
    this.buffer = buffer;
  }

  get isPreKeyExchange() {
    return this.buffer.length >= 4 && this.buffer[0] === KEX_MAGIC[0] && this.buffer[1] === KEX_MAGIC[1];
  }

  get body() {
    return this.buffer.subarray(2, this.buffer.length - 2);
  }

  get checksum() {
    return this.buffer.subarray(this.buffer.length - 2);
  }

  get data() {
    return this.body.subarray(2);
  }

  get type() {
    return this.body[0];
  }

  verifyChecksum() {
    return hexsum2(this.body).equals(this.checksum);
  }
}

class BluettiV2Handshake {
  constructor() {
    this.unsecureAesKey = null;
    this.unsecureAesIv = null;
    this.secureAesKey = null;
    this.peerPubkey = null; // 65-byte uncompressed point (0x04 || X || Y)
    this._myEcdh = null;
  }

  get isReadyForCommands() {
    return this.secureAesKey !== null && this.peerPubkey !== null;
  }

  getKeyIv() {
    return this.secureAesKey === null ? [this.unsecureAesKey, this.unsecureAesIv] : [this.secureAesKey, null];
  }

  aesDecrypt(data, key, iv) {
    const dataLen = (data[0] << 8) | data[1];
    let realIv = iv;
    let encrypted;
    if (realIv === null) {
      realIv = crypto.createHash("md5").update(data.subarray(2, 6)).digest();
      encrypted = data.subarray(6);
    } else {
      encrypted = data.subarray(2);
    }
    if (encrypted.length % AES_BLOCK_SIZE !== 0) throw new Error("Data not aligned on AES block size");

    const algo = key.length === 16 ? "aes-128-cbc" : "aes-256-cbc";
    const decipher = crypto.createDecipheriv(algo, key, realIv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.subarray(0, dataLen);
  }

  aesEncrypt(data, key, iv) {
    let realIv = iv;
    let header = Buffer.alloc(2);
    header.writeUInt16BE(data.length, 0);
    if (realIv === null) {
      const ivSeed = crypto.randomBytes(4);
      realIv = crypto.createHash("md5").update(ivSeed).digest();
      header = Buffer.concat([header, ivSeed]);
    }

    const padding = (AES_BLOCK_SIZE - (data.length % AES_BLOCK_SIZE)) % AES_BLOCK_SIZE;
    const padded = Buffer.concat([data, Buffer.alloc(padding)]);

    const algo = key.length === 16 ? "aes-128-cbc" : "aes-256-cbc";
    const cipher = crypto.createCipheriv(algo, key, realIv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    return Buffer.concat([header, encrypted]);
  }

  // Returns the raw bytes to write back in response, or null.
  handleChallenge(message) {
    if (message.data.length !== 4) throw new Error("Unexpected challenge length");

    const reversed = Buffer.from(message.data).reverse();
    this.unsecureAesIv = crypto.createHash("md5").update(reversed).digest();
    this.unsecureAesKey = xorBuffers(this.unsecureAesIv, LOCAL_AES_KEY);

    const body = Buffer.concat([Buffer.from("0204", "hex"), this.unsecureAesIv.subarray(8, 12)]);
    return Buffer.concat([KEX_MAGIC, body, hexsum2(body)]);
  }

  // `message` is the decrypted PEER_PUBKEY payload. Returns AES-encrypted
  // bytes to write back.
  handlePeerPubkey(message) {
    const data = verifyAndExtractSignedData(message.data, this.unsecureAesIv);
    this.peerPubkey = Buffer.concat([Buffer.from([0x04]), data]);

    this._myEcdh = crypto.createECDH(CURVE);
    this._myEcdh.generateKeys();
    const myPubkeyBytes = this._myEcdh.getPublicKey().subarray(1);

    const toSign = Buffer.concat([myPubkeyBytes, this.unsecureAesIv]);
    const signature = crypto.sign("sha256", toSign, { key: PRIVATE_KEY_L1, dsaEncoding: "ieee-p1363" });

    const body = Buffer.concat([Buffer.from("0580", "hex"), myPubkeyBytes, signature]);
    const msg = Buffer.concat([KEX_MAGIC, body, hexsum2(body)]);
    return this.aesEncrypt(msg, this.unsecureAesKey, this.unsecureAesIv);
  }

  // `message` is the decrypted PUBKEY_ACCEPTED payload.
  handleKeyAccepted(message) {
    if (message.data.length !== 1) throw new Error("Unexpected key-accepted length");
    if (message.data[0] !== 0) throw new Error("Key acceptance response is not 0");
    this.secureAesKey = this._myEcdh.computeSecret(this.peerPubkey);
  }
}

module.exports = { BluettiV2Handshake, Message, MessageType, KEX_MAGIC };
