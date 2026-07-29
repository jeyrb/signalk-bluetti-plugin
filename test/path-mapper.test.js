"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { buildDelta, resolvePath, convertUnits } = require("../lib/path-mapper");

describe("convertUnits", () => {
  test("converts Celsius to Kelvin", () => {
    assert.equal(convertUnits(0, "C"), 273.15);
    assert.equal(convertUnits(0, "°C"), 273.15);
    assert.equal(convertUnits(0, "degC"), 273.15);
  });

  test("converts Wh to Joules", () => {
    assert.equal(convertUnits(1, "Wh"), 3600);
    assert.equal(convertUnits(1, "kWh"), 3600000);
  });

  test("converts percent-family units to a 0-1 ratio", () => {
    assert.equal(convertUnits(50, "%"), 0.5);
    assert.equal(convertUnits(50, "pct"), 0.5);
    assert.equal(convertUnits(50, "soc"), 0.5);
  });

  test("passes through units with no registered conversion", () => {
    assert.equal(convertUnits(42, "V"), 42);
    assert.equal(convertUnits(42, "A"), 42);
    assert.equal(convertUnits(42, ""), 42);
  });

  test("passes through when unit is null or undefined", () => {
    assert.equal(convertUnits(42, null), 42);
    assert.equal(convertUnits(42, undefined), 42);
  });

  test("passes through non-numeric values unchanged, even with a convertible unit", () => {
    assert.equal(convertUnits("LiFePO4", "%"), "LiFePO4");
  });

  test("is case-insensitive and trims whitespace on the unit", () => {
    assert.equal(convertUnits(0, " c "), 273.15);
  });
});

describe("resolvePath", () => {
  test("uses an explicit path override, substituting {name}", () => {
    const field = { fieldName: "whatever", signalkPath: "electrical.custom.{name}.thing" };
    assert.equal(resolvePath(field, "house"), "electrical.custom.house.thing");
  });

  test("override substitution is case-insensitive on the placeholder", () => {
    const field = { fieldName: "whatever", signalkPath: "electrical.custom.{NAME}.thing" };
    assert.equal(resolvePath(field, "house"), "electrical.custom.house.thing");
  });

  test("falls back to the standard field registry when no override is set", () => {
    const field = { fieldName: "battery_soc", signalkPath: "" };
    assert.equal(resolvePath(field, "house"), "electrical.batteries.house.capacity.stateOfCharge");
  });

  test("standard registry lookup is case-insensitive on field_name", () => {
    const field = { fieldName: "BATTERY_SOC", signalkPath: "" };
    assert.equal(resolvePath(field, "house"), "electrical.batteries.house.capacity.stateOfCharge");
  });

  test("falls back to autoPath's keyword guess for an unrecognised field_name", () => {
    assert.equal(resolvePath({ fieldName: "battery_weird_temp", signalkPath: "" }, "house"), "electrical.batteries.house.temperature");
    assert.equal(resolvePath({ fieldName: "solar_extra_voltage", signalkPath: "" }, "house"), "electrical.solar.house.panelVoltage");
    assert.equal(resolvePath({ fieldName: "ac_output_extra_current", signalkPath: "" }, "house"), "electrical.inverters.house.ac.current");
    assert.equal(resolvePath({ fieldName: "charger_extra_voltage", signalkPath: "" }, "house"), "electrical.chargers.house.voltage");
    assert.equal(resolvePath({ fieldName: "totally_unknown_thing", signalkPath: "" }, "house"), "electrical.house.totally_unknown_thing");
  });
});

describe("buildDelta", () => {
  function field(fieldName, register, opts = {}) {
    return { fieldName, register, count: 1, dataType: "uint16", scale: 1, offset: 0, unit: "", signalkPath: "", ...opts };
  }

  test("returns null when nothing decodes", () => {
    const fields = [field("battery_soc", 100)];
    assert.equal(buildDelta(new Map(), fields, "house", "src"), null);
  });

  test("publishes a directly-mapped field with unit conversion", () => {
    const fields = [field("battery_soc", 100, { unit: "%" })];
    const delta = buildDelta(new Map([[100, 80]]), fields, "house", "src");
    assert.equal(delta.updates.length, 1);
    assert.equal(delta.updates[0].source.label, "src");
    assert.deepEqual(delta.updates[0].values, [{ path: "electrical.batteries.house.capacity.stateOfCharge", value: 0.8 }]);
    assert.ok(delta.updates[0].timestamp);
  });

  test("respects an explicit signalk_path override", () => {
    const fields = [field("battery_soc", 100, { unit: "%", signalkPath: "electrical.custom.{name}.soc" })];
    const delta = buildDelta(new Map([[100, 80]]), fields, "house", "src");
    assert.deepEqual(delta.updates[0].values, [{ path: "electrical.custom.house.soc", value: 0.8 }]);
  });

  describe("derived AC charger current/voltage", () => {
    test("derives voltage and current from power+voltage across separate batch calls", () => {
      const fields = [field("ac_input_power", 114, { unit: "W" }), field("ac_input_voltage", 115, { unit: "V", scale: 0.1 })];
      const cache = new Map();

      // Batch 1: only power arrives
      let delta = buildDelta(new Map([[114, 300]]), fields, "house", "src", { cache });
      assert.equal(delta, null); // nothing publishable yet — voltage unknown

      // Batch 2: voltage arrives
      delta = buildDelta(new Map([[115, 2300]]), fields, "house", "src", { cache });
      const values = Object.fromEntries(delta.updates[0].values.map((v) => [v.path, v.value]));
      assert.equal(values["electrical.chargers.house.voltage"], 230);
      assert.equal(values["electrical.chargers.house.current"], 300 / 230);
      // power itself is not published under its own path
      assert.equal(Object.keys(values).length, 2);
    });

    test("does not derive current when a real ac_input_current register exists (avoids duplicate)", () => {
      const fields = [
        field("ac_input_power", 114, { unit: "W" }),
        field("ac_input_voltage", 115, { unit: "V" }),
        field("ac_input_current", 116, { unit: "A" }),
      ];
      const regs = new Map([
        [114, 300],
        [115, 230],
        [116, 13],
      ]);
      const delta = buildDelta(regs, fields, "house", "src", { cache: new Map() });
      const values = Object.fromEntries(delta.updates[0].values.map((v) => [v.path, v.value]));
      assert.equal(values["electrical.chargers.house.current"], 13); // from the real register, not 300/230
      assert.equal(values["electrical.chargers.house.voltage"], 230);
    });

    test("an explicit override on a derived-source field publishes it directly instead of suppressing it", () => {
      const fields = [field("ac_input_power", 114, { unit: "W", signalkPath: "electrical.custom.{name}.rawPower" })];
      const delta = buildDelta(new Map([[114, 300]]), fields, "house", "src", { cache: new Map() });
      assert.deepEqual(delta.updates[0].values, [{ path: "electrical.custom.house.rawPower", value: 300 }]);
    });
  });

  describe("derived DC output battery current/voltage", () => {
    test("requires both dc_output_power and dc_output_voltage before publishing", () => {
      const fields = [field("dc_output_power", 140, { unit: "W" }), field("dc_output_voltage", 141, { unit: "V" })];
      const cache = new Map();

      let delta = buildDelta(new Map([[140, 120]]), fields, "house", "src", { cache });
      assert.equal(delta, null);

      delta = buildDelta(new Map([[141, 12]]), fields, "house", "src", { cache });
      const values = Object.fromEntries(delta.updates[0].values.map((v) => [v.path, v.value]));
      assert.equal(values["electrical.batteries.house.voltage"], 12);
      assert.equal(values["electrical.batteries.house.current"], 10);
    });
  });

  describe("derived remaining capacity", () => {
    test("computes remaining = nominal (J) x stateOfCharge, from battery_soc", () => {
      const fields = [
        field("total_capacity", null, { unit: "Wh", dataType: "const", count: 0, constantValue: 2000 }),
        field("battery_soc", 100, { unit: "%" }),
      ];
      const delta = buildDelta(new Map([[100, 80]]), fields, "house", "src", { cache: new Map() });
      const values = Object.fromEntries(delta.updates[0].values.map((v) => [v.path, v.value]));
      assert.equal(values["electrical.batteries.house.capacity.nominal"], 2000 * 3600);
      assert.equal(values["electrical.batteries.house.capacity.remaining"], 2000 * 3600 * 0.8);
    });

    test("also works from battery_percent", () => {
      const fields = [
        field("total_capacity", null, { unit: "Wh", dataType: "const", count: 0, constantValue: 1024 }),
        field("battery_percent", 100, { unit: "%" }),
      ];
      const delta = buildDelta(new Map([[100, 90]]), fields, "house", "src", { cache: new Map() });
      const values = Object.fromEntries(delta.updates[0].values.map((v) => [v.path, v.value]));
      assert.equal(values["electrical.batteries.house.capacity.remaining"], 1024 * 3600 * 0.9);
    });

    test("is not published until state of charge is known", () => {
      const fields = [field("total_capacity", null, { unit: "Wh", dataType: "const", count: 0, constantValue: 2000 })];
      const delta = buildDelta(new Map(), fields, "house", "src", { cache: new Map() });
      const paths = delta.updates[0].values.map((v) => v.path);
      assert.ok(!paths.includes("electrical.batteries.house.capacity.remaining"));
    });
  });
});
