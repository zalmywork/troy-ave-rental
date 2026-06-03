// Vercel serverless function: all guest/host/cleaner notifications.
//
// The client sends only { kind, data } — recipients (admin/cleaner email+phone,
// host name, property, times) are read from the Sheet config server-side, so
// this can't be abused as an open relay.
//
//   kind "request"   -> customer "reservation requested" email + SMS,
//                       admin alert email + SMS
//   kind "confirmed" -> customer confirmation email + SMS,
//                       cleaner email + SMS (with check-in/out date & time),
//                       admin email notice
//   kind "message"   -> admin alert email + SMS
//
// Email via Resend (RESEND_API_KEY, MAIL_FROM). SMS via Twilio
// (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM). Each channel is skipped
// when its env vars / the target address are missing. NOTE: emailing customers
// (any address other than your own) requires a verified domain in Resend.

const { openSheet } = require("../lib/google");

const BRAND = { bg: "#FBF8F4", card: "#FFFFFF", ink: "#2C2622", muted: "#7A7167", accent: "#B0744A", line: "#ECE5DC" };

/* ---------- senders ---------- */
async function sendEmail(to, subject, html, text, replyTo) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) return { skipped: "email" };
  const from = process.env.MAIL_FROM || "onboarding@resend.dev";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html, text, reply_to: replyTo || undefined }),
  });
  if (!r.ok) return { error: await r.text() };
  return { ok: true, channel: "email", to };
}
async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !auth || !from || !to) return { skipped: "sms" };
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${auth}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!r.ok) return { error: await r.text() };
  return { ok: true, channel: "sms", to };
}

/* ---------- formatting ---------- */
const money = (n) => (n != null && n !== "" ? "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "");
function niceDate(s) {
  if (!s) return "?";
  const [y, m, d] = String(s).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
function nightsBetween(a, b) {
  if (!a || !b) return 0;
  return Math.round((new Date(a) - new Date(b)) / 86400000) * -1;
}

function emailShell(heading, bodyHtml, cfg) {
  return `<!doctype html><html><body style="margin:0;background:${BRAND.bg};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${BRAND.ink}">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <div style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:${BRAND.accent};font-weight:700;margin-bottom:6px">${cfg.propertyName || "Your Stay"}</div>
    <h1 style="font-size:26px;margin:0 0 18px;font-weight:700">${heading}</h1>
    <div style="background:${BRAND.card};border:1px solid ${BRAND.line};border-radius:16px;padding:24px">${bodyHtml}</div>
    <p style="font-size:13px;color:${BRAND.muted};margin:22px 0 0;line-height:1.6">
      Questions? Reach out to ${cfg.hostName || "your host"}${cfg.adminEmail ? ` at <a href="mailto:${cfg.adminEmail}" style="color:${BRAND.accent}">${cfg.adminEmail}</a>` : ""}${cfg.adminPhone ? ` or ${cfg.adminPhone}` : ""}.<br/>
      ${cfg.address ? cfg.address + "<br/>" : ""}
    </p>
  </div></body></html>`;
}
function summaryTable(d, cfg) {
  const nights = d.nights || nightsBetween(d.checkIn, d.checkOut);
  const row = (k, v) => `<tr><td style="padding:7px 0;color:${BRAND.muted};font-size:14px">${k}</td><td style="padding:7px 0;text-align:right;font-weight:600;font-size:14px">${v}</td></tr>`;
  return `<table style="width:100%;border-collapse:collapse">
    ${row("Guest", d.guestName || "Guest")}
    ${row("Check-in", `${niceDate(d.checkIn)}${cfg.checkInTime ? ` · ${cfg.checkInTime}` : ""}`)}
    ${row("Check-out", `${niceDate(d.checkOut)}${cfg.checkOutTime ? ` · ${cfg.checkOutTime}` : ""}`)}
    ${row("Nights", nights || "—")}
    ${d.totalPrice ? row("Total", money(d.totalPrice)) : ""}
    ${d.code ? row("Booking code", d.code) : ""}
  </table>`;
}

/* ---------- per-kind builders ---------- */
function buildCustomer(kind, d, cfg) {
  const sign = `Questions? Reach out to ${cfg.hostName || "your host"}${cfg.adminPhone ? ` at ${cfg.adminPhone}` : ""}.`;
  if (kind === "request") {
    return {
      email: {
        subject: `Reservation requested — ${cfg.propertyName || "your stay"}`,
        html: emailShell(
          "Reservation requested",
          `<p style="margin:0 0 16px;line-height:1.6">Hi ${d.guestName || "there"}, thanks for your request! We've received it and ${cfg.hostName || "your host"} will review and confirm shortly. Here are the details:</p>${summaryTable(d, cfg)}<p style="margin:16px 0 0;font-size:13px;color:${BRAND.muted}">This is a request, not yet a confirmed booking. You'll get a confirmation email once it's approved. You can reply to this email to reach ${cfg.hostName || "your host"}.</p>`,
          cfg
        ),
        text: `Hi ${d.guestName || "there"}, we received your reservation request for ${cfg.propertyName} (${niceDate(d.checkIn)} to ${niceDate(d.checkOut)}). ${cfg.hostName || "Your host"} will confirm shortly. ${sign}`,
      },
      sms: `Hi ${d.guestName || "there"}, we received your booking request for ${cfg.propertyName || "your stay"} (${niceDate(d.checkIn)}–${niceDate(d.checkOut)}). We'll confirm shortly. ${sign}`,
    };
  }
  if (kind === "cancelled") {
    const sign = `Questions? Reach out to ${cfg.hostName || "your host"}${cfg.adminPhone ? ` at ${cfg.adminPhone}` : ""}.`;
    return {
      email: {
        subject: `Reservation cancelled — ${cfg.propertyName || "your stay"}`,
        html: emailShell(
          "Reservation cancelled",
          `<p style="margin:0 0 16px;line-height:1.6">Hi ${d.guestName || "there"}, your reservation for the dates below has been cancelled.</p>${summaryTable(d, cfg)}<p style="margin:16px 0 0;font-size:13px;color:${BRAND.muted}">If this is unexpected or you have questions, just reply to this email.</p>`,
          cfg
        ),
        text: `Hi ${d.guestName || "there"}, your reservation at ${cfg.propertyName} for ${niceDate(d.checkIn)}–${niceDate(d.checkOut)} has been cancelled. ${sign}`,
      },
      sms: `Hi ${d.guestName || "there"}, your reservation at ${cfg.propertyName || "your stay"} (${niceDate(d.checkIn)}–${niceDate(d.checkOut)}) has been CANCELLED. ${sign}`,
    };
  }
  if (kind === "reply") {
    const r = `Reach out to ${cfg.hostName || "your host"}${cfg.adminPhone ? ` at ${cfg.adminPhone}` : ""} anytime.`;
    return {
      email: {
        subject: `Re: your message — ${cfg.propertyName || "your stay"}`,
        html: emailShell(
          `A note from ${cfg.hostName || "your host"}`,
          `<p style="margin:0 0 14px;line-height:1.6">Hi ${d.guestName || "there"},</p><p style="margin:0 0 14px;line-height:1.7;white-space:pre-wrap">${(d.reply || "").replace(/</g, "&lt;")}</p><p style="margin:14px 0 0;font-size:13px;color:${BRAND.muted}">${r}</p>`,
          cfg
        ),
        text: `Hi ${d.guestName || "there"},\n\n${d.reply}\n\n${r}`,
      },
      sms: `${cfg.hostName || "Host"}: ${d.reply}\n\n${r}`,
    };
  }
  if (kind === "confirmed") {
    return {
      email: {
        subject: `Reservation confirmed — ${cfg.propertyName || "your stay"} 🎉`,
        html: emailShell(
          "You're confirmed 🎉",
          `<p style="margin:0 0 16px;line-height:1.6">Hi ${d.guestName || "there"}, your reservation is confirmed — we can't wait to host you! Here are your details:</p>${summaryTable(d, cfg)}<p style="margin:16px 0 0;font-size:13px;color:${BRAND.muted}">Keep your booking code handy — you can use it on our site under “My Booking” to view your check-in guide and message us.</p>`,
          cfg
        ),
        text: `Hi ${d.guestName || "there"}, your booking at ${cfg.propertyName} is CONFIRMED for ${niceDate(d.checkIn)} to ${niceDate(d.checkOut)}. ${sign}`,
      },
      sms: [
        `Hi ${d.guestName || "there"}, you're CONFIRMED at ${cfg.propertyName || "your stay"} 🎉`,
        `Check-in: ${niceDate(d.checkIn)}${cfg.checkInTime ? ` · ${cfg.checkInTime}` : ""}`,
        `Check-out: ${niceDate(d.checkOut)}${cfg.checkOutTime ? ` · ${cfg.checkOutTime}` : ""}`,
        `${d.nights || nightsBetween(d.checkIn, d.checkOut)} night${(d.nights || nightsBetween(d.checkIn, d.checkOut)) !== 1 ? "s" : ""}${d.totalPrice ? ` · ${money(d.totalPrice)}` : ""}`,
        d.code ? `Booking code: ${d.code}` : null,
        sign,
      ].filter(Boolean).join("\n"),
    };
  }
  return null;
}
function buildAdmin(kind, d, cfg) {
  if (kind === "message") {
    return {
      email: {
        subject: `Guest message — ${d.code || "booking"} (${cfg.propertyName || "rental"})`,
        html: emailShell("New guest message", `${summaryTable(d, cfg)}<p style="margin:16px 0 6px;font-weight:600">Message</p><p style="margin:0;line-height:1.6;white-space:pre-wrap">${(d.message || "").replace(/</g, "&lt;")}</p>`, cfg),
        text: `Guest message (${d.code || "booking"}) from ${d.guestName}: ${d.message}`,
      },
      sms: `Guest message (${d.code || "booking"}) from ${d.guestName || "guest"}: ${(d.message || "").slice(0, 110)}`,
    };
  }
  if (kind === "request") {
    return {
      email: {
        subject: `New booking request — ${d.guestName || "Guest"}`,
        html: emailShell("New booking request", `${summaryTable(d, cfg)}${d.guestEmail ? `<p style="margin:14px 0 0;font-size:13px;color:${BRAND.muted}">Reply to the guest: ${d.guestEmail}${d.guestPhone ? ` · ${d.guestPhone}` : ""}</p>` : ""}${d.notes ? `<p style="margin:10px 0 0;font-size:13px"><b>Notes:</b> ${String(d.notes).replace(/</g, "&lt;")}</p>` : ""}<p style="margin:14px 0 0;font-size:13px;color:${BRAND.muted}">Confirm it in your Admin dashboard to send the guest their confirmation.</p>`, cfg),
        text: `New booking request: ${d.guestName}, ${niceDate(d.checkIn)}–${niceDate(d.checkOut)}. Review in admin.`,
      },
      sms: `New booking request: ${d.guestName || "Guest"}, ${niceDate(d.checkIn)}–${niceDate(d.checkOut)}, ${cfg.propertyName || "rental"}. Review in admin.`,
    };
  }
  if (kind === "confirmed") {
    return {
      email: {
        subject: `Booking confirmed — ${d.guestName || "Guest"}`,
        html: emailShell("Booking confirmed", `${summaryTable(d, cfg)}<p style="margin:14px 0 0;font-size:13px;color:${BRAND.muted}">The guest and cleaner have been notified.</p>`, cfg),
        text: `Booking confirmed: ${d.guestName}, ${niceDate(d.checkIn)}–${niceDate(d.checkOut)}.`,
      },
      sms: null,
    };
  }
  if (kind === "cancelled") {
    return {
      email: {
        subject: `Booking cancelled — ${d.guestName || "Guest"}`,
        html: emailShell("Booking cancelled", `${summaryTable(d, cfg)}<p style="margin:14px 0 0;font-size:13px;color:${BRAND.muted}">The guest and cleaner have been notified.</p>`, cfg),
        text: `Booking cancelled: ${d.guestName}, ${niceDate(d.checkIn)}–${niceDate(d.checkOut)}.`,
      },
      sms: null,
    };
  }
  return null;
}
function buildCleaner(d, cfg, kind) {
  if (kind === "cancelled") {
    return {
      email: {
        subject: `Booking cancelled — ${niceDate(d.checkOut)} (${cfg.propertyName || "rental"})`,
        html: emailShell("Booking cancelled — no turnover", `${summaryTable(d, cfg)}<p style="margin:14px 0 0;font-size:13px;color:${BRAND.muted}">This booking was cancelled — no cleaning is needed for these dates.</p>`, cfg),
        text: `Cancelled: the booking at ${cfg.propertyName} for ${niceDate(d.checkIn)}–${niceDate(d.checkOut)} is cancelled. No cleaning needed.`,
      },
      sms: `Cancelled: ${cfg.propertyName || "booking"} ${niceDate(d.checkIn)}–${niceDate(d.checkOut)} is cancelled — no cleaning needed for these dates.`,
    };
  }
  return {
    email: {
      subject: `Turnover needed — ${niceDate(d.checkOut)} (${cfg.propertyName || "rental"})`,
      html: emailShell("New booking — turnover", `${summaryTable(d, cfg)}<p style="margin:14px 0 0;font-size:13px;color:${BRAND.muted}">Please schedule the cleaning around the check-out time above.</p>`, cfg),
      text: `New booking at ${cfg.propertyName}: check-in ${niceDate(d.checkIn)} ${cfg.checkInTime || ""}, check-out ${niceDate(d.checkOut)} ${cfg.checkOutTime || ""}. Schedule cleaning.`,
    },
    sms: `New booking at ${cfg.propertyName || "the rental"}: check-in ${niceDate(d.checkIn)} ${cfg.checkInTime || ""}, check-out ${niceDate(d.checkOut)} ${cfg.checkOutTime || ""}. Please schedule cleaning.`,
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const kind = body.kind;
    const d = body.data || {};
    if (!["request", "confirmed", "message", "reply", "cancelled"].includes(kind)) return res.status(400).json({ error: "unknown kind" });

    const { data: store } = await openSheet();
    const cfg = store.config || {};
    const results = [];

    // Customer (guest) — request + confirmed
    const cust = buildCustomer(kind, d, cfg);
    if (cust) {
      if (d.guestEmail) results.push(await sendEmail(d.guestEmail, cust.email.subject, cust.email.html, cust.email.text, cfg.adminEmail));
      if (d.guestPhone) results.push(await sendSms(d.guestPhone, cust.sms));
    }
    // Admin — all kinds
    const adm = buildAdmin(kind, d, cfg);
    if (adm) {
      if (cfg.adminEmail && adm.email) results.push(await sendEmail(cfg.adminEmail, adm.email.subject, adm.email.html, adm.email.text, d.guestEmail));
      if (cfg.adminPhone && adm.sms) results.push(await sendSms(cfg.adminPhone, adm.sms));
    }
    // Cleaner — on confirmed and cancelled
    if (kind === "confirmed" || kind === "cancelled") {
      const cl = buildCleaner(d, cfg, kind);
      if (cfg.cleanerEmail) results.push(await sendEmail(cfg.cleanerEmail, cl.email.subject, cl.email.html, cl.email.text));
      if (cfg.cleanerPhone) results.push(await sendSms(cfg.cleanerPhone, cl.sms));
    }

    const sent = results.filter((r) => r && r.ok).length;
    res.status(200).json({ ok: true, sent, results });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
