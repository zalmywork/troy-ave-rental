// Vercel Cron job: automatic guest check-in / check-out reminders.
//
// Runs daily (see vercel.json). For every CONFIRMED (paid) booking it sends:
//   • a check-in reminder a few days before, and again on check-in day
//   • a check-out reminder a couple days before, and again on check-out day
//
// Each reminder is sent at most once — a `reminders` flag map is stored on the
// booking and written back to the Sheet, so re-running the job is idempotent.
//
// Security: if CRON_SECRET is set, Vercel sends it as "Authorization: Bearer …";
// we reject anything else. If it's unset, the endpoint is open (fine pre-setup).

const { openSheet, writeAll } = require("../lib/google");
const notify = require("./notify");

const CHECKIN_LEAD = 3;  // days before check-in for the "coming up" nudge
const CHECKOUT_LEAD = 2; // days before check-out for the "wrapping up" nudge

const pad = (n) => String(n).padStart(2, "0");
const todayUTC = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
// Whole days from a→b (both "YYYY-MM-DD"), via UTC midnight to avoid DST drift.
function daysUntil(fromStr, toStr) {
  const [fy, fm, fd] = fromStr.split("-").map(Number);
  const [ty, tm, td] = toStr.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const { token, sheetId, tab, data: store } = await openSheet();
    const cfg = store.config || {};
    const bookings = Array.isArray(store.bookings) ? store.bookings : [];
    const today = todayUTC();

    const sends = [];   // { booking, kind, when }
    let dirty = false;

    for (const b of bookings) {
      if (!b || b.status !== "confirmed") continue;          // only paid/confirmed guests
      if (!b.checkIn || !b.checkOut) continue;
      if (!b.guestEmail && !b.guestPhone) continue;          // no way to reach them
      const r = b.reminders || (b.reminders = {});

      const toCheckin = daysUntil(today, b.checkIn);
      const toCheckout = daysUntil(today, b.checkOut);

      if (toCheckin === 0 && !r.ciDay) { r.ciDay = true; dirty = true; sends.push({ b, kind: "checkin", when: "today" }); }
      else if (toCheckin >= 1 && toCheckin <= CHECKIN_LEAD && !r.ciSoon) { r.ciSoon = true; dirty = true; sends.push({ b, kind: "checkin", when: "soon" }); }

      if (toCheckout === 0 && !r.coDay) { r.coDay = true; dirty = true; sends.push({ b, kind: "checkout", when: "today" }); }
      else if (toCheckout >= 1 && toCheckout <= CHECKOUT_LEAD && !r.coSoon) { r.coSoon = true; dirty = true; sends.push({ b, kind: "checkout", when: "soon" }); }
    }

    // Persist the flags first so a mid-send crash can't cause duplicate reminders.
    if (dirty) await writeAll(token, sheetId, tab, { ...store, bookings });

    const results = [];
    for (const s of sends) {
      try {
        const out = await notify.send(s.kind, { ...s.b, when: s.when }, cfg);
        results.push({ code: s.b.code, kind: s.kind, when: s.when, sent: out.sent });
      } catch (e) {
        results.push({ code: s.b.code, kind: s.kind, when: s.when, error: String((e && e.message) || e) });
      }
    }

    res.status(200).json({ ok: true, date: today, reminders: results.length, results });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
