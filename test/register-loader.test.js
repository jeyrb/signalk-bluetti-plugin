"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadRegisters, decodeValue } = require("../lib/register-loader");

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bluetti-yaml-test-"));
});
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeYaml(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

describe("loadRegisters", () => {
  test("parses a basic field", () => {
    const p = writeYaml("basic.yaml", "fields:\n  battery_soc:\n    register: 100\n    unit: '%'\n");
    const fields = loadRegisters(p);
    assert.equal(fields.length, 1);
    assert.deepEqual(fields[0], {
      fieldName: "battery_soc",
      register: 100,
      count: 1,
      dataType: "uint16",
      scale: 1,
      offset: 0,
      unit: "%",
      signalkPath: "",
    });
  });

  test("applies explicit type, scale, offset, count and path", () => {
    const p = writeYaml(
      "explicit.yaml",
      "fields:\n" +
        "  battery_current:\n" +
        "    register: 102\n" +
        "    type: int16\n" +
        "    scale: 0.1\n" +
        "    offset: 5\n" +
        "    unit: A\n" +
        "    path: electrical.batteries.{name}.current\n",
    );
    const fields = loadRegisters(p);
    assert.deepEqual(fields[0], {
      fieldName: "battery_current",
      register: 102,
      count: 1,
      dataType: "int16",
      scale: 0.1,
      offset: 5,
      unit: "A",
      signalkPath: "electrical.batteries.{name}.current",
    });
  });

  test("infers register count from type when count is absent", () => {
    const p = writeYaml(
      "counts.yaml",
      "fields:\n" +
        "  a: { register: 1, type: uint16 }\n" +
        "  b: { register: 2, type: int32 }\n" +
        "  c: { register: 3, type: float32 }\n" +
        "  d: { register: 4, type: int64 }\n" +
        "  e: { register: 5, type: bool }\n",
    );
    const fields = loadRegisters(p);
    const byName = Object.fromEntries(fields.map((f) => [f.fieldName, f.count]));
    assert.deepEqual(byName, { a: 1, b: 2, c: 2, d: 4, e: 1 });
  });

  test("respects an explicit count override", () => {
    const p = writeYaml("count-override.yaml", "fields:\n  odd:\n    register: 1\n    type: uint16\n    count: 2\n");
    const fields = loadRegisters(p);
    assert.equal(fields[0].count, 2);
  });

  test("throws when a field has no register address", () => {
    const p = writeYaml("noreg.yaml", "fields:\n  bad:\n    unit: V\n");
    assert.throws(() => loadRegisters(p), /missing a numeric "register" address/);
  });

  test("throws when a field isn't a mapping", () => {
    const p = writeYaml("notmap.yaml", "fields:\n  bad: 100\n");
    assert.throws(() => loadRegisters(p), /must be a mapping/);
  });

  test("throws when the file has neither fields nor constants", () => {
    const p = writeYaml("empty.yaml", "{}\n");
    assert.throws(() => loadRegisters(p), /No fields or constants found/);
  });

  describe("constants", () => {
    test("parses a bare string constant", () => {
      const p = writeYaml("const-text.yaml", "constants:\n  battery_chemistry: LiFePO4\n");
      const fields = loadRegisters(p);
      assert.equal(fields.length, 1);
      assert.equal(fields[0].register, null);
      assert.equal(fields[0].count, 0);
      assert.equal(fields[0].dataType, "const");
      assert.equal(fields[0].constantValue, "LiFePO4");
      assert.equal(typeof fields[0].constantValue, "string");
    });

    test("parses an expanded numeric constant with a unit", () => {
      const p = writeYaml("const-num.yaml", "constants:\n  total_capacity:\n    value: 2000\n    unit: Wh\n");
      const fields = loadRegisters(p);
      assert.equal(fields[0].unit, "Wh");
      assert.equal(fields[0].constantValue, 2000);
      assert.equal(typeof fields[0].constantValue, "number");
    });

    test("parses a bare numeric constant with no unit", () => {
      const p = writeYaml("const-bare-num.yaml", "constants:\n  some_count: 3\n");
      const fields = loadRegisters(p);
      assert.equal(fields[0].constantValue, 3);
      assert.equal(fields[0].unit, "");
    });

    test("supports fields and constants together", () => {
      const p = writeYaml(
        "mixed.yaml",
        "fields:\n  battery_soc:\n    register: 100\n    unit: '%'\nconstants:\n  battery_chemistry: LiFePO4\n",
      );
      const fields = loadRegisters(p);
      assert.equal(fields.length, 2);
    });
  });
});

describe("decodeValue", () => {
  const baseField = { register: 10, count: 1, dataType: "uint16", scale: 1, offset: 0 };

  test("decodes a uint16 register", () => {
    const regs = new Map([[10, 1234]]);
    assert.equal(decodeValue(baseField, regs), 1234);
  });

  test("decodes a negative int16", () => {
    const field = { ...baseField, dataType: "int16" };
    const regs = new Map([[10, 0xffff]]); // -1
    assert.equal(decodeValue(field, regs), -1);
  });

  test("decodes a positive int16 unchanged", () => {
    const field = { ...baseField, dataType: "int16" };
    const regs = new Map([[10, 100]]);
    assert.equal(decodeValue(field, regs), 100);
  });

  test("decodes a uint32 across two registers", () => {
    const field = { ...baseField, dataType: "uint32", count: 2 };
    const regs = new Map([
      [10, 0x0001],
      [11, 0x0002],
    ]);
    assert.equal(decodeValue(field, regs), 0x00010002);
  });

  test("decodes a negative int32", () => {
    const field = { ...baseField, dataType: "int32", count: 2 };
    const regs = new Map([
      [10, 0xffff],
      [11, 0xffff],
    ]); // -1
    assert.equal(decodeValue(field, regs), -1);
  });

  test("decodes a float32", () => {
    const field = { ...baseField, dataType: "float32", count: 2 };
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(3.5, 0);
    const regs = new Map([
      [10, buf.readUInt16BE(0)],
      [11, buf.readUInt16BE(2)],
    ]);
    assert.equal(decodeValue(field, regs), 3.5);
  });

  test("decodes a bool as 0 or 1, ignoring scale/offset", () => {
    const field = { ...baseField, dataType: "bool", scale: 10, offset: 5 };
    assert.equal(decodeValue(field, new Map([[10, 0]])), 0);
    assert.equal(decodeValue(field, new Map([[10, 7]])), 1);
  });

  test("applies scale and offset", () => {
    const field = { ...baseField, scale: 0.1, offset: 5 };
    const regs = new Map([[10, 100]]);
    assert.equal(decodeValue(field, regs), 15); // 100*0.1 + 5
  });

  test("returns null when the register is missing", () => {
    assert.equal(decodeValue(baseField, new Map()), null);
  });

  test("returns null for a multi-register field missing either half", () => {
    const field = { ...baseField, count: 2 };
    assert.equal(decodeValue(field, new Map([[10, 1]])), null);
    assert.equal(decodeValue(field, new Map([[11, 1]])), null);
  });

  test("returns the constant directly, ignoring rawRegs, for dataType const", () => {
    const field = { register: null, count: 0, dataType: "const", scale: 1, offset: 0, constantValue: "LiFePO4" };
    assert.equal(decodeValue(field, new Map()), "LiFePO4");
  });
});
