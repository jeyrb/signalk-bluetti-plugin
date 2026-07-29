"use strict";

const { decodeValue } = require("./register-loader");

// SignalK requires specific SI units. These conversions handle the most common
// cases found in Bluetti register maps. The YAML field's `unit` key drives the choice.
const UNIT_CONVERSIONS = {
  // temperature: Bluetti reports in °C or 0.1°C (handled by scale), SignalK wants K
  c: (v) => v + 273.15,
  "°c": (v) => v + 273.15,
  degc: (v) => v + 273.15,

  // energy: Bluetti reports Wh, SignalK wants J
  wh: (v) => v * 3600,
  kwh: (v) => v * 3600000,

  // state of charge: Bluetti is 0–100, SignalK wants 0.0–1.0
  "%": (v) => v / 100,
  pct: (v) => v / 100,
  soc: (v) => v / 100,

  // everything else (V, A, W, Ah, Hz, min, s) is already SI — pass through
};

function convertUnits(value, unit) {
  if (unit === null || unit === undefined || typeof value !== "number") return value;
  const key = unit.toLowerCase().trim();
  const fn = UNIT_CONVERSIONS[key];
  return fn ? fn(value) : value;
}

// Canonical field_name → SignalK path for the register names Bluetti's own
// documentation and the bundled register maps use. A field's `path` key is an
// override on top of this — only needed for a register the code doesn't know
// about — so bundled/well-known register maps can leave it out and just list
// field_name + register info.
//
// ac_input_power, ac_input_voltage, and dc_output_power are intentionally
// absent here — they don't have a direct standard path of their own, they're
// only ever consumed as inputs to the derived charger/battery current in
// buildDelta() below.
const STANDARD_FIELD_PATHS = {
  // Battery
  battery_soc: "electrical.batteries.{name}.capacity.stateOfCharge",
  battery_percent: "electrical.batteries.{name}.capacity.stateOfCharge",
  battery_voltage: "electrical.batteries.{name}.voltage",
  battery_current: "electrical.batteries.{name}.current",
  battery_power: "electrical.batteries.{name}.power",
  battery_temperature: "electrical.batteries.{name}.temperature",
  battery_chemistry: "electrical.batteries.{name}.chemistry",
  battery_manufacturer_name: "electrical.batteries.{name}.manufacturer.name",
  battery_manufacturer_model: "electrical.batteries.{name}.manufacturer.model",
  total_capacity: "electrical.batteries.{name}.capacity.nominal",
  time_remaining_minutes: "electrical.batteries.{name}.capacity.timeRemaining",
  internal_temperature: "electrical.batteries.{name}.controllerTemperature",

  // Solar / DC input
  dc_input_power: "electrical.solar.{name}.panelPower",
  dc_input_voltage: "electrical.solar.{name}.panelVoltage",
  dc_input_current: "electrical.solar.{name}.panelCurrent",

  // AC output (inverter)
  ac_output_power: "electrical.inverters.{name}.ac.realPower",
  ac_output_voltage: "electrical.inverters.{name}.ac.voltage",
  ac_output_current: "electrical.inverters.{name}.ac.current",
  ac_output_frequency: "electrical.inverters.{name}.ac.frequency",

  // AC input (charger) — current/frequency map directly when a device has real
  // registers for them; if not, current is derived (see buildDelta below).
  ac_input_current: "electrical.chargers.{name}.current",
  ac_input_frequency: "electrical.chargers.{name}.frequency",
  grid_frequency: "electrical.chargers.{name}.frequency", // alias used by 3-phase/home-backup models

  // Lifetime energy generation counter (some models only)
  power_generation: "electrical.solar.{name}.energyGeneratedTotal",

  // Second PV string (dual-MPPT models) — the primary string uses dc_input_* above
  pv_s2_power: "electrical.solar.{name}.pv2.panelPower",
  pv_s2_voltage: "electrical.solar.{name}.pv2.panelVoltage",
  pv_s2_current: "electrical.solar.{name}.pv2.panelCurrent",

  // Per-phase grid (mains) input — split-phase/3-phase home-backup models
  grid_p1_power: "electrical.chargers.{name}.L1.power",
  grid_p1_voltage: "electrical.chargers.{name}.L1.voltage",
  grid_p1_current: "electrical.chargers.{name}.L1.current",
  grid_p2_power: "electrical.chargers.{name}.L2.power",
  grid_p2_voltage: "electrical.chargers.{name}.L2.voltage",
  grid_p2_current: "electrical.chargers.{name}.L2.current",
  grid_p3_power: "electrical.chargers.{name}.L3.power",
  grid_p3_voltage: "electrical.chargers.{name}.L3.voltage",
  grid_p3_current: "electrical.chargers.{name}.L3.current",

  // Per-phase AC output — split-phase/3-phase home-backup models
  ac_p1_power: "electrical.inverters.{name}.ac.L1.realPower",
  ac_p1_voltage: "electrical.inverters.{name}.ac.L1.voltage",
  ac_p1_current: "electrical.inverters.{name}.ac.L1.current",
  ac_p2_power: "electrical.inverters.{name}.ac.L2.realPower",
  ac_p2_voltage: "electrical.inverters.{name}.ac.L2.voltage",
  ac_p2_current: "electrical.inverters.{name}.ac.L2.current",
  ac_p3_power: "electrical.inverters.{name}.ac.L3.realPower",
  ac_p3_voltage: "electrical.inverters.{name}.ac.L3.voltage",
  ac_p3_current: "electrical.inverters.{name}.ac.L3.current",

  // Smart meter (external CT clamp on the home panel) — home-backup models only
  sm_p1_power: "electrical.inverters.{name}.smartMeter.L1.power",
  sm_p1_voltage: "electrical.inverters.{name}.smartMeter.L1.voltage",
  sm_p1_current: "electrical.inverters.{name}.smartMeter.L1.current",
  sm_p2_power: "electrical.inverters.{name}.smartMeter.L2.power",
  sm_p2_voltage: "electrical.inverters.{name}.smartMeter.L2.voltage",
  sm_p2_current: "electrical.inverters.{name}.smartMeter.L2.current",
  sm_p3_power: "electrical.inverters.{name}.smartMeter.L3.power",
  sm_p3_voltage: "electrical.inverters.{name}.smartMeter.L3.voltage",
  sm_p3_current: "electrical.inverters.{name}.smartMeter.L3.current",
};

// Fields that feed a derived computation in buildDelta() rather than being
// published under their own path directly.
const DERIVED_SOURCE_FIELDS = new Set(["ac_input_power", "ac_input_voltage", "dc_output_power", "dc_output_voltage"]);

// Build a SignalK path for a field: explicit `path` override first, then the
// standard field_name registry above, then a best-effort keyword guess.
function resolvePath(field, deviceName) {
  if (field.signalkPath) {
    return field.signalkPath.replace(/\{name\}/gi, deviceName);
  }
  const standard = STANDARD_FIELD_PATHS[field.fieldName.toLowerCase()];
  if (standard) return standard.replace(/\{name\}/g, deviceName);
  return autoPath(field.fieldName, deviceName);
}

// Best-effort automatic path generation for common Bluetti field names.
// Only reached for fields not in STANDARD_FIELD_PATHS above — i.e. a custom
// register map using field names the code doesn't recognise and no explicit override.
function autoPath(fieldName, name) {
  const f = fieldName.toLowerCase();
  if (f.includes("battery") || f.includes("batt") || f.includes("soc")) {
    if (f.includes("voltage") || f.includes("volt")) return `electrical.batteries.${name}.voltage`;
    if (f.includes("current") || f.includes("curr")) return `electrical.batteries.${name}.current`;
    if (f.includes("percent") || f.includes("soc") || f.includes("capacity")) return `electrical.batteries.${name}.capacity.stateOfCharge`;
    if (f.includes("temp")) return `electrical.batteries.${name}.temperature`;
    if (f.includes("power")) return `electrical.batteries.${name}.power`;
    if (f.includes("remain")) return `electrical.batteries.${name}.capacity.remaining`;
    return `electrical.batteries.${name}.${fieldName}`;
  }
  if (f.includes("dc_input") || f.includes("solar") || f.includes("pv")) {
    if (f.includes("power")) return `electrical.solar.${name}.panelPower`;
    if (f.includes("voltage")) return `electrical.solar.${name}.panelVoltage`;
    if (f.includes("current")) return `electrical.solar.${name}.panelCurrent`;
    return `electrical.solar.${name}.${fieldName}`;
  }
  if (f.includes("ac_output") || f.includes("inverter") || f.includes("ac_out")) {
    if (f.includes("power")) return `electrical.inverters.${name}.ac.realPower`;
    if (f.includes("voltage")) return `electrical.inverters.${name}.ac.voltage`;
    if (f.includes("current")) return `electrical.inverters.${name}.ac.current`;
    if (f.includes("freq")) return `electrical.inverters.${name}.ac.frequency`;
    return `electrical.inverters.${name}.ac.${fieldName}`;
  }
  if (f.includes("ac_input") || f.includes("mains") || f.includes("grid") || f.includes("charger")) {
    if (f.includes("power")) return `electrical.chargers.${name}.power`;
    if (f.includes("voltage")) return `electrical.chargers.${name}.voltage`;
    if (f.includes("current")) return `electrical.chargers.${name}.current`;
    return `electrical.chargers.${name}.${fieldName}`;
  }
  // Catch-all
  return `electrical.${name}.${fieldName}`;
}

// Given a Map of register→uint16 values and the full field list,
// produce a SignalK delta values array ready for app.handleMessage().
//
// opts.cache: a Map the caller keeps alive for the lifetime of the device,
// used to remember the last-known value of every field across polls. This is
// needed because a single call here only ever sees one batch's worth of
// registers (see groupRegisters in protocol.js) — e.g. ac_input_power and
// ac_input_voltage typically land in different batches, so deriving current
// from their ratio requires remembering whichever arrived most recently.
function buildDelta(registers, fields, deviceName, source, opts = {}) {
  const { cache = new Map() } = opts;
  const values = [];
  const hasRawAcInputCurrent = fields.some((f) => f.fieldName.toLowerCase() === "ac_input_current");

  for (const field of fields) {
    const raw = decodeValue(field, registers);
    if (raw === null) continue;

    const converted = convertUnits(raw, field.unit);
    const key = field.fieldName.toLowerCase();
    cache.set(key, converted);

    if (!field.signalkPath && DERIVED_SOURCE_FIELDS.has(key)) continue; // published below instead

    values.push({ path: resolvePath(field, deviceName), value: converted });
  }

  // AC mains charger: Bluetti reports power+voltage on this input, not
  // current — SignalK's electrical.chargers.<id> wants voltage/current, so
  // derive it (unless the device has a real current register — see above).
  if (cache.has("ac_input_voltage")) {
    values.push({ path: `electrical.chargers.${deviceName}.voltage`, value: cache.get("ac_input_voltage") });
  }
  if (!hasRawAcInputCurrent && cache.has("ac_input_power") && cache.has("ac_input_voltage")) {
    const voltage = cache.get("ac_input_voltage");
    const power = cache.get("ac_input_power");
    values.push({ path: `electrical.chargers.${deviceName}.current`, value: voltage ? power / voltage : 0 });
  }

  // DC output port (e.g. a 12V accessory socket): Bluetti reports power only,
  // at a fixed nominal voltage that isn't itself a register — the register map
  // supplies it as a constant (dc_output_voltage), and current is derived from that.
  if (cache.has("dc_output_power") && cache.has("dc_output_voltage")) {
    const power = cache.get("dc_output_power");
    const voltage = cache.get("dc_output_voltage");
    values.push({ path: `electrical.batteries.${deviceName}.voltage`, value: voltage });
    values.push({ path: `electrical.batteries.${deviceName}.current`, value: voltage ? power / voltage : 0 });
  }

  // Remaining capacity = nominal capacity × state of charge. Bluetti's own
  // "remaining capacity" register drifts with cell aging and isn't available
  // on every model; deriving it from a fixed nominal spec (see registers/*.yaml)
  // plus the reported SoC is simpler and consistent across models.
  const soc = cache.has("battery_soc") ? cache.get("battery_soc") : cache.has("battery_percent") ? cache.get("battery_percent") : null;
  if (soc !== null && cache.has("total_capacity")) {
    values.push({ path: `electrical.batteries.${deviceName}.capacity.remaining`, value: cache.get("total_capacity") * soc });
  }

  if (values.length === 0) return null;

  return {
    updates: [
      {
        source: { label: source },
        timestamp: new Date().toISOString(),
        values,
      },
    ],
  };
}

module.exports = { buildDelta, resolvePath, convertUnits };
