// Vercel serverless function: all guest/host/cleaner notifications.
//
// The client sends only { kind, data } — recipients (admin/cleaner email+phone,
// host name, property, times) are read from the Sheet config server-side, so
// this can't be abused as an open relay.
//
//   kind "request"   -> customer "reservation requested" email + SMS (no payment
//                       ask — the host reaches out with payment details),
//                       admin alert email + SMS
//   kind "approved"  -> customer "payment details" email + SMS (the host approved
//                       the dates; here's how to pay), admin notice
//   kind "confirmed" -> customer confirmation email + SMS (guest has paid),
//                       cleaner email + SMS (with check-in/out date & time),
//                       admin email notice
//   kind "checkin"   -> customer check-in reminder (data.when "soon" | "today")
//   kind "checkout"  -> customer check-out reminder (data.when "soon" | "today")
//   kind "message"   -> admin alert email + SMS
//   kind "reply"     -> customer reply email + SMS
//   kind "cancelled" -> customer + cleaner + admin cancellation notices
//
// Email via Resend (RESEND_API_KEY, MAIL_FROM). SMS via Twilio
// (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM). Each channel is skipped
// when its env vars / the target address are missing. NOTE: emailing customers
// (any address other than your own) requires a verified domain in Resend.
//
// The per-kind dispatch is exported as `send(kind, data)` so other serverless
// functions (e.g. the /api/cron reminder job) can reuse it without an HTTP hop.

const { openSheet } = require("../lib/google");

const BRAND = { bg: "#FBF8F4", card: "#FFFFFF", ink: "#2C2622", muted: "#7A7167", accent: "#B0744A", accentLt: "#F3E7DD", line: "#ECE5DC" };

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
// Coerce a phone number to E.164 (Twilio requires it). US-friendly: 10 digits
// → +1XXXXXXXXXX, 11 digits starting 1 → +1…, already-+ kept. Anything else is
// passed through for Twilio to validate.
function e164(n) {
  if (!n) return n;
  const s = String(n).trim();
  if (s.startsWith("+")) return "+" + s.slice(1).replace(/\D/g, "");
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return s;
}
async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  const msid = process.env.TWILIO_MESSAGING_SERVICE_SID; // optional A2P route
  if (!sid || !auth || !to || (!from && !msid)) return { skipped: "sms" };
  // Prefer a Messaging Service (recommended for A2P 10DLC) when configured;
  // otherwise send from the number directly.
  const params = { To: e164(to), Body: body };
  if (msid) params.MessagingServiceSid = msid;
  else params.From = e164(from);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${auth}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  if (!r.ok) return { error: await r.text() };
  return { ok: true, channel: "sms", to: e164(to) };
}

/* ---------- formatting ---------- */
const money = (n) => (n != null && n !== "" ? "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "");
const esc = (s) => String(s == null ? "" : s).replace(/</g, "&lt;");
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
  const host = cfg.hostName || "your host";
  const sign = `Questions? Reach out to ${host}${cfg.adminPhone ? ` at ${cfg.adminPhone}` : ""}.`;
  if (kind === "request") {
    // No "go pay now" ask — the host will reach out with payment details.
    const note = `${host} will be in touch shortly with the payment details needed to confirm these dates.`;
    return {
      email: {
        subject: `Reservation requested — ${cfg.propertyName || "your stay"}`,
        html: emailShell(
          "Reservation requested",
          `<p style="margin:0 0 16px;line-height:1.6">Hi ${esc(d.guestName) || "there"}, thanks for your request! We've received it. ${esc(note)} Here are the details:</p>${summaryTable(d, cfg)}<p style="margin:16px 0 0;font-size:13px;color:${BRAND.muted}">This is a request, not yet a confirmed booking — you'll get a confirmation once payment is arranged. You can reply to this email to reach ${esc(host)}.</p>`,
          cfg
        ),
        text: `Hi ${d.guestName || "there"}, thanks — we received your reservation request for ${cfg.propertyName} (${niceDate(d.checkIn)} to ${niceDate(d.checkOut)}). ${note}`,
      },
      sms: `Hi ${d.guestName || "there"}, thanks for your booking request for ${cfg.propertyName || "your stay"} (${niceDate(d.checkIn)}–${niceDate(d.checkOut)}). ${note}`,
    };
  }
  if (kind === "approved") {
    // Host approved the dates → here's how to pay.
    const pay = (cfg.paymentInstructions || "").trim();
    const payHtml = pay
      ? `<div style="margin-top:16px;padding:14px 16px;background:${BRAND.accentLt};border:1px solid ${BRAND.accent};border-radius:12px;font-size:14px;line-height:1.7;color:${BRAND.ink}"><b>How to pay</b><div style="margin-top:6px;white-space:pre-wrap">${esc(pay)}</div></div>`
      : `<div style="margin-top:16px;padding:14px 16px;background:${BRAND.accentLt};border:1px solid ${BRAND.accent};border-radius:12px;font-size:14px;line-height:1.6;color:${BRAND.ink}"><b>Next step:</b> ${esc(host)} will share payment details with you directly${cfg.adminPhone ? ` at ${cfg.adminPhone}` : ""} to confirm your dates.</div>`;
    const payText = pay
      ? `How to pay: ${pay}`
      : `${host} will share payment details with you directly${cfg.adminPhone ? ` at ${cfg.adminPhone}` : ""}.`;
    return {
      email: {
        subject: `Payment details for your stay — ${cfg.propertyName || "your booking"}`,
        html: emailShell(
          "Your dates are approved",
          `<p style="margin:0 0 16px;line-height:1.6">Great news ${esc(d.guestName) || "there"} — ${esc(host)} has approved your dates! To lock everything in, please complete payment${d.totalPrice ? ` of <b>${money(d.totalPrice)}</b>` : ""}:</p>${summaryTable(d, cfg)}${payHtml}<p style="margin:16px 0 0;font-size:13px;color:${BRAND.muted}">As soon as your payment is received we'll send your confirmation and check-in details. Reply to this email anytime with questions.</p>`,
          cfg
        ),
        text: `Hi ${d.guestName || "there"}, ${host} approved your dates at ${cfg.propertyName} (${niceDate(d.checkIn)}–${niceDate(d.checkOut)})${d.totalPrice ? `, total ${money(d.totalPrice)}` : ""}. ${payText} Once payment is received we'll confirm.`,
      },
      sms: `Hi ${d.guestName || "there"}, ${host} approved your dates at ${cfg.propertyName || "your stay"} (${niceDate(d.checkIn)}–${niceDate(d.checkOut)})${d.totalPrice ? ` — ${money(d.totalPrice)}` : ""}. ${payText}`,
    };
  }
  if (kind === "cancelled") {
    return {
      email: {
        subject: `Reservation cancelled — ${cfg.propertyName || "your stay"}`,
        html: emailShell(
          "Reservation cancelled",
          `<p style="margin:0 0 16px;line-height:1.6">Hi ${esc(d.guestName) || "there"}, your reservation for the dates below has been cancelled.</p>${summaryTable(d, cfg)}<p style="margin:16px 0 0;font-size:13px;color:${BRAND.muted}">If this is unexpected or you have questions, just reply to this email.</p>`,
          cfg
        ),
        text: `Hi ${d.guestName || "there"}, your reservation at ${cfg.propertyName} for ${niceDate(d.checkIn)}–${niceDate(d.checkOut)} has been cancelled. ${sign}`,
      },
      sms: `Hi ${d.guestName || "there"}, your reservation at ${cfg.propertyName || "your stay"} (${niceDate(d.checkIn)}–${niceDate(d.checkOut)}) has been CANCELLED. ${sign}`,
    };
  }
  if (kind === "reply") {
    const r = `Reach out to ${host}${cfg.adminPhone ? ` at ${cfg.adminPhone}` : ""} anytime.`;
    const orig = (d.originalMessage || "").trim();
    const quotedHtml = orig
      ? `<div style="margin-top:16px;padding:12px 14px;background:${BRAND.bg};border-left:3px solid ${BRAND.line};border-radius:8px"><div style="font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:${BRAND.muted};font-weight:700;margin-bottom:4px">Your message</div><div style="font-size:13px;color:${BRAND.muted};white-space:pre-wrap">${esc(orig)}</div></div>`
      : "";
    return {
      email: {
        subject: `Re: your message — ${cfg.propertyName || "your stay"}`,
        html: emailShell(
          `A note from ${esc(host)}`,
          `<p style="margin:0 0 14px;line-height:1.6">Hi ${esc(d.guestName) || "there"},</p><p style="margin:0 0 14px;line-height:1.7;white-space:pre-wrap">${esc(d.reply)}</p><p style="margin:14px 0 0;font-size:13px;color:${BRAND.muted}">${r}</p>${quotedHtml}`,
          cfg
        ),
        text: `Hi ${d.guestName || "there"},\n\n${d.reply}\n\n${r}${orig ? `\n\n———\nYour message: "${orig}"` : ""}`,
      },
      sms: `${host}: ${d.reply}${orig ? `\n(re: "${orig.slice(0, 60)}${orig.length > 60 ? "…" : ""}")` : ""}\n\n${r}`,
    };
  }
  if (kind === "confirmed") {
    return {
      email: {
        subject: `Reservation confirmed — ${cfg.propertyName || "your stay"} 🎉`,
        html: emailShell(
          "You're confirmed 🎉",
          `<p style="margin:0 0 16px;line-height:1.6">Hi ${esc(d.guestName) || "there"}, your reservation is confirmed — we can't wait to host you! Here are your details:</p>${summaryTable(d, cfg)}<p style="margin:16px 0 0;font-size:13px;color:${BRAND.muted}">Keep your booking code handy — you can use it on our site under “My Booking” to view your check-in guide and message us.</p>`,
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
  if (kind === "checkin") {
    const soon = d.when !== "today";
    const guide = d.code ? ` Your booking code ${d.code} unlocks your check-in guide on our site.` : "";
    return {
      email: {
        subject: soon ? `Your stay is coming up — ${cfg.propertyName || "your booking"}` : `Check-in today — ${cfg.propertyName || "your booking"} 🔑`,
        html: emailShell(
          soon ? "Your stay is coming up" : "Check-in is today 🔑",
          `<p style="margin:0 0 16px;line-height:1.6">Hi ${esc(d.guestName) || "there"}, ${soon ? `your stay at ${esc(cfg.propertyName) || "our place"} is almost here!` : `today's the day — welcome!`} Here's what you need:</p>${summaryTable(d, cfg)}<p style="margin:16px 0 0;font-size:13px;color:${BRAND.muted}">Check-in is from ${esc(cfg.checkInTime) || "the afternoon"}.${esc(guide)}</p>`,
          cfg
        ),
        text: `Hi ${d.guestName || "there"}, ${soon ? `your stay at ${cfg.propertyName} is coming up` : `check-in at ${cfg.propertyName} is today`} — ${niceDate(d.checkIn)}${cfg.checkInTime ? ` from ${cfg.checkInTime}` : ""}.${guide} ${sign}`,
      },
      sms: `Hi ${d.guestName || "there"}, ${soon ? `your stay at ${cfg.propertyName || "our place"} is coming up` : `check-in is TODAY`}: ${niceDate(d.checkIn)}${cfg.checkInTime ? ` from ${cfg.checkInTime}` : ""}.${guide} ${sign}`,
    };
  }
  if (kind === "checkout") {
    const soon = d.when !== "today";
    return {
      email: {
        subject: soon ? `Check-out reminder — ${cfg.propertyName || "your booking"}` : `Check-out today — ${cfg.propertyName || "your booking"}`,
        html: emailShell(
          soon ? "Check-out is coming up" : "Check-out is today",
          `<p style="margin:0 0 16px;line-height:1.6">Hi ${esc(d.guestName) || "there"}, ${soon ? "just a heads-up that your stay is wrapping up soon." : "we hope you had a wonderful stay!"} Check-out is ${niceDate(d.checkOut)}${cfg.checkOutTime ? ` by ${esc(cfg.checkOutTime)}` : ""}.</p>${summaryTable(d, cfg)}<p style="margin:16px 0 0;font-size:13px;color:${BRAND.muted}">Thanks so much for staying with us. Reply to this email if you need anything.</p>`,
          cfg
        ),
        text: `Hi ${d.guestName || "there"}, ${soon ? "check-out is coming up" : "check-out is today"} at ${cfg.propertyName}: ${niceDate(d.checkOut)}${cfg.checkOutTime ? ` by ${cfg.checkOutTime}` : ""}. Thanks for staying! ${sign}`,
      },
      sms: `Hi ${d.guestName || "there"}, ${soon ? "check-out is coming up" : "check-out is TODAY"}: ${niceDate(d.checkOut)}${cfg.checkOutTime ? ` by ${cfg.checkOutTime}` : ""}. Thanks for staying at ${cfg.propertyName || "our place"}! ${sign}`,
    };
  }
  return null;
}
function buildAdmin(kind, d, cfg) {
  if (kind === "message") {
    return {
      email: {
        subject: `Guest message — ${d.code || "booking"} (${cfg.propertyName || "rental"})`,
        html: emailShell("New guest message", `${summaryTable(d, cfg)}<p style="margin:16px 0 6px;font-weight:600">Message</p><p style="margin:0;line-height:1.6;white-space:pre-wrap">${esc(d.message)}</p>`, cfg),
        text: `Guest message (${d.code || "booking"}) from ${d.guestName}: ${d.message}`,
      },
      sms: `Guest message (${d.code || "booking"}) from ${d.guestName || "guest"}: ${(d.message || "").slice(0, 110)}`,
    };
  }
  if (kind === "request") {
    return {
      email: {
        subject: `New booking request — ${d.guestName || "Guest"}`,
        html: emailShell("New booking request", `${summaryTable(d, cfg)}${d.guestEmail ? `<p style="margin:14px 0 0;font-size:13px;color:${BRAND.muted}">Reply to the guest: ${esc(d.guestEmail)}${d.guestPhone ? ` · ${esc(d.guestPhone)}` : ""}</p>` : ""}${d.notes ? `<p style="margin:10px 0 0;font-size:13px"><b>Notes:</b> ${esc(d.notes)}</p>` : ""}<p style="margin:14px 0 0;font-size:13px;color:${BRAND.muted}">Review it in your Admin dashboard — accept it, then approve to send the guest payment details.</p>`, cfg),
        text: `New booking request: ${d.guestName}, ${niceDate(d.checkIn)}–${niceDate(d.checkOut)}. Review in admin.`,
      },
      sms: `New booking request: ${d.guestName || "Guest"}, ${niceDate(d.checkIn)}–${niceDate(d.checkOut)}, ${cfg.propertyName || "rental"}. Review in admin.`,
    };
  }
  if (kind === "approved") {
    return {
      email: {
        subject: `Payment details sent — ${d.guestName || "Guest"}`,
        html: emailShell("Booking approved", `${summaryTable(d, cfg)}<p style="margin:14px 0 0;font-size:13px;color:${BRAND.muted}">The guest was sent payment details. Once they pay, hit “Mark paid &amp; confirm” to send their confirmation and notify the cleaner.</p>`, cfg),
        text: `Approved & payment details sent to ${d.guestName} for ${niceDate(d.checkIn)}–${niceDate(d.checkOut)}.`,
      },
      sms: null,
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

const KINDS = ["request", "approved", "confirmed", "checkin", "checkout", "message", "reply", "cancelled"];

// Per-kind dispatch. Loads config from the Sheet (unless a cfg is supplied by a
// caller that already has it, e.g. the cron job batching many sends). Returns
// { ok, sent, results }. Reusable by other functions without an HTTP hop.
async function send(kind, data, cfgMaybe) {
  if (!KINDS.includes(kind)) throw new Error("unknown kind: " + kind);
  const d = data || {};
  let cfg = cfgMaybe;
  if (!cfg) {
    const { data: store } = await openSheet();
    cfg = store.config || {};
  }
  const results = [];

  // Customer (guest)
  const cust = buildCustomer(kind, d, cfg);
  if (cust) {
    if (d.guestEmail) results.push(await sendEmail(d.guestEmail, cust.email.subject, cust.email.html, cust.email.text, cfg.adminEmail));
    if (d.guestPhone) results.push(await sendSms(d.guestPhone, cust.sms));
  }
  // Admin
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
  return { ok: true, sent, results };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    if (!KINDS.includes(body.kind)) return res.status(400).json({ error: "unknown kind" });
    const result = await send(body.kind, body.data || {});
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
module.exports.send = send;
