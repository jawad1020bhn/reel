/* app.ports — the contracts the application layer needs from the outside world.

   Nothing here is implemented. Infrastructure modules implement these shapes
   and boot.js binds the abstract names to concrete modules:

     XR.bind("app.ports.storage",       "infra.storage.auto");
     XR.bind("app.ports.router",        "infra.router.hash");
     XR.bind("app.ports.mediaResolver", "infra.media.twimg");
     XR.bind("app.ports.playerEngine",  "infra.media.player");
     XR.bind("app.ports.platform",      "infra.platform");
     XR.bind("app.ports.dataSources",   "infra.datasources");

   Swap a binding (e.g. a server-backed storage) without touching app/* code.

   StoragePort       { kind, get(key)→Promise<any>, set(key,val)→Promise, remove(key)→Promise,
                       keys()→Promise<string[]>, clear()→Promise, estimate()→Promise<{used,quota}|null> }
   RouterPort        { current()→string ("/path?query"), navigate(path,{replace?}), back(), onChange(fn)→unsubscribe, href(path)→string }
   MediaResolverPort { thumb(media,size,opts)→url, poster(media,size,opts)→url, full(media,opts)→url,
                       avatar(url,px)→url, sources(media,opts)→[{url,type,bitrate}], download(media)→url, canHls()→bool }
   PlayerEnginePort  { attach(videoEl, media, opts)→optional {ready?:Promise<boolean>}, detach(videoEl), canHls()→bool }
   PlatformPort      { copy(text)→Promise<bool>, share(data)→Promise<bool>, download(url,name)→Promise<bool>,
                       isTouch()→bool, isMobileView()→bool, landscapeFullscreen(el,video)→Promise<bool>,
                       reducedMotion()→bool, openExternal(url), sha256(text)→Promise<hex>,
                       randomId(bytes)→hex, dpr()→number, isFile()→bool, vibrate(ms) }
   DataSourcesPort   { get(kind)→DataSource|null, all()→DataSource[],
                       deletionState()→Promise<{enabled, deletedIds}>, deletePost(id,password)→Promise<{deleted,id,deletedIds}> }
   DataSource        { id, label, kind:'auto'|'file'|'text'|'url', available()→bool, load(arg?)→Promise<{json?, text?, label}|null> }
*/
XR.define("app.ports", [], function () {
  "use strict";
  const SHAPES = {
    storage: ["get", "set", "remove", "keys", "clear"],
    router: ["current", "navigate", "back", "onChange", "href"],
    mediaResolver: ["thumb", "poster", "full", "avatar", "sources", "download"],
    playerEngine: ["attach", "detach"],
    platform: ["copy", "download", "isTouch", "isMobileView", "landscapeFullscreen", "sha256", "randomId", "dpr", "openExternal"],
    dataSources: ["get", "all"],
  };
  /** Fail fast at boot when a bound implementation misses a method. */
  function assertPort(name, impl) {
    const required = SHAPES[name] || [];
    const missing = required.filter((m) => typeof impl?.[m] !== "function");
    if (missing.length) throw new Error(`port "${name}" is missing: ${missing.join(", ")}`);
    return impl;
  }
  return { SHAPES, assertPort };
});
