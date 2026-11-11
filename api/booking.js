// Vercel serverless function: the guest's "My Booking" lookup.
//
// POST { code } → that booking's dates and contact details, plus the entrance
// guide when it's open for them (confirmed, from `guideLeadDays` before
// check-in until check-out time; see lib/access.js). The guide text is
// served from here only and is never in the public site data.
//
// The guest's personal link is /?booking=CODE, which opens this lookup.
// TEST1234 returns a sample booking with placeholder text, never the real guide.

const { openSheet } = require("../lib/google");
const { guideState, guideWindow, leadDays, nowAtProperty, shiftDate } = require("../lib/access");

const TEST_CODE = "TEST1234";

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const code = String(body.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ error: "missing code" });

    const { data: map } = await openSheet();
    const cfg = map.config || {};
    const times = { checkInTime: cfg.checkInTime || "", checkOutTime: cfg.checkOutTime || "" };

    if (code === TEST_CODE) {
      const today = nowAtProperty().slice(0, 10);
      const b = { code: TEST_CODE, guestName: "Test Guest", checkIn: today, checkOut: shiftDate(today, 3), status: "confirmed", _test: true };
      return res.status(200).json({
        booking: b,
        ...times,
        guide: {
          state: "open",
          ...guideWindow(b, cfg),
          text: `This is a sample booking. A confirmed guest sees your real entrance guide here from ${leadDays(cfg)} day(s) before check-in until check-out time.`,
        },
      });
    }

    const bookings = Array.isArray(map.bookings) ? map.bookings : [];
    const b = bookings.find((x) => x && String(x.code || "").toUpperCase() === code);
    if (!b) return res.status(404).json({ error: "not found" });

    const state = guideState(b, cfg);
    return res.status(200).json({
      booking: {
        code: b.code, guestName: b.guestName || "", guestEmail: b.guestEmail || "", guestPhone: b.guestPhone || "",
        checkIn: b.checkIn, checkOut: b.checkOut, status: b.status || "pending",
      },
      ...times,
      guide: {
        state,
        ...guideWindow(b, cfg),
        ...(state === "open" ? { text: cfg.guestGuide || "" } : {}),
      },
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
