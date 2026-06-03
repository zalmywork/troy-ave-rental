// Vercel serverless function: read/write all site data to a Google Sheet.
// Uses a service account (GOOGLE_SERVICE_ACCOUNT_JSON) — credentials stay
// server-side and are never exposed to the browser.
//
// Storage model: the first tab holds two columns [key, value]. Each row is one
// site key (config | bookings | pricing | requests) whose value is a JSON string.

const { openSheet, writeAll } = require("../lib/google");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { token, sheetId, tab, data: map } = await openSheet();

    // GET → return the whole state { config, bookings, pricing, requests }
    if (req.method === "GET") return res.status(200).json(map);

    // POST → mutate one key, then persist the whole map back
    if (req.method === "POST") {
      const body =
        typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const action = body.action || "set";

      if (action === "addRequest") {
        const reqs = Array.isArray(map.requests) ? map.requests : [];
        reqs.push(body.request);
        map.requests = reqs;
      } else if (action === "set") {
        if (!body.key) return res.status(400).json({ error: "missing key" });
        map[body.key] = body.value;
      } else {
        return res.status(400).json({ error: "unknown action" });
      }

      await writeAll(token, sheetId, tab, map);
      return res.status(200).json({ ok: true });
    }

    res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
