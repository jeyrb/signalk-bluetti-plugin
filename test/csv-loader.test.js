"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadCsv, decodeValue } = require("../lib/csv-loader");

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bluetti-csv-test-"));
});
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCsv(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

describe("loadCsv", () => {
  test("parses a basic English-header CSV", () => {
    const p = writeCsv(
      "basic.csv",
      "field_name,register_address,register_count,data_type,scale,offset,unit,signalk_path\n" + "battery_soc,100,1,uint16,1,0,%,\n",
    );
    const fields = loadCsv(p);
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

  test("resolves Chinese column header aliases", () => {
    const p = writeCsv("chinese.csv", "字段名,寄存器,数据长度,数据类型,倍率,偏移,单位,path\n" + "battery_voltage,101,1,uint16,0.1,0,V,\n");
    const fields = loadCsv(p);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].fieldName, "battery_voltage");
    assert.equal(fields[0].register, 101);
    assert.equal(fields[0].scale, 0.1);
  });

  test("strips a leading BOM", () => {
    const p = path.join(tmpDir, "bom.csv");
    fs.writeFileSync(p, "﻿" + "field_name,register_address\n" + "foo,1\n", "utf8");
    const fields = loadCsv(p);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].fieldName, "foo");
  });

  test("skips comment lines", () => {
    const p = writeCsv("comment.csv", "# a comment\nfield_name,register_address\n# another comment\nfoo,1\n");
    const fields = loadCsv(p);
    assert.equal(fields.length, 1);
  });

  test("skips rows with no register address and no constant_value", () => {
    const p = writeCsv("skip.csv", "field_name,register_address\n" + "good,1\n" + "bad,\n");
    const fields = loadCsv(p);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].fieldName, "good");
  });

  test("skips rows with no field_name", () => {
    const p = writeCsv("noname.csv", "field_name,register_address\n" + ",1\n" + "good,2\n");
    const fields = loadCsv(p);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].fieldName, "good");
  });

  test("throws if the register_address column is missing", () => {
    const p = writeCsv("noregcol.csv", "field_name,unit\nfoo,V\n");
    assert.throws(() => loadCsv(p), /register address column/);
  });

  test("throws if the field_name column is missing", () => {
    const p = writeCsv("nonamecol.csv", "register_address,unit\n1,V\n");
    assert.throws(() => loadCsv(p), /field name column/);
  });

  test("throws if the file has no data rows", () => {
    const p = writeCsv("empty.csv", "field_name,register_address\n");
    assert.throws(() => loadCsv(p), /no data rows/);
  });

  test("throws if no row produces a valid field", () => {
    const p = writeCsv("allinvalid.csv", "field_name,register_address\n" + ",\n" + "bad,\n");
    assert.throws(() => loadCsv(p), /No valid register rows found/);
  });

  test("infers register_count from data_type when the column is absent", () => {
    const p = writeCsv(
      "counts.csv",
      "field_name,register_address,data_type\n" + "a,1,uint16\n" + "b,2,int32\n" + "c,3,float32\n" + "d,4,int64\n" + "e,5,bool\n",
    );
    const fields = loadCsv(p);
    const byName = Object.fromEntries(fields.map((f) => [f.fieldName, f.count]));
    assert.deepEqual(byName, { a: 1, b: 2, c: 2, d: 4, e: 1 });
  });

  describe("constant_value rows", () => {
    test("parses a numeric constant as a number, applying no register lookup", () => {
      const p = writeCsv(
        "const-num.csv",
        "field_name,register_address,register_count,data_type,scale,offset,unit,signalk_path,constant_value\n" +
          "total_capacity,,,,,,Wh,,2000\n",
      );
      const fields = loadCsv(p);
      assert.equal(fields.length, 1);
      const f = fields[0];
      assert.equal(f.register, null);
      assert.equal(f.count, 0);
      assert.equal(f.dataType, "const");
      assert.equal(f.unit, "Wh");
      assert.equal(f.constantValue, 2000);
      assert.equal(typeof f.constantValue, "number");
    });

    test("parses a text constant as a string", () => {
      const p = writeCsv("const-text.csv", "field_name,register_address,unit,constant_value\n" + "battery_chemistry,,,LiFePO4\n");
      const fields = loadCsv(p);
      assert.equal(fields[0].constantValue, "LiFePO4");
      assert.equal(typeof fields[0].constantValue, "string");
    });

    test("tolerates short rows missing trailing columns (relax_column_count)", () => {
      const p = writeCsv(
        "short-rows.csv",
        "field_name,register_address,register_count,data_type,scale,offset,unit,signalk_path,constant_value\n" +
          "battery_soc,100,1,uint16,1,0,%\n",
      );
      const fields = loadCsv(p);
      assert.equal(fields.length, 1);
      assert.equal(fields[0].register, 100);
      assert.equal(fields[0].signalkPath, "");
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
