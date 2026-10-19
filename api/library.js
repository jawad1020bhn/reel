// Vercel Node function; plain static/file:// use remains supported without it.
module.exports = require("../server/library-store.cjs").createHandler();
