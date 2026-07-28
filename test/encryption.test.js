"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readEncryptionKey } = require("../lib/encryption");

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bluetti-enc-test-"));
});
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

describe("readEncryptionKey", () => {
  test("returns the 4th line as the key", () => {
    const p = writeFile("valid.csv", "bluetti\n1700000000\nABCD1234\ndeadbeef01234567\n");
    assert.equal(readEncryptionKey(p), "deadbeef01234567");
  });

  test("ignores blank lines when locating the key line", () => {
    const p = writeFile("blank-lines.csv", "bluetti\n\n1700000000\n\nABCD1234\n\ndeadbeef01234567\n\n");
    assert.equal(readEncryptionKey(p), "deadbeef01234567");
  });

  test("throws when the first line isn't 'bluetti'", () => {
    const p = writeFile("wrong-header.csv", "notbluetti\n1700000000\nABCD1234\ndeadbeef\n");
    assert.throws(() => readEncryptionKey(p), /Not a Bluetti encryption file/);
  });

  test("throws when the file has fewer than 4 lines", () => {
    const p = writeFile("short.csv", "bluetti\n1700000000\nABCD1234\n");
    assert.throws(() => readEncryptionKey(p), /missing key line/);
  });
});
