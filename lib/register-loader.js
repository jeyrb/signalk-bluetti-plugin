"use strict";

const fs = require("fs");
const YAML = require("yaml");

// Parse a register map YAML file and return an array of field descriptors.
// Each descriptor is either register-backed: { fieldName, register, count, dataType, scale, offset, unit, signalkPath }
// or a fixed constant (no register on the device): { fieldName, register: null, count: 0, dataType: "const", ..., constantValue }
//
// Expected shape:
//
//   fields:
//     battery_soc: { register: 100, type: uint16, unit: "%" }
//     battery_voltage: { register: 101, type: uint16, scale: 0.1, unit: V }
//   constants:
//     battery_chemistry: LiFePO4
//     total_capacity: { value: 2000, unit: Wh }
//
// `type` defaults to uint16, `scale` to 1, `offset` to 0, `count` is inferred
// from `type` when absent. `path` on a field/constant is an explicit SignalK
// path override (see lib/path-mapper.js). A constant may be a bare scalar
// (string or number) or an object with `value` (+ optional `unit`, `path`).
function loadRegisters(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const doc = YAML.parse(raw);
  if (!doc || typeof doc !== "object") throw new Error(`${filePath}: empty or invalid YAML register map`);

  const fields = [];

  for (const [fieldName, spec] of Object.entries(doc.fields || {})) {
    if (spec === null || typeof spec !== "object") {
      throw new Error(`${filePath}: field "${fieldName}" must be a mapping with at least a "register" key`);
    }
    const register = parseInt(spec.register, 10);
    if (isNaN(register)) throw new Error(`${filePath}: field "${fieldName}" is missing a numeric "register" address`);

    const dataType = String(spec.type || "uint16").toLowerCase();
    const count = Number.isInteger(spec.count) ? spec.count : registersForType(dataType);
    const scale = spec.scale !== undefined ? Number(spec.scale) : 1;
    const offset = spec.offset !== undefined ? Number(spec.offset) : 0;
    const unit = spec.unit !== undefined ? String(spec.unit) : "";
    const signalkPath = spec.path !== undefined ? String(spec.path) : "";

    fields.push({ fieldName, register, count, dataType, scale, offset, unit, signalkPath });
  }

  for (const [fieldName, spec] of Object.entries(doc.constants || {})) {
    const isExpanded = spec !== null && typeof spec === "object" && "value" in spec;
    const value = isExpanded ? spec.value : spec;
    const unit = isExpanded && spec.unit !== undefined ? String(spec.unit) : "";
    const signalkPath = isExpanded && spec.path !== undefined ? String(spec.path) : "";
    const constantValue = typeof value === "number" ? value : String(value);

    fields.push({ fieldName, register: null, count: 0, dataType: "const", scale: 1, offset: 0, unit, signalkPath, constantValue });
  }

  if (fields.length === 0) throw new Error(`No fields or constants found in ${filePath}`);
  return fields;
}

function registersForType(dataType) {
  switch (dataType) {
    case "int32":
    case "uint32":
    case "float32":
      return 2;
    case "int64":
    case "uint64":
      return 4;
    default:
      return 1; // uint16, int16, bool, enum
  }
}

// Decode a raw register value (or pair of registers for 32-bit types) into a number.
// rawRegs: Map<addr, uint16>, startAddr: the register address for this field
function decodeValue(field, rawRegs) {
  const { register, count, dataType, scale, offset } = field;

  if (dataType === "const") return field.constantValue;

  let raw;
  if (count === 1) {
    raw = rawRegs.get(register);
    if (raw === undefined) return null;
  } else if (count === 2) {
    const hi = rawRegs.get(register);
    const lo = rawRegs.get(register + 1);
    if (hi === undefined || lo === undefined) return null;
    raw = (hi << 16) | lo;
  } else {
    return null;
  }

  let value;
  switch (dataType) {
    case "int16":
      value = raw > 0x7fff ? raw - 0x10000 : raw;
      break;
    case "int32": {
      const signed = raw > 0x7fffffff ? raw - 0x100000000 : raw;
      value = signed;
      break;
    }
    case "float32": {
      const tmpBuf = Buffer.alloc(4);
      tmpBuf.writeUInt32BE(raw, 0);
      value = tmpBuf.readFloatBE(0);
      break;
    }
    case "bool":
      return raw !== 0 ? 1 : 0;
    default:
      value = raw;
  }

  return value * scale + offset;
}

module.exports = { loadRegisters, decodeValue };
