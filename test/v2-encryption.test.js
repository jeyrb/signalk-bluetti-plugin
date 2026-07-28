"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { BluettiV2Handshake, Message, KEX_MAGIC } = require("../lib/v2-encryption");

// Builds a pre-key-exchange frame: 2a2a <type><reserved><data...> <checksum(2)>.
// body[0] is the message type (Message#type); Message#data skips body[0..1],
// so real frames carry a 2-byte header before the payload — the second byte
// isn't read by anything under test, so any placeholder value works here.
function buildFrame(type, data, reserved = 0x00) {
  const body = Buffer.concat([Buffer.from([type, reserved]), data]);
  let sum = 0;
  for (const b of body) sum += b;
  const checksum = Buffer.alloc(2);
  checksum.writeUInt16BE(sum & 0xffff, 0);
  return Buffer.concat([KEX_MAGIC, body, checksum]);
}

describe("Message", () => {
  test("isPreKeyExchange is true only for frames starting with the KEX magic bytes", () => {
    const frame = buildFrame(1, Buffer.from([1, 2, 3, 4]));
    assert.ok(new Message(frame).isPreKeyExchange);
    assert.ok(!new Message(Buffer.from([0x00, 0x00, 0x00, 0x00])).isPreKeyExchange);
    assert.ok(!new Message(Buffer.from([0x2a])).isPreKeyExchange); // too short
  });

  test("type/data/body/checksum getters split the frame correctly", () => {
    const data = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    const frame = buildFrame(7, data, 0x99);
    const msg = new Message(frame);
    assert.equal(msg.type, 7);
    assert.deepEqual(msg.data, data);
    assert.deepEqual(msg.body, Buffer.concat([Buffer.from([7, 0x99]), data]));
    assert.deepEqual(msg.checksum, frame.subarray(frame.length - 2));
  });

  test("verifyChecksum is true for a correctly-checksummed frame and false when corrupted", () => {
    const frame = buildFrame(1, Buffer.from([1, 2, 3, 4]));
    assert.ok(new Message(frame).verifyChecksum());
    frame[frame.length - 1] ^= 0xff;
    assert.ok(!new Message(frame).verifyChecksum());
  });
});

describe("BluettiV2Handshake", () => {
  test("aesEncrypt/aesDecrypt round-trip with an explicit IV (secure/session key)", () => {
    const h = new BluettiV2Handshake();
    const key = crypto.randomBytes(32); // 256-bit session key
    const iv = crypto.randomBytes(16);
    const plaintext = Buffer.from("hello from the device, this is a test payload");

    const encrypted = h.aesEncrypt(plaintext, key, iv);
    const decrypted = h.aesDecrypt(encrypted, key, iv);
    assert.deepEqual(decrypted, plaintext);
  });

  test("aesEncrypt/aesDecrypt round-trip with a self-generated IV (unsecure key, iv=null)", () => {
    const h = new BluettiV2Handshake();
    const key = crypto.randomBytes(16); // 128-bit unsecure key
    const plaintext = Buffer.from("challenge-accepted payload");

    const encrypted = h.aesEncrypt(plaintext, key, null);
    const decrypted = h.aesDecrypt(encrypted, key, null);
    assert.deepEqual(decrypted, plaintext);
  });

  test("getKeyIv returns the unsecure key/iv before the session key is established, then the secure key", () => {
    const h = new BluettiV2Handshake();
    h.unsecureAesKey = Buffer.from("a");
    h.unsecureAesIv = Buffer.from("b");
    assert.deepEqual(h.getKeyIv(), [h.unsecureAesKey, h.unsecureAesIv]);

    h.secureAesKey = Buffer.from("c");
    assert.deepEqual(h.getKeyIv(), [h.secureAesKey, null]);
  });

  test("isReadyForCommands is false until both secureAesKey and peerPubkey are set", () => {
    const h = new BluettiV2Handshake();
    assert.ok(!h.isReadyForCommands);
    h.secureAesKey = Buffer.from("k");
    assert.ok(!h.isReadyForCommands);
    h.peerPubkey = Buffer.from("p");
    assert.ok(h.isReadyForCommands);
  });

  describe("handleChallenge", () => {
    test("derives a deterministic unsecureAesIv from the reversed challenge bytes", () => {
      const h = new BluettiV2Handshake();
      const challenge = Buffer.from([0x11, 0x22, 0x33, 0x44]);
      const frame = buildFrame(1, challenge);
      h.handleChallenge(new Message(frame));

      const expectedIv = crypto.createHash("md5").update(Buffer.from(challenge).reverse()).digest();
      assert.deepEqual(h.unsecureAesIv, expectedIv);
      assert.equal(h.unsecureAesKey.length, 16);
    });

    test("key/iv derivation is deterministic across independent handshakes given the same challenge", () => {
      const challenge = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
      const a = new BluettiV2Handshake();
      const b = new BluettiV2Handshake();
      a.handleChallenge(new Message(buildFrame(1, challenge)));
      b.handleChallenge(new Message(buildFrame(1, challenge)));
      assert.deepEqual(a.unsecureAesIv, b.unsecureAesIv);
      assert.deepEqual(a.unsecureAesKey, b.unsecureAesKey);
    });

    test("returns a well-formed, correctly-checksummed pre-key-exchange response", () => {
      const h = new BluettiV2Handshake();
      const challenge = Buffer.from([1, 2, 3, 4]);
      const response = h.handleChallenge(new Message(buildFrame(1, challenge)));

      assert.equal(response[0], KEX_MAGIC[0]);
      assert.equal(response[1], KEX_MAGIC[1]);
      assert.ok(new Message(response).verifyChecksum());
    });

    test("throws on a challenge that isn't 4 bytes", () => {
      const h = new BluettiV2Handshake();
      const frame = buildFrame(1, Buffer.from([1, 2, 3]));
      assert.throws(() => h.handleChallenge(new Message(frame)), /Unexpected challenge length/);
    });
  });

  describe("handlePeerPubkey", () => {
    test("throws when the decrypted payload isn't 128 bytes", () => {
      const h = new BluettiV2Handshake();
      h.unsecureAesIv = crypto.randomBytes(16);
      const frame = buildFrame(4, Buffer.alloc(10)); // way short of 128
      assert.throws(() => h.handlePeerPubkey(new Message(frame)), /Unexpected message length/);
    });

    test("throws on a well-formed-length message with an invalid signature", () => {
      const h = new BluettiV2Handshake();
      h.unsecureAesIv = crypto.randomBytes(16);
      const frame = buildFrame(4, crypto.randomBytes(128)); // right length, garbage signature
      assert.throws(() => h.handlePeerPubkey(new Message(frame)), /Invalid signature/);
    });
  });

  describe("handleKeyAccepted", () => {
    test("throws when the payload isn't exactly 1 byte", () => {
      const h = new BluettiV2Handshake();
      const frame = buildFrame(6, Buffer.from([0, 0]));
      assert.throws(() => h.handleKeyAccepted(new Message(frame)), /Unexpected key-accepted length/);
    });

    test("throws when the acceptance byte is non-zero", () => {
      const h = new BluettiV2Handshake();
      const frame = buildFrame(6, Buffer.from([1]));
      assert.throws(() => h.handleKeyAccepted(new Message(frame)), /not 0/);
    });
  });
});
