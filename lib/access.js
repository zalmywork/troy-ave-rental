// Who may see what. Shared by /api/sheet, /api/booking and /api/notify.
//
// 1. Sessions. The admin and cleaning PINs are checked on the server
//    (/api/sheet action "login"), which hands back a signed session token. The
//    browser sends it as the X-Session header. A token names its role, expires
//    after SESSION_DAYS, and carries a hash of the PIN it was issued for, so
//    changing a PIN under Settings ends every session made with the old one.
//
// 2. Public view. Visitors without a session get only what the guest page
//    shows: property info, prices and which dates are taken. Never the guide,
//    the PINs, payment instructions, or anyone's name, email, phone or code.
//
// 3. The entrance guide. Only a CONFIRMED booking can open it, from midnight
//    `guideLeadDays` days before check-in (default 2) until check-out time on
//    the check-out day, in the property's time zone. Cancel a booking or move
//    its dates and the guide follows, because it is checked on every request.

const crypto = require("crypto");
const { getCreds } = require("./google");

const SESSION_DAYS = 7;
const TZ = process.env.PROPERTY_TZ || "America/New_York";
const DEFAULT_LEAD_DAYS = 2;
const SITE_URL = (process.env.SITE_URL || "https://troy-ave-rental.vercel.app").replace(/\/+$/, "");

// Fallbacks match what the dashboard has always used when a PIN is blank.
const pinFor = (role, cfg) =>
  String((role === "admin" ? cfg.adminPin || "1234" : cfg.cleaningPin || "0000"));

/* ---------- sessions ---------- */
let _key;
function signingKey() {
  if (!_key) {
    // SESSION_SECRET if set; otherwise derive one from the service account's
    // private key, which is already a server-only secret.
    const secret = process.env.SESSION_SECRET || getCreds().private_key;
    _key = crypto.createHash("sha256").update("tra-session|" + secret).digest();
  }
  return _key;
}
const mac = (s) => crypto.createHmac("sha256", signingKey()).update(s).digest("base64url");
const pinHash = (pin) => crypto.createHash("sha256").update("tra-pin|" + pin).digest("base64url").slice(0, 16);

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function issueSession(role, cfg) {
  const body = Buffer.from(JSON.stringify({ role, ph: pinHash(pinFor(role, cfg)), exp: Date.now() + SESSION_DAYS * 86400000 })).toString("base64url");
  return body + "." + mac(body);
}

// "admin" | "cleaning" | "public"
function roleOf(req, cfg) {
  const token = String((req.headers && req.headers["x-session"]) || "");
  const [body, sig] = token.split(".");
  if (!body || !sig || !safeEqual(sig, mac(body))) return "public";
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (p.role !== "admin" && p.role !== "cleaning") return "public";
    if (!(p.exp > Date.now())) return "public";
    if (!safeEqual(p.ph, pinHash(pinFor(p.role, cfg)))) return "public";
    return p.role;
  } catch {
    return "public";
  }
}

function checkPin(role, pin, cfg) {
  if (role !== "admin" && role !== "cleaning") return false;
  return safeEqual(String(pin || ""), pinFor(role, cfg));
}

/* ---------- public / cleaning views ---------- */
// Whitelist, so a new private setting never leaks by default.
const PUBLIC_CONFIG = [
  "propertyName", "address", "description", "photos", "checkInTime", "checkOutTime",
  "defaultNightlyRate", "weekendNightlyRate", "defaultMinNights", "cleaningFee",
  "depositAmount", "hostName", "adminEmail", "adminPhone", "guideLeadDays",
];

function viewFor(role, map) {
  if (role === "admin") return { ...map, _role: "admin" };
  const cfg = map.config || {};
  const config = { _public: true };
  for (const k of PUBLIC_CONFIG) if (cfg[k] !== undefined) config[k] = cfg[k];
  // Dates only: enough for the calendar to grey out taken nights. The cleaning
  // view also gets the guest's name for its turnover list.
  const bookings = (Array.isArray(map.bookings) ? map.bookings : []).map((b) => ({
    id: b.id, checkIn: b.checkIn, checkOut: b.checkOut, status: b.status, _public: true,
    ...(role === "cleaning" ? { guestName: b.guestName || "" } : {}),
  }));
  return { config, bookings, pricing: map.pricing || {}, minNights: map.minNights || {}, _role: role };
}

/* ---------- guide window ---------- */
// Current wall-clock time at the property, as "YYYY-MM-DD HH:MM" (sorts as text).
function nowAtProperty(date = new Date()) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// "11:00", "11", "11am", "4:30 PM" → "HH:MM" (24h). Anything else → fallback.
function toHHMM(t, fallback) {
  const m = String(t || "").trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!m) return fallback;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = (m[3] || "").toLowerCase()[0];
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  if (h > 23 || min > 59) return fallback;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function shiftDate(ds, days) {
  const [y, m, d] = String(ds).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function leadDays(cfg) {
  const n = Number(cfg.guideLeadDays);
  if (cfg.guideLeadDays === undefined || cfg.guideLeadDays === "" || !Number.isFinite(n)) return DEFAULT_LEAD_DAYS;
  return Math.min(14, Math.max(0, Math.round(n)));
}

// { opens, closes } as "YYYY-MM-DD HH:MM" property time.
function guideWindow(b, cfg) {
  return {
    opens: `${shiftDate(b.checkIn, -leadDays(cfg))} 00:00`,
    closes: `${b.checkOut} ${toHHMM(cfg.checkOutTime, "11:00")}`,
  };
}

// "open" | "early" | "ended" | "unconfirmed" | "cancelled"
function guideState(b, cfg, now = nowAtProperty()) {
  if (!b || !b.checkIn || !b.checkOut) return "unconfirmed";
  if (b.status === "cancelled") return "cancelled";
  if (b.status !== "confirmed") return "unconfirmed";
  const w = guideWindow(b, cfg);
  if (now < w.opens) return "early";
  if (now >= w.closes) return "ended";
  return "open";
}

const guideLink = (code) => `${SITE_URL}/?booking=${encodeURIComponent(code || "")}`;

module.exports = {
  issueSession, roleOf, checkPin, viewFor,
  nowAtProperty, toHHMM, shiftDate, leadDays, guideWindow, guideState, guideLink,
  SITE_URL, TZ,
};
