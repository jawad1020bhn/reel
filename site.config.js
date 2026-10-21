/* saves — this deployment is CLOSED.

   `closed: true` closes the library everywhere, including a local file://
   copy: nothing boots, no passcode is asked, no data is fetched. There is no
   passcode that reopens it. Reopening would mean editing this file, setting
   a password again (npm run site:password -- "…" --reopen) and adding a
   dataset again — all of which were removed on purpose.

   The fields below are kept so the file stays a valid config; see DEPLOY.md
   for what each one meant when the library was open. */
window.XREELS_SITE = {
  closed: true,
  closedNotice: "This library has been closed by its owner.",
  salt: "",
  hash: "",
  hint: "",
  title: "saves",
  availability: { enabled: false, seed: "", graceMinutes: 5 },
};
