'use strict';

// Modbus CRC16 (standard table-driven implementation)
function crc16(buf) {
  let crc = 0xFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x0001) ? (crc >> 1) ^ 0xA001 : crc >> 1;
    }
  }
  return crc;
}

// Build a Modbus RTU "read holding registers" request (function code 0x03)
function buildReadRequest(startRegister, count) {
  const buf = Buffer.alloc(8);
  buf[0] = 0x01;                          // device address (Bluetti uses 0x01)
  buf[1] = 0x03;                          // FC: read holding registers
  buf.writeUInt16BE(startRegister, 2);
  buf.writeUInt16BE(count, 4);
  const crc = crc16(buf.slice(0, 6));
  buf[6] = crc & 0xFF;
  buf[7] = (crc >> 8) & 0xFF;
  return buf;
}

// Check if an accumulated buffer contains a complete Modbus response.
// Returns byte length of the complete frame, or 0 if incomplete.
function completeFrameLength(buf) {
  if (buf.length < 5) return 0;
  if (buf[0] !== 0x01) return 0;
  if (buf[1] === 0x03) {
    const expected = 3 + buf[2] + 2;     // hdr(3) + data + crc(2)
    return buf.length >= expected ? expected : 0;
  }
  // Error response: FC | 0x80, error code, 2-byte CRC = 5 bytes
  if ((buf[1] & 0x80) !== 0) return buf.length >= 5 ? 5 : 0;
  return 0;
}

// Parse a complete Modbus RTU read-response frame.
// Returns { registers: Map<addr, uint16>, startRegister } or null on CRC error.
function parseReadResponse(buf, startRegister) {
  const frameLen = completeFrameLength(buf);
  if (frameLen === 0) return null;

  // CRC check
  const receivedCrc = buf[frameLen - 2] | (buf[frameLen - 1] << 8);
  const computedCrc = crc16(buf.slice(0, frameLen - 2));
  if (receivedCrc !== computedCrc) return null;

  // Error frame
  if ((buf[1] & 0x80) !== 0) return null;

  const byteCount = buf[2];
  const registers = new Map();
  for (let i = 0; i < byteCount / 2; i++) {
    const addr = startRegister + i;
    const val = buf.readUInt16BE(3 + i * 2);
    registers.set(addr, val);
  }
  return { registers, startRegister };
}

// Apply the optional XOR-based frame scrambling used by some Bluetti models.
// key is a Buffer. If key is null/empty, returns buf unchanged.
function applyXor(buf, key) {
  if (!key || key.length === 0) return buf;
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i++) {
    out[i] ^= key[i % key.length];
  }
  return out;
}

// Group a sorted list of register addresses into contiguous batches for polling.
// maxGap: if two adjacent addresses are more than this apart, start a new batch.
// maxCount: max registers per request.
function groupRegisters(addresses, maxGap = 10, maxCount = 50) {
  if (addresses.length === 0) return [];
  const sorted = [...addresses].sort((a, b) => a - b);
  const batches = [];
  let start = sorted[0];
  let end = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const addr = sorted[i];
    if (addr - end <= maxGap && addr - start < maxCount) {
      end = addr;
    } else {
      batches.push({ start, count: end - start + 1 });
      start = addr;
      end = addr;
    }
  }
  batches.push({ start, count: end - start + 1 });
  return batches;
}

module.exports = { crc16, buildReadRequest, completeFrameLength, parseReadResponse, applyXor, groupRegisters };
