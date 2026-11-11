// Vercel serverless function: read/write all site data to a Google Sheet.
// Uses a service account (GOOGLE_SERVICE_ACCOUNT_JSON) — credentials stay
// server-side and are never exposed to the browser.
//
// Storage model: the first tab holds two columns [key, value]. Each row is one
// site key (config | bookings | pricing | requests | …) whose value is a JSON string.
//
// Access (see lib/access.js):
//   GET                      → what the caller's role may see. No session = the
//                              public view (no guide, PINs or guest details).
//   POST login {role, pin}   → checks the PIN here, returns a session token.
//   POST addRequest / addMessage → open to guests (append-only).
//   POST set {key, value}    → admin session only.

const { openSheet, writeAll } = require("../lib/google");
const { issueSession, roleOf, checkPin, viewFor } = require("../lib/access");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Session");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { token, sheetId, tab, data: map } = await openSheet();
    const cfg = map.config || {};

    if (req.method === "GET") return res.status(200).json(viewFor(roleOf(req, cfg), map));

    if (req.method === "POST") {
      const body =
        typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const action = body.action || "set";

      if (action === "login") {
        if (!checkPin(body.role, body.pin, cfg)) return res.status(401).json({ error: "wrong pin" });
        return res.status(200).json({ ok: true, role: body.role, session: issueSession(body.role, cfg) });
      }

      let session; // a fresh token, when an admin's own PIN change would end theirs
      if (action === "addRequest") {
        if (!body.request || typeof body.request !== "object") return res.status(400).json({ error: "missing request" });
        const reqs = Array.isArray(map.requests) ? map.requests : [];
        reqs.push(body.request);
        map.requests = reqs;
      } else if (action === "addMessage") {
        if (!body.message || typeof body.message !== "object") return res.status(400).json({ error: "missing message" });
        const msgs = Array.isArray(map.messages) ? map.messages : [];
        msgs.push(body.message);
        map.messages = msgs;
      } else if (action === "set") {
        if (roleOf(req, cfg) !== "admin") return res.status(401).json({ error: "admin session required" });
        if (!body.key) return res.status(400).json({ error: "missing key" });
        const v = body.value;
        // A browser holding the public view must never write it back over the
        // real data (it has no guide, PINs or guest details to send).
        const isPublicCopy =
          (body.key === "config" && v && v._public) ||
          (body.key === "bookings" && Array.isArray(v) && v.some((b) => b && b._public));
        if (isPublicCopy) return res.status(409).json({ error: "stale public data; reload the dashboard" });
        if (body.key === "config") {
          const before = { ...cfg };
          map.config = { ...cfg, ...(v || {}) };
          if ((map.config.adminPin || "1234") !== (before.adminPin || "1234")) session = issueSession("admin", map.config);
        } else {
          map[body.key] = v;
        }
      } else {
        return res.status(400).json({ error: "unknown action" });
      }

      await writeAll(token, sheetId, tab, map);
      return res.status(200).json({ ok: true, ...(session ? { session } : {}) });
    }

    res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
