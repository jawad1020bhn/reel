import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import store from "../server/library-store.cjs";
const { createHandler, removePost, parseData, ledgerIds } = store;
const PASSWORD = "test-only-delete-password";
const env = { LIBRARY_GITHUB_TOKEN: "test-only-token", LIBRARY_GITHUB_REPOSITORY: "test/library", LIBRARY_GITHUB_BRANCH: "test-branch", LIBRARY_DELETE_PASSWORD: PASSWORD };
const ledgerPath = "data/deleted-posts.js";
const datasetPath = "data/posts.json";

// Immutable Git snapshots and compare-and-swap ref updates; never contacts GitHub.
function fakeGit() {
  const hash = (s) => createHash("sha1").update(s).digest("hex");
  const blobs = new Map(), commits = new Map(), trees = new Map();
  const blob = (text) => { const sha = hash(text); blobs.set(sha, text); return sha; };
  const initial = { [datasetPath]: blob(JSON.stringify({ count: 3, bookmarks: [{ tweet_id: "1", text: "one" }, { tweet_id: "2", text: "two" }, { tweet_id: "3", text: "three" }] })), [ledgerPath]: blob("window.XREELS_DELETED_IDS = [];\n") };
  trees.set("tree0", initial); commits.set("head0", { tree: { sha: "tree0" }, parents: [] });
  let head = "head0", counter = 0, conflict = false, failWrites = false;
  const calls = [];
  const snapshot = () => Object.fromEntries(Object.entries(trees.get(commits.get(head).tree.sha)).map(([path, sha]) => [path, blobs.get(sha)]));
  const fetch = async (url, options) => {
    assert.ok(url.startsWith("https://api.github.com/repos/test/library/"));
    assert.equal(options.headers.Authorization, "Bearer test-only-token");
    const u = new URL(url), path = u.pathname.replace("/repos/test/library", ""), method = options.method;
    const body = options.body && JSON.parse(options.body);
    calls.push({ path, method, body });
    const response = (status, data, raw = false) => new Response(raw ? data : JSON.stringify(data), { status });
    if (path === "/git/ref/heads/test-branch") return response(200, { object: { sha: head } });
    if (path.startsWith("/contents/")) {
      assert.equal(options.headers.Accept, "application/vnd.github.raw+json", "large files use the raw Contents API");
      const sha = trees.get(commits.get(u.searchParams.get("ref")).tree.sha)[path.slice("/contents/".length)];
      return sha ? response(200, blobs.get(sha), true) : response(404, {});
    }
    if (failWrites && method !== "GET") return response(403, { message: "private details must not reach client" });
    if (path.startsWith("/git/commits/") && method === "GET") return response(200, commits.get(path.split("/").at(-1)));
    if (path === "/git/blobs") return response(201, { sha: blob(body.content) });
    if (path === "/git/trees") {
      const sha = `tree${++counter}`, tree = { ...trees.get(body.base_tree) };
      for (const entry of body.tree) tree[entry.path] = entry.sha;
      trees.set(sha, tree); return response(201, { sha });
    }
    if (path === "/git/commits") {
      const sha = `head${++counter}`; commits.set(sha, { tree: { sha: body.tree }, parents: body.parents });
      return response(201, { sha });
    }
    if (path === "/git/refs/heads/test-branch" && method === "PATCH") {
      assert.equal(body.force, false);
      if (conflict) {
        conflict = false;
        // Another client deleted post 2 after we read the head.
        const current = snapshot();
        const tree = { [datasetPath]: blob(removePost(current[datasetPath], "2", datasetPath)), [ledgerPath]: blob('window.XREELS_DELETED_IDS = ["2"];\n') };
        trees.set("racing-tree", tree); commits.set("racing-head", { tree: { sha: "racing-tree" }, parents: [head] }); head = "racing-head";
        return response(422, {});
      }
      if (!commits.get(body.sha).parents.includes(head)) return response(422, {});
      head = body.sha; return response(200, { object: { sha: head } });
    }
    throw new Error(`Unexpected Git operation: ${method} ${path}`);
  };
  return { fetch, calls, snapshot, get head() { return head; }, set conflict(v) { conflict = v; }, set failWrites(v) { failWrites = v; } };
}
async function invoke(handler, method = "GET", body, headers = {}) {
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(text) { this.body = JSON.parse(text); } };
  await handler({ method, body, headers: { host: "library.test", origin: "https://library.test", "content-type": "application/json", ...headers } }, res);
  assert.equal(res.headers["Cache-Control"], "no-store, max-age=0");
  return res;
}

test("permanent deletion removes all matching rows and preserves unrelated data", () => {
  const original = { count: 3, source: "exporter", verification: { rows: 3 }, bookmarks: [{ tweet_id: "1" }, { tweet_id: "2", text: "keep me" }, { tweet_id: "1" }] };
  const result = parseData(removePost(JSON.stringify(original), "1", datasetPath));
  assert.deepEqual(result, { count: 1, source: "exporter", bookmarks: [{ tweet_id: "2", text: "keep me" }] });
  assert.equal(removePost(JSON.stringify(original), "missing", datasetPath), null);
  assert.equal(original.bookmarks.length, 3);
});

test("supported export shapes and JavaScript wrappers remain valid after the final deletion", () => {
  for (const key of [null, "posts", "tweets", "data", "items", "results", "list", "bookmarks"]) {
    const data = key ? { [key]: [{ id: "1" }] } : [{ id: "1" }];
    const text = `/* export */\nwindow.XREELS_DATA = ${JSON.stringify(data)};`;
    const result = parseData(removePost(text, "1", "data/posts.js"));
    assert.deepEqual(key ? result[key] : result, []);
  }
  assert.deepEqual(ledgerIds('// ledger\nwindow.XREELS_DELETED_IDS = ["1", "1"];'), ["1"]);
  assert.throws(() => removePost('window.X = alert("no");', "1", "data/posts.js"), /not valid JSON/);
  assert.throws(() => ledgerIds('window.X = [1];'), /invalid/);
});

test("one atomic commit updates the data file and shared ledger; fresh clients see it immediately", async () => {
  const git = fakeGit(), handler = createHandler({ env, fetch: git.fetch });
  const result = await invoke(handler, "DELETE", { id: "1", password: PASSWORD });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.deleted, true);
  const files = git.snapshot();
  assert.deepEqual(parseData(files[datasetPath]).bookmarks.map((p) => p.tweet_id), ["2", "3"]);
  assert.deepEqual(ledgerIds(files[ledgerPath]), ["1"]);
  assert.equal(git.calls.filter((c) => c.path === "/git/trees" && c.method === "POST")[0].body.tree.length, 2);
  const freshBrowser = await invoke(createHandler({ env, fetch: git.fetch }));
  assert.deepEqual(freshBrowser.body, { enabled: true, deletedIds: ["1"] });
  const repeat = await invoke(handler, "DELETE", { id: "1", password: PASSWORD });
  assert.equal(repeat.statusCode, 200, "safe retry after a lost response");
  assert.equal(git.calls.filter((c) => c.method === "PATCH").length, 1);
});

test("concurrent deletion retries against the latest commit without resurrecting another post", async () => {
  const git = fakeGit(); git.conflict = true;
  const result = await invoke(createHandler({ env, fetch: git.fetch }), "DELETE", { id: "1", password: PASSWORD });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(parseData(git.snapshot()[datasetPath]).bookmarks.map((p) => p.tweet_id), ["3"]);
  assert.deepEqual(new Set(ledgerIds(git.snapshot()[ledgerPath])), new Set(["1", "2"]));
});

test("wrong credentials, cross-origin requests, malformed IDs and absent posts never write data", async () => {
  const git = fakeGit(), handler = createHandler({ env, fetch: git.fetch });
  for (const [body, headers, expected] of [
    [{ id: "1", password: "wrong" }, {}, 401],
    [{ id: "1", password: PASSWORD }, { origin: "https://other.test" }, 403],
    [{ id: "../data", password: PASSWORD }, {}, 400],
    [{ id: "1", password: PASSWORD }, { "content-type": "text/plain" }, 415],
    [{ id: "absent", password: PASSWORD }, {}, 404],
  ]) assert.equal((await invoke(handler, "DELETE", body, headers)).statusCode, expected);
  assert.equal(git.head, "head0");
  assert.equal(git.calls.filter((c) => c.method !== "GET").length, 0);
  assert.equal((await invoke(handler, "POST")).statusCode, 405);
});

test("missing configuration is explicit; unsafe preview config and write failures fail closed", async () => {
  const git = fakeGit();
  assert.equal((await invoke(createHandler({ env: {}, fetch: git.fetch }))).body.enabled, false);
  assert.equal((await invoke(createHandler({ env: {}, fetch: git.fetch }), "DELETE", { id: "1", password: PASSWORD })).statusCode, 503);
  for (const extra of [{ LIBRARY_DELETE_PASSWORD: "short" }, { LIBRARY_GITHUB_TOKEN: "" }, { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "other-branch" }]) {
    assert.equal((await invoke(createHandler({ env: { ...env, ...extra }, fetch: git.fetch }))).statusCode, 503);
  }
  git.failWrites = true;
  const result = await invoke(createHandler({ env, fetch: git.fetch }), "DELETE", { id: "1", password: PASSWORD });
  assert.equal(result.statusCode, 502);
  assert.ok(!JSON.stringify(result.body).includes("private details"));
  assert.equal(git.head, "head0");
  assert.deepEqual(ledgerIds(git.snapshot()[ledgerPath]), []);
});
