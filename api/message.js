// Vercel serverless function: deliver a guest's booking-portal message to the
// host by email. Email-only (nothing is stored). Uses Resend's REST API — no
// npm dependency, just a fetch. Stays dormant (returns 503) until configured.
//
// Required env vars to enable delivery:
//   RESEND_API_KEY  – your Resend API key
//   OWNER_EMAIL     – where host notifications are sent
// Optional:
//   MAIL_FROM       – verified sender (default: onboarding@resend.dev for testing)

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const message = (body.message || "").trim();
    if (!message) return res.status(400).json({ error: "empty message" });

    const apiKey = process.env.RESEND_API_KEY;
    const to = process.env.OWNER_EMAIL;
    if (!apiKey || !to) {
      // Not configured yet — tell the client so it can show a graceful message.
      return res.status(503).json({ error: "messaging not configured" });
    }
    const from = process.env.MAIL_FROM || "onboarding@resend.dev";

    const lines = [
      `New message from a guest about ${body.property || "your rental"}:`,
      "",
      `Booking code: ${body.code || "—"}`,
      `Guest: ${body.guestName || "—"}${body.guestEmail ? ` <${body.guestEmail}>` : ""}`,
      `Dates: ${body.checkIn || "?"} → ${body.checkOut || "?"}`,
      "",
      "Message:",
      message,
    ];

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to,
        reply_to: body.guestEmail || undefined,
        subject: `Guest message — ${body.code || "booking"} (${body.property || "rental"})`,
        text: lines.join("\n"),
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: "email send failed", detail });
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
