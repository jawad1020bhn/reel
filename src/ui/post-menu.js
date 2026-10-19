/* ui.postMenu — the context menu for a post (tiles, viewer, watch) and the
   collection picker dialog that answers EV.COLLECTION_PICK. */
XR.define("ui.postMenu", ["ui.menu", "ui.dialog", "ui.dom", "app.actions", "app.activity", "app.catalog", "app.importer", "core.events", "core.domain.events"],
  function (menu, dialog, dom, actions, activity, catalog, importer, events, EV) {
    "use strict";

    function items(post, opts = {}) {
      const starred = activity.isStarred(post.id), hidden = activity.isHidden(post.id), seen = activity.isSeen(post.id);
      const ids = opts.ids || [post.id], index = opts.index ?? 0;
      const colls = activity.collectionsOf(post.id);
      return [
        opts.noOpen ? null : { label: "Open", icon: "maximize", run: () => actions.view(ids, index, { label: opts.label }) },
        opts.noWatch ? null : { label: "Watch from here", icon: "play", run: () => actions.watch(ids, index, { label: opts.label }) },
        { label: starred ? "Unstar" : "Star", icon: "star", checked: starred, run: () => actions.star(post), hint: "s" },
        { label: colls.length ? `In ${colls.length} collection${colls.length > 1 ? "s" : ""}` : "Add to collection…", icon: "folder", run: () => actions.addToCollection(post.id), hint: "c" },
        { label: seen ? "Mark as unseen" : "Mark as seen", icon: seen ? "eyeOff" : "eye", run: () => activity.markSeen(post.id, !seen) },
        { sep: true },
        { label: `@${post.author.username}`, icon: "users", run: () => actions.goCreator(post.author.username) },
        ...(post.hashtags.slice(0, 3).map((t) => ({ label: "#" + t, icon: "hash", run: () => actions.goTag(t) }))),
        { sep: true },
        actions.canShare() ? { label: "Share…", icon: "share", run: () => actions.share(post) } : null,
        { label: "Open on X", icon: "external", run: () => actions.openOnX(post) },
        { label: "Copy link", icon: "link", run: () => actions.copyLink(post) },
        post.text ? { label: "Copy caption", icon: "copy", run: () => actions.copyText(post) } : null,
        post.media.length ? { label: post.media.length > 1 ? "Open media file (1st)" : "Open media file", icon: "download", run: () => actions.download(post, opts.mediaIndex || 0) } : null,
        { sep: true },
        { label: hidden ? "Unhide" : "Hide from library", icon: "eyeOff", danger: !hidden, run: () => actions.hide(post) },
        { label: "Delete from library", icon: "trash", danger: true, run: () => deletePermanently(post) },
        ...(opts.extra || []),
      ];
    }
    const open = (post, anchor, opts = {}) => menu.open(anchor, items(post, opts), { title: opts.title ?? `@${post.author.username}` });

    const pendingDeletes = new Set();
    async function deletePermanently(post) {
      if (pendingDeletes.has(post.id)) return;
      pendingDeletes.add(post.id);
      try {
        await importer.deletionReady();
        const password = await dialog.prompt(
          "Remove this post from the shared data file and every browser? This cannot be undone in the app. Enter the deletion password to confirm.",
          { title: "Delete from library?", placeholder: "Deletion password", type: "password", ok: "Delete permanently", danger: true });
        if (password === null) return;
        if (!password) { actions.toast("Deletion cancelled — no password entered."); return; }
        actions.toast("Deleting from the data file…", "info", { timeout: 2400 });
        await importer.deletePost(post.id, password);
        actions.toast("Deleted from the shared library", "success");
      } catch (err) { actions.toast(err.message || "Could not delete this post. Try again.", "error", { timeout: 8000 }); }
      finally { pendingDeletes.delete(post.id); }
    }

    /* collection picker */
    async function pick(ids) {
      const colls = activity.collections();
      const single = ids.length === 1 ? ids[0] : null;
      const newBtn = dom.h("button.btn.btn-ghost.btn-sm", { onclick: async () => { const name = await dialog.prompt("", { title: "New collection", placeholder: "Name", ok: "Create" }); if (name) { const c = activity.createCollection(name); activity.addToCollection(c.id, ids); actions.toast(`Added to “${c.name}”`, "success"); dialog.closeAll(); } } }, "+ New collection");
      const choice = await dialog.choose(ids.length > 1 ? `Add ${ids.length} posts to…` : "Add to collection", colls.map((c) => ({ id: c.id, label: c.name, hint: `${c.ids.length}`, icon: "folder", checked: single ? c.ids.includes(single) : false })), { multi: true, ok: "Apply", empty: "No collections yet — create your first one below.", extra: newBtn });
      if (!choice) return;
      const set = new Set(choice);
      for (const c of colls) {
        if (set.has(c.id)) activity.addToCollection(c.id, ids);
        else if (single && c.ids.includes(single)) activity.removeFromCollection(c.id, single);
      }
      if (choice.length) actions.toast(`Saved to ${choice.length} collection${choice.length > 1 ? "s" : ""}`, "success");
    }
    events.bus.on(EV.COLLECTION_PICK, ({ ids }) => pick(ids));

    return { items, open, pick };
  });
