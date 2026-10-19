/* ui.pullToShuffle — shared touch gesture for Discover and Library.
   Pull down from the top, then release past 72px to shuffle. Returns cleanup. */
XR.define("ui.pullToShuffle", ["ui.dom", "ui.icons", "app.ports.platform", "core.i18n"],
  function (dom, icons, platform, i18n) {
    "use strict";
    const h = dom.h, t = i18n.t;
    function attach(scroller, shuffle) {
      const THRESHOLD = 72, MAX = 110;
      let startY = 0, pulling = false, armed = false, dy = 0;
      const pill = h("div.pull-to-shuffle", { "aria-hidden": "true" }, icons.icon("shuffle", 18), h("span", t("Release to shuffle")));
      const reset = () => { pulling = false; armed = false; dy = 0; pill.classList.remove("is-armed", "is-pulling"); pill.style.removeProperty("--pull"); };
      const onStart = (e) => { reset(); if (scroller.scrollTop > 0 || e.touches.length !== 1) return; startY = e.touches[0].clientY; pulling = true; dy = 0; };
      const onMove = (e) => {
        if (!pulling) return;
        if (e.touches.length !== 1) { reset(); return; }
        dy = e.touches[0].clientY - startY;
        if (dy <= 0 || scroller.scrollTop > 0) { reset(); return; }
        if (!pill.isConnected) document.body.appendChild(pill);
        const eased = Math.min(MAX, dy * 0.55);
        pill.style.setProperty("--pull", eased + "px");
        pill.classList.add("is-pulling");
        const nowArmed = eased >= THRESHOLD * 0.55;
        if (nowArmed !== armed) { armed = nowArmed; pill.classList.toggle("is-armed", armed); if (armed) platform.vibrate?.(8); }
      };
      const onEnd = () => { const fire = armed; reset(); if (fire) shuffle(); };
      scroller.addEventListener("touchstart", onStart, { passive: true });
      scroller.addEventListener("touchmove", onMove, { passive: true });
      scroller.addEventListener("touchend", onEnd, { passive: true });
      scroller.addEventListener("touchcancel", reset, { passive: true });
      return () => { scroller.removeEventListener("touchstart", onStart); scroller.removeEventListener("touchmove", onMove); scroller.removeEventListener("touchend", onEnd); scroller.removeEventListener("touchcancel", reset); pill.remove(); };
    }

    return { attach };
  });
