"use strict";

const { decodeValue } = require("./csv-loader");

// SignalK requires specific SI units. These conversions handle the most common
// cases found in Bluetti register maps. The CSV's `unit` column drives the choice.
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
  if (unit === null || unit === undefined) return value;
  const key = unit.toLowerCase().trim();
  const fn = UNIT_CONVERSIONS[key];
  return fn ? fn(value) : value;
}

// Build a SignalK path for a field, substituting {name} with the device name.
// Falls back to auto-generating from fieldName if signalkPath is not set in CSV.
function resolvePath(field, deviceName) {
  if (field.signalkPath) {
    return field.signalkPath.replace(/\{name\}/gi, deviceName);
  }
  return autoPath(field.fieldName, deviceName);
}

// Best-effort automatic path generation for common Bluetti field names.
// Users with a properly-annotated CSV will never hit this; it's a safety net.
function autoPath(fieldName, name) {
  const f = fieldName.toLowerCase();
  if (f.includes("battery") || f.includes("batt") || f.includes("soc")) {
    if (f.includes("voltage") || f.includes("volt")) return `electrical.batteries.${name}.voltage`;
    if (f.includes("current") || f.includes("curr")) return `electrical.batteries.${name}.current`;
    if (f.includes("percent") || f.includes("soc") || f.includes("capacity")) return `electrical.batteries.${name}.stateOfCharge`;
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
    if (f.includes("power")) return `electrical.inverters.${name}.ac.power`;
    if (f.includes("voltage")) return `electrical.inverters.${name}.ac.voltage`;
    if (f.includes("current")) return `electrical.inverters.${name}.ac.current`;
    if (f.includes("freq")) return `electrical.inverters.${name}.ac.frequency`;
    return `electrical.inverters.${name}.ac.${fieldName}`;
  }
  if (f.includes("ac_input") || f.includes("mains") || f.includes("grid") || f.includes("charger")) {
    if (f.includes("power")) return `electrical.chargers.${name}.input.power`;
    if (f.includes("voltage")) return `electrical.chargers.${name}.input.voltage`;
    if (f.includes("current")) return `electrical.chargers.${name}.input.current`;
    return `electrical.chargers.${name}.input.${fieldName}`;
  }
  // Catch-all
  return `electrical.${name}.${fieldName}`;
}

// Given a Map of register→uint16 values and the full field list,
// produce a SignalK delta values array ready for app.handleMessage().
function buildDelta(registers, fields, deviceName, source) {
  const values = [];

  for (const field of fields) {
    const raw = decodeValue(field, registers);
    if (raw === null) continue;

    const converted = convertUnits(raw, field.unit);
    const path = resolvePath(field, deviceName);

    values.push({ path, value: converted });
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
