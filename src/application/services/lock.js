/* app.lock — optional PIN gate. Stores only a salted SHA-256 of the PIN.
   Locks on launch when a PIN exists and, optionally, after the tab has been
   hidden for prefs.lockMinutes. "Forgot PIN" is handled by the Settings feature
   (it wipes local data, since there is nothing to recover a PIN against). */
XR.define("app.lock", ["app.ports.storage", "app.ports.platform", "app.prefs", "core.events", "core.domain.events"], function (storage, platform, prefs, events, EV) {
  "use strict";
  const KEY = "xreels.lock.v1";
  let record = null;   // { salt, hash, hint }
  let locked = false;
  let hiddenAt = 0;

  async function load() {
    try { record = (await storage.get(KEY)) || null; } catch { record = null; }
    locked = !!record;
    return locked;
  }
  const isEnabled = () => !!record;
  const isLocked = () => locked;

  async function digest(pin, salt) { return platform.sha256(`${salt}:${pin}`); }

  async function enable(pin, hint = "") {
    pin = String(pin || "");
    if (pin.length < 4) throw new Error("PIN must be at least 4 digits.");
    const salt = platform.randomId(16);
    record = { salt, hash: await digest(pin, salt), hint: String(hint || "").slice(0, 60), createdAt: Date.now() };
    await storage.set(KEY, record);
    return true;
  }
  async function disable(pin) {
    if (!(await verify(pin))) return false;
    record = null; locked = false;
    await storage.remove(KEY);
    return true;
  }
  async function verify(pin) {
    if (!record) return true;
    return (await digest(String(pin || ""), record.salt)) === record.hash;
  }
  async function unlock(pin) {
    const ok = await verify(pin);
    if (ok) { locked = false; events.bus.emit(EV.UNLOCKED, {}); }
    return ok;
  }
  function lock() { if (!record || locked) return; locked = true; events.bus.emit(EV.LOCKED, {}); }
  async function forceReset() { record = null; locked = false; await storage.remove(KEY); }

  /** Hook visibility to auto-lock after N minutes away. */
  function watch(doc = document) {
    doc.addEventListener("visibilitychange", () => {
      const minutes = Number(prefs.get("lockMinutes")) || 0;
      if (!record || !minutes) return;
      if (doc.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt >= minutes * 60000) lock();
    });
  }

  return { load, isEnabled, isLocked, enable, disable, verify, unlock, lock, forceReset, watch, hint: () => record?.hint || "" };
});
