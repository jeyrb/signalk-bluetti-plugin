"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { crc16, buildReadRequest, completeFrameLength, parseReadResponse, applyXor, groupRegisters } = require("../lib/protocol");

// Independent CRC16/MODBUS (poly 0xA001, init 0xFFFF) reference implementation,
// built via a precomputed lookup table rather than protocol.js's bit-loop, so
// this cross-checks crc16() instead of just asserting it agrees with itself.
function buildCrcTable() {
  const table = new Array(256);
  for (let byte = 0; byte < 256; byte++) {
    let crc = byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    table[byte] = crc;
  }
  return table;
}
const CRC_TABLE = buildCrcTable();
function referenceCrc16(buf) {
  let crc = 0xffff;
  for (const byte of buf) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return crc;
}

describe("crc16", () => {
  test("matches an independent table-driven implementation", () => {
    const vectors = [
      Buffer.from([]),
      Buffer.from([0x01]),
      Buffer.from([0x01, 0x03, 0x00, 0x6b, 0x00, 0x03]),
      Buffer.from([0xff, 0x00, 0x7e, 0x11, 0x22]),
    ];
    for (const v of vectors) assert.equal(crc16(v), referenceCrc16(v));
  });

  test("empty buffer returns the initial value unchanged", () => {
    assert.equal(crc16(Buffer.from([])), 0xffff);
  });
});

describe("buildReadRequest", () => {
  test("builds a well-formed FC03 frame with a self-consistent CRC", () => {
    const frame = buildReadRequest(0x64, 5);
    assert.equal(frame.length, 8);
    assert.equal(frame[0], 0x01); // device address
    assert.equal(frame[1], 0x03); // FC03
    assert.equal(frame.readUInt16BE(2), 0x64);
    assert.equal(frame.readUInt16BE(4), 5);

    const expectedCrc = referenceCrc16(frame.subarray(0, 6));
    assert.equal(frame[6], expectedCrc & 0xff);
    assert.equal(frame[7], (expectedCrc >> 8) & 0xff);
  });
});

describe("completeFrameLength", () => {
  test("returns 0 for buffers shorter than the minimum frame", () => {
    assert.equal(completeFrameLength(Buffer.from([0x01, 0x03])), 0);
  });

  test("returns 0 when the device address byte is wrong", () => {
    assert.equal(completeFrameLength(Buffer.from([0x02, 0x03, 0x02, 0x00, 0x00, 0x00, 0x00])), 0);
  });

  test("returns full length for a complete FC03 response", () => {
    // header(3) + 2 bytes of register data + crc(2) = 7
    const buf = Buffer.from([0x01, 0x03, 0x02, 0x00, 0x64, 0x00, 0x00]);
    assert.equal(completeFrameLength(buf), 7);
  });

  test("returns 0 while an FC03 response is still incomplete", () => {
    const buf = Buffer.from([0x01, 0x03, 0x02, 0x00, 0x64]); // missing CRC bytes
    assert.equal(completeFrameLength(buf), 0);
  });

  test("returns 5 for a complete error response", () => {
    const buf = Buffer.from([0x01, 0x83, 0x02, 0x00, 0x00]);
    assert.equal(completeFrameLength(buf), 5);
  });

  test("returns 0 for an unrecognised function code", () => {
    const buf = Buffer.from([0x01, 0x05, 0x00, 0x00, 0x00]);
    assert.equal(completeFrameLength(buf), 0);
  });
});

describe("parseReadResponse", () => {
  function buildValidResponse(startRegister, values) {
    const body = Buffer.alloc(3 + values.length * 2);
    body[0] = 0x01;
    body[1] = 0x03;
    body[2] = values.length * 2;
    values.forEach((v, i) => body.writeUInt16BE(v, 3 + i * 2));
    const crc = crc16(body);
    return Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
  }

  test("decodes registers from a valid frame", () => {
    const frame = buildValidResponse(100, [11, 22, 33]);
    const result = parseReadResponse(frame, 100);
    assert.ok(result);
    assert.deepEqual(
      [...result.registers.entries()],
      [
        [100, 11],
        [101, 22],
        [102, 33],
      ],
    );
    assert.equal(result.startRegister, 100);
  });

  test("returns null on CRC mismatch", () => {
    const frame = buildValidResponse(100, [1]);
    frame[frame.length - 1] ^= 0xff; // corrupt CRC
    assert.equal(parseReadResponse(frame, 100), null);
  });

  test("returns null for an error frame", () => {
    const body = Buffer.from([0x01, 0x83, 0x02]);
    const crc = crc16(body);
    const frame = Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
    assert.equal(parseReadResponse(frame, 100), null);
  });

  test("returns null for an incomplete frame", () => {
    assert.equal(parseReadResponse(Buffer.from([0x01, 0x03]), 100), null);
  });
});

describe("applyXor", () => {
  test("returns the buffer unchanged when key is null or empty", () => {
    const buf = Buffer.from([1, 2, 3]);
    assert.equal(applyXor(buf, null), buf);
    assert.equal(applyXor(buf, Buffer.from([])), buf);
  });

  test("is self-inverse: applying twice with the same key restores the original", () => {
    const original = Buffer.from("hello bluetti", "utf8");
    const key = Buffer.from([0xaa, 0x55, 0x0f]);
    const scrambled = applyXor(original, key);
    assert.notDeepEqual(scrambled, original);
    const restored = applyXor(scrambled, key);
    assert.deepEqual(restored, original);
  });

  test("wraps the key across a longer buffer", () => {
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    const key = Buffer.from([0x01, 0x02]);
    assert.deepEqual(applyXor(buf, key), Buffer.from([0x01, 0x02, 0x01, 0x02]));
  });
});

describe("groupRegisters", () => {
  test("returns an empty array for no addresses", () => {
    assert.deepEqual(groupRegisters([]), []);
  });

  test("groups a contiguous run into a single batch", () => {
    assert.deepEqual(groupRegisters([100, 101, 102, 103]), [{ start: 100, count: 4 }]);
  });

  test("merges addresses within maxGap into one batch", () => {
    assert.deepEqual(groupRegisters([100, 105, 110], 10, 50), [{ start: 100, count: 11 }]);
  });

  test("splits into separate batches when the gap exceeds maxGap", () => {
    assert.deepEqual(groupRegisters([100, 200], 10, 50), [
      { start: 100, count: 1 },
      { start: 200, count: 1 },
    ]);
  });

  test("splits when a batch would exceed maxCount, even with a small gap", () => {
    const addrs = [0, 1, 2];
    assert.deepEqual(groupRegisters(addrs, 10, 2), [
      { start: 0, count: 2 },
      { start: 2, count: 1 },
    ]);
  });

  test("sorts unsorted input before grouping", () => {
    assert.deepEqual(groupRegisters([103, 100, 102, 101]), [{ start: 100, count: 4 }]);
  });
});
