"use strict";

const fs = require("fs");
const { parse } = require("csv-parse/sync");

// Column name aliases — Bluetti CSVs have been seen in English and Chinese headers.
// Maps our internal key → list of possible header strings (case-insensitive match).
const COL_ALIASES = {
  field_name: ["field_name", "fieldname", "name", "字段名", "field"],
  register_address: ["register_address", "register", "address", "addr", "reg", "no", "no.", "寄存器", "地址"],
  data_type: ["data_type", "datatype", "type", "数据type", "数据类型"],
  scale: ["scale", "倍率", "factor", "multiplier"],
  offset: ["offset", "偏移"],
  unit: ["unit", "units", "单位"],
  signalk_path: ["signalk_path", "signalk", "sk_path", "path"],
  register_count: ["register_count", "count", "length", "bytes", "数据长度"],
};

function resolveColumn(headers, key) {
  const aliases = COL_ALIASES[key];
  for (const alias of aliases) {
    const found = headers.find((h) => h.trim().toLowerCase() === alias.toLowerCase());
    if (found) return found;
  }
  return null;
}

// Parse the CSV and return an array of field descriptors.
// Each descriptor: { fieldName, register, count, dataType, scale, offset, unit, signalkPath }
function loadCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");

  // Strip BOM if present
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    comment: "#",
  });

  if (records.length === 0) throw new Error(`CSV file ${filePath} has no data rows`);

  const headers = Object.keys(records[0]);

  const col = {};
  for (const key of Object.keys(COL_ALIASES)) {
    col[key] = resolveColumn(headers, key);
  }

  if (!col.register_address) throw new Error("CSV must have a register address column");
  if (!col.field_name) throw new Error("CSV must have a field name column");

  const fields = [];
  for (const row of records) {
    const registerRaw = row[col.register_address];
    const register = parseInt(registerRaw, 10);
    if (isNaN(register)) continue; // skip header-like rows embedded in data

    const dataType = col.data_type ? (row[col.data_type] || "uint16").toLowerCase().trim() : "uint16";
    const scale = col.scale ? parseFloat(row[col.scale]) || 1 : 1;
    const offset = col.offset ? parseFloat(row[col.offset]) || 0 : 0;
    const unit = col.unit ? (row[col.unit] || "").trim() : "";

    // register_count: for multi-register types (int32, uint32, float32 = 2 regs; int64 = 4 regs)
    let count = col.register_count ? parseInt(row[col.register_count], 10) : NaN;
    if (isNaN(count)) count = registersForType(dataType);

    const signalkPath = col.signalk_path ? (row[col.signalk_path] || "").trim() : "";
    const fieldName = (row[col.field_name] || "").trim();

    if (!fieldName) continue;

    fields.push({ fieldName, register, count, dataType, scale, offset, unit, signalkPath });
  }

  if (fields.length === 0) throw new Error(`No valid register rows found in ${filePath}`);
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

module.exports = { loadCsv, decodeValue };
