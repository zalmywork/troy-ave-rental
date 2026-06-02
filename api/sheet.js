// Vercel serverless function: read/write all site data to a Google Sheet.
// Uses a service account (GOOGLE_SERVICE_ACCOUNT_JSON) — credentials stay
// server-side and are never exposed to the browser. Zero npm dependencies:
// we sign the JWT ourselves with Node's built-in crypto.
//
// Storage model: one tab named "Store" with two columns [key, value].
// Each row holds one site key (config | bookings | pricing | requests) whose
// value is a JSON string. The whole app state round-trips through here.

const crypto = require("crypto");

// Resolve the first tab's title so the site works on a brand-new sheet
// (default tab "Sheet1") without the owner renaming anything.
async function firstSheetTitle(token, sheetId) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  const title = data.sheets && data.sheets[0] && data.sheets[0].properties.title;
  if (!title) throw new Error("Could not read sheet tabs: " + JSON.stringify(data));
  return title;
}
const rangeOf = (tab) => `${tab}!A:B`;

function getCreds() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON env var");
  return JSON.parse(raw);
}

async function getAccessToken(creds) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${b64(header)}.${b64(claim)}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .sign(creds.private_key, "base64url");
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Auth failed: " + JSON.stringify(data));
  return data.access_token;
}

async function readAll(token, sheetId, tab) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(rangeOf(tab))}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  const rows = data.values || [];
  const out = {};
  for (const [k, v] of rows) {
    if (!k || k === "key") continue;
    try { out[k] = JSON.parse(v); } catch { out[k] = v; }
  }
  return out;
}

async function writeAll(token, sheetId, tab, map) {
  const rows = [["key", "value"]];
  for (const k of Object.keys(map)) rows.push([k, JSON.stringify(map[k])]);
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(rangeOf(tab))}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: rows }),
    }
  );
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const creds = getCreds();
    const sheetId = process.env.SHEET_ID;
    if (!sheetId) throw new Error("Missing SHEET_ID env var");
    const token = await getAccessToken(creds);
    const tab = await firstSheetTitle(token, sheetId);

    // GET → return the whole state { config, bookings, pricing, requests }
    if (req.method === "GET") {
      return res.status(200).json(await readAll(token, sheetId, tab));
    }

    // POST → mutate one key, then persist the whole map back
    if (req.method === "POST") {
      const body =
        typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const action = body.action || "set";
      const map = await readAll(token, sheetId, tab);

      if (action === "addRequest") {
        // public path: a guest submitting a booking request
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
