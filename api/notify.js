// Vercel serverless function: notify the host / cleaner about portal events.
//
// The client only sends { kind, data } — it does NOT choose recipients.
// Recipient emails/phones are read from the Sheet's config server-side, so this
// can't be abused as an open email/SMS relay.
//
//   kind "request" -> admin (new booking request)
//   kind "message" -> admin (guest portal message)
//   kind "booking" -> cleaner + admin (a booking was confirmed)
//
// Email via Resend (RESEND_API_KEY, MAIL_FROM). SMS via Twilio
// (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM). Each channel is
// independent and simply skipped if its env vars / target are missing.

const { openSheet } = require("../lib/google");

async function sendEmail(to, subject, text, replyTo) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) return { skipped: true };
  const from = process.env.MAIL_FROM || "onboarding@resend.dev";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text, reply_to: replyTo || undefined }),
  });
  if (!r.ok) return { error: await r.text() };
  return { ok: true };
}

async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !auth || !from || !to) return { skipped: true };
  const r = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${auth}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    }
  );
  if (!r.ok) return { error: await r.text() };
  return { ok: true };
}

function build(kind, d) {
  const property = d.property || "your rental";
  const dates = `${d.checkIn || "?"} → ${d.checkOut || "?"}`;
  const guest = `${d.guestName || "Guest"}${d.guestEmail ? ` <${d.guestEmail}>` : ""}${d.guestPhone ? ` · ${d.guestPhone}` : ""}`;
  if (kind === "request") {
    return {
      subject: `New booking request — ${d.guestName || "Guest"} (${dates})`,
      text: [
        `You have a new booking request for ${property}.`, "",
        `Guest:   ${guest}`,
        `Dates:   ${dates}`,
        d.totalPrice ? `Total:   $${d.totalPrice}` : null,
        d.notes ? `Notes:   ${d.notes}` : null, "",
        `Review and accept it in the Admin dashboard.`,
      ].filter(Boolean).join("\n"),
      sms: `New booking request: ${d.guestName || "Guest"}, ${dates}, ${property}. Review in admin.`,
    };
  }
  if (kind === "message") {
    return {
      subject: `Guest message — ${d.code || "booking"} (${property})`,
      text: [
        `New message from a guest about ${property}:`, "",
        `Booking code: ${d.code || "—"}`,
        `Guest:        ${guest}`,
        `Dates:        ${dates}`, "",
        `Message:`, d.message || "",
      ].join("\n"),
      sms: `Guest message (${d.code || "booking"}): ${(d.message || "").slice(0, 100)}`,
    };
  }
  // booking
  return {
    subject: `New booking — ${d.guestName || "Guest"} (${dates})`,
    text: [
      `A booking has been confirmed for ${property}.`, "",
      `Guest:    ${guest}`,
      `Check-in: ${d.checkIn || "?"}${d.checkInTime ? ` at ${d.checkInTime}` : ""}`,
      `Check-out:${d.checkOut || "?"}${d.checkOutTime ? ` at ${d.checkOutTime}` : ""}`,
      d.code ? `Code:     ${d.code}` : null, "",
      `Please add the turnover to your calendar.`,
    ].filter(Boolean).join("\n"),
    sms: `New booking: ${d.guestName || "Guest"}, ${dates} at ${property}. Add the turnover to your calendar.`,
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const kind = body.kind;
    const data = body.data || {};
    if (!["request", "message", "booking"].includes(kind)) {
      return res.status(400).json({ error: "unknown kind" });
    }

    // Pull recipients from the Sheet config (server-side, not client-supplied).
    const { data: store } = await openSheet();
    const cfg = store.config || {};
    data.property = data.property || cfg.propertyName;
    data.checkInTime = data.checkInTime || cfg.checkInTime;
    data.checkOutTime = data.checkOutTime || cfg.checkOutTime;

    const admin = { email: cfg.adminEmail, phone: cfg.adminPhone };
    const cleaner = { email: cfg.cleanerEmail, phone: cfg.cleanerPhone };
    const targets = kind === "booking" ? [cleaner, admin] : [admin];

    const msg = build(kind, data);
    const results = [];
    for (const t of targets) {
      if (t.email) results.push(await sendEmail(t.email, msg.subject, msg.text, data.guestEmail));
      if (t.phone) results.push(await sendSms(t.phone, msg.sms));
    }
    const sent = results.filter((r) => r && r.ok).length;
    res.status(200).json({ ok: true, sent, results });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
