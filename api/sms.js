// Vercel serverless function: inbound SMS webhook (Twilio "A MESSAGE COMES IN").
//
// Point your Twilio number's Messaging configuration here:
//   https://troy-ave-rental.vercel.app/api/sms   (HTTP POST)
//
// When a guest texts the number, we log it into the same `messages` store the
// admin Messages tab reads — matched to their booking by phone when possible so
// it threads with their existing conversation — and alert the host. The host can
// then reply from the dashboard (which texts/emails the guest back).
//
// Replies with empty TwiML so Twilio doesn't auto-send anything to the guest.

const { openSheet, writeAll } = require("../lib/google");
const notify = require("./notify");

const TWIML_OK = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const last10 = (s) => String(s || "").replace(/\D/g, "").slice(-10);

function parseForm(req) {
  if (req.body && typeof req.body === "object") return req.body; // Vercel pre-parsed
  const out = {};
  new URLSearchParams(typeof req.body === "string" ? req.body : "").forEach((v, k) => (out[k] = v));
  return out;
}

module.exports = async (req, res) => {
  // Always answer Twilio with valid TwiML, even on error, so it doesn't retry-storm.
  const done = () => { res.setHeader("Content-Type", "text/xml"); res.status(200).send(TWIML_OK); };
  try {
    if (req.method !== "POST") return done();
    const form = parseForm(req);
    const from = form.From || "";
    const text = (form.Body || "").trim();
    if (!from || !text) return done();

    const { token, sheetId, tab, data: store } = await openSheet();
    const cfg = store.config || {};
    const bookings = Array.isArray(store.bookings) ? store.bookings : [];
    const messages = Array.isArray(store.messages) ? store.messages : [];
    const now = new Date().toISOString();
    const fromKey = last10(from);

    // Identify the guest via a booking with a matching phone (most recent wins).
    const match = [...bookings].reverse().find((b) => b.guestPhone && last10(b.guestPhone) === fromKey);

    // Append to this guest's existing thread if there is one; else start a new one.
    const existing = [...messages].reverse().find((m) => m.guestPhone && last10(m.guestPhone) === fromKey);
    if (existing) {
      existing.thread = [...(existing.thread || [{ role: "guest", text: existing.message, at: existing.createdAt }]), { role: "guest", text, at: now }];
      existing.answered = false;
      existing.createdAt = now; // bump to the top of the Messages list
    } else {
      messages.push({
        id: Date.now().toString(),
        code: match ? match.code || "" : "",
        guestName: match ? match.guestName || "" : "",
        guestEmail: match ? match.guestEmail || "" : "",
        guestPhone: from,
        checkIn: match ? match.checkIn || "" : "",
        checkOut: match ? match.checkOut || "" : "",
        message: text,
        createdAt: now,
        answered: false,
        thread: [{ role: "guest", text, at: now }],
      });
    }
    store.messages = messages;
    await writeAll(token, sheetId, tab, store);

    // Alert the host (email + SMS) that a guest texted in.
    try {
      await notify.send("message", {
        code: match ? match.code || "" : "",
        guestName: (match && match.guestName) || "Guest (text)",
        guestEmail: match ? match.guestEmail || "" : "",
        guestPhone: from,
        checkIn: match ? match.checkIn || "" : "",
        checkOut: match ? match.checkOut || "" : "",
        message: text,
      }, cfg);
    } catch (e) { /* logging the message already succeeded; alert is best-effort */ }

    return done();
  } catch (e) {
    return done();
  }
};
