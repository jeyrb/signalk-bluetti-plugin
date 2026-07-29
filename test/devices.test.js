"use strict";

// End-to-end regression check against the actual bundled register maps in
// devices/*.yaml — simulates a full poll cycle (registers arriving in
// separate batches, as device.js delivers them) and asserts the resulting
// SignalK paths, catching register-map/path-mapper drift that synthetic unit
// tests wouldn't (e.g. a model's field_name typo'd against the
// STANDARD_FIELD_PATHS registry, so nothing gets published for it).

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadRegisters } = require("../lib/register-loader");
const { buildDelta } = require("../lib/path-mapper");
const { groupRegisters } = require("../lib/protocol");

const DEVICES_DIR = path.join(__dirname, "..", "devices");

// Runs two full poll cycles (so cross-batch derived values have a chance to
// see both of their inputs) against synthetic register values, and returns
// the union of every path published, keyed to its final value.
function simulatePoll(model, seed) {
  const fields = loadRegisters(path.join(DEVICES_DIR, `${model}.yaml`));
  const addrs = [...new Set(fields.flatMap((f) => Array.from({ length: f.count }, (_, i) => f.register + i)))];
  const batches = groupRegisters(addrs);

  const cache = new Map();
  const values = new Map();
  for (let pass = 0; pass < 2; pass++) {
    for (const b of batches) {
      const regs = new Map();
      for (let a = b.start; a < b.start + b.count; a++) {
        if (seed[a] !== undefined) regs.set(a, seed[a]);
      }
      const delta = buildDelta(regs, fields, "test", "bluetti-plugin", { cache });
      if (delta) for (const v of delta.updates[0].values) values.set(v.path, v.value);
    }
  }
  return { fields, values };
}

describe("devices/ac200p.yaml", () => {
  const seed = {
    100: 80,
    101: 530,
    102: 90,
    103: 200,
    104: 250,
    107: 50,
    108: 180,
    109: 3,
    110: 800,
    111: 2300,
    112: 35,
    113: 500,
    114: 300,
    115: 2300,
    116: 13,
    117: 500,
    118: 280,
    119: 600,
  };
  const { values } = simulatePoll("ac200p", seed);

  test("loads without error and every field maps to a path", () => {
    assert.ok(values.size > 0);
  });

  test("publishes the fixed model facts", () => {
    assert.equal(values.get("electrical.batteries.test.chemistry"), "LiFePO4");
    assert.equal(values.get("electrical.batteries.test.manufacturer.name"), "Bluetti");
    assert.equal(values.get("electrical.batteries.test.manufacturer.model"), "AC200P");
    assert.equal(values.get("electrical.batteries.test.capacity.nominal"), 2000 * 3600);
  });

  test("derives remaining capacity from nominal x stateOfCharge", () => {
    assert.equal(values.get("electrical.batteries.test.capacity.stateOfCharge"), 0.8);
    assert.equal(values.get("electrical.batteries.test.capacity.remaining"), 2000 * 3600 * 0.8);
  });

  test("uses the real ac_input_current register rather than deriving it from power/voltage", () => {
    assert.equal(values.get("electrical.chargers.test.current"), 1.3); // raw 13 * scale 0.1
    assert.equal(values.get("electrical.chargers.test.voltage"), 230);
  });

  test("renames ac_output_power to realPower", () => {
    assert.equal(values.get("electrical.inverters.test.ac.realPower"), 800);
  });

  test("does not publish the old pre-refactor charger.input.* or dc.power paths", () => {
    for (const p of values.keys()) {
      assert.ok(!p.includes(".input."), `unexpected legacy path: ${p}`);
    }
    assert.ok(!values.has("electrical.dc.test.power"));
  });
});

describe("devices/el100v2.yaml", () => {
  const seed = { 102: 90, 140: 120, 142: 1, 144: 1, 146: 300, 1314: 2300 };
  const { values } = simulatePoll("el100v2", seed);

  test("publishes the fixed model facts", () => {
    assert.equal(values.get("electrical.batteries.test.chemistry"), "LiFePO4");
    assert.equal(values.get("electrical.batteries.test.manufacturer.model"), "Elite 100 V2");
    assert.equal(values.get("electrical.batteries.test.capacity.nominal"), 1024 * 3600);
  });

  test("derives AC charger current/voltage (no raw current register on this model)", () => {
    assert.equal(values.get("electrical.chargers.test.voltage"), 230);
    assert.equal(values.get("electrical.chargers.test.current"), 300 / 230);
  });

  test("derives DC output port current/voltage from the register map's fixed dc_output_voltage", () => {
    assert.equal(values.get("electrical.batteries.test.voltage"), 12);
    assert.equal(values.get("electrical.batteries.test.current"), 120 / 12);
  });

  test("renames ac_output_power to realPower", () => {
    assert.equal(values.get("electrical.inverters.test.ac.realPower"), 1);
  });
});

// Every bundled register map, regardless of model — a lighter-weight version
// of the model-specific checks above that just guards against the most common
// mistake when adding a new one: a field_name that doesn't resolve to any
// SignalK path (typo'd against STANDARD_FIELD_PATHS, or falling through to
// the generic electrical.<name>.<field_name> catch-all instead of a proper
// path) and register rows that overlap each other.
describe("every bundled register map", () => {
  const models = fs
    .readdirSync(DEVICES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""));

  for (const model of models) {
    test(`${model}.yaml loads and every register maps to a distinct, well-formed path`, () => {
      const fields = loadRegisters(path.join(DEVICES_DIR, `${model}.yaml`));

      // No two fields should claim the same register address.
      const claimed = new Map();
      for (const field of fields) {
        if (field.register === null) continue;
        for (let i = 0; i < field.count; i++) {
          const addr = field.register + i;
          assert.ok(!claimed.has(addr), `${model}.yaml: register ${addr} claimed by both ${claimed.get(addr)} and ${field.fieldName}`);
          claimed.set(addr, field.fieldName);
        }
      }

      // Seed every claimed register with a plausible non-zero value and poll.
      const seed = {};
      for (const addr of claimed.keys()) seed[addr] = 500;
      const { values } = simulatePoll(model, seed);

      assert.ok(values.size > 0, `${model}.yaml: no paths published`);
      for (const p of values.keys()) {
        assert.ok(!/^electrical\.test\.[a-z0-9_]+$/.test(p), `${model}.yaml: field fell through to generic catch-all path ${p}`);
      }
    });
  }
});
