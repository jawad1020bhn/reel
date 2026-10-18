/* The deployment gate must never persist a successful passcode. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("site passcode verification is memory-only and clears the old unlock digest", async () => {
  const oldWindow = globalThis.window;
  const oldXR = globalThis.XR;
  const salt = "test-salt";
  const passcode = "001234";
  globalThis.window = { XREELS_SITE: { salt, hash: sha256(`${salt}:${passcode}`) } };
  let definition;
  globalThis.XR = { define: (_name, _deps, factory) => { definition = factory; } };
  vm.runInThisContext(readFileSync(new URL("../src/application/services/site.js", import.meta.url), "utf8"));

  const storageCalls = [];
  const storage = {
    async get(key) { storageCalls.push(["get", key]); return null; },
    async set(key) { storageCalls.push(["set", key]); },
    async remove(key) { storageCalls.push(["remove", key]); },
  };
  const platform = { isFile: () => false, sha256: async (value) => sha256(value) };
  const site = definition(platform, storage);

  try {
    assert.equal(await site.verify(passcode), true);
    assert.equal(await site.verify("wrong"), false);
    assert.deepEqual(storageCalls, [], "verification doesn't read or write browser storage");
    assert.equal(typeof site.remember, "undefined");
    assert.equal(typeof site.isUnlocked, "undefined");
    assert.equal(await site.forget(), true);
    assert.deepEqual(storageCalls, [["remove", site.LEGACY_KEY]], "only the old persistent unlock is removed");
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
    if (oldXR === undefined) delete globalThis.XR;
    else globalThis.XR = oldXR;
  }
});
