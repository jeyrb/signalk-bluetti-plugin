'use strict';

const fs = require('fs');

// Parse the Bluetti-provided encryption CSV file and return the XOR key hex string.
// Format: line 1 = "bluetti", line 2 = device timestamp, line 3 = short ID, line 4 = key.
function readEncryptionKey(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  if (lines[0] !== 'bluetti') throw new Error(`Not a Bluetti encryption file: ${csvPath}`);
  if (lines.length < 4) throw new Error(`Encryption file missing key line: ${csvPath}`);

  return lines[3];
}

module.exports = { readEncryptionKey };
