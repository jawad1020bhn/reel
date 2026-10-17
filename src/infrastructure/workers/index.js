/* infra.workers — runs the pure core (adapters + model) inside a Web Worker when the app is
   served over http(s). On file:// workers cannot be created from local files, so this module
   reports available() = false and the importer indexes in chunks on the main thread instead.
   The worker is assembled from the manifest's core scripts + the kernel (fetched once). */
XR.define("infra.workers", ["app.ports.platform"], function (platform) {
  "use strict";
  let blobUrl = null;
  const available = () => !platform.isFile() && typeof Worker === "function" && typeof fetch === "function" && !!(typeof window !== "undefined" && window.XREELS_MANIFEST);

  async function build() {
    if (blobUrl) return blobUrl;
    const files = window.XREELS_MANIFEST.scripts.filter((f) => f === "src/kernel/kernel.js" || f.startsWith("src/core/"));
    const parts = await Promise.all(files.map((f) => fetch(f).then((r) => { if (!r.ok) throw new Error("fetch " + f); return r.text(); })));
    const tail = `
      self.onmessage = async (e) => {
        try {
          XR.resolveAll("core.adapters.");
          const registry = XR.resolve("core.adapters.registry");
          const out = await registry.normalizeAsync(e.data.json, e.data.options || {}, (done, total) => self.postMessage({ progress: [done, total] }));
          self.postMessage({ result: out });
        } catch (err) { self.postMessage({ error: String(err && err.message || err) }); }
      };`;
    blobUrl = URL.createObjectURL(new Blob([parts.join("\n;\n"), tail], { type: "text/javascript" }));
    return blobUrl;
  }

  /** Same contract as registry.normalizeAsync, executed off the main thread. */
  async function normalize(json, options, onProgress) {
    if (!available()) throw new Error("workers unavailable");
    const url = await build();
    return new Promise((resolve, reject) => {
      const w = new Worker(url);
      const done = (fn) => (v) => { w.terminate(); fn(v); };
      w.onmessage = (e) => {
        if (e.data.progress && onProgress) onProgress(...e.data.progress);
        else if (e.data.result) done(resolve)(e.data.result);
        else if (e.data.error) done(reject)(new Error(e.data.error));
      };
      w.onerror = (err) => done(reject)(new Error(err.message || "worker error"));
      w.postMessage({ json, options });
    });
  }
  return { available, normalize };
});
