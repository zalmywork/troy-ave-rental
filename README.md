# Troy Ave Rental — booking site & manager

Live: **https://troy-ave-rental.vercel.app**
Repo: **https://github.com/zalmywork/troy-ave-rental**

One short-term rental, run end-to-end: a public listing page where guests request
dates, plus a PIN-protected admin dashboard for bookings, pricing, messages and
metrics, and a cleaning view for the turnover crew. Guests, the host and the
cleaner get email + SMS automatically at each step.

---

## 1. How it's built (read this first)

There is **no build step and no npm install.** The whole front end is one file,
`index.html`, that loads React from a CDN and compiles its JSX in the browser
with Babel. You edit the file, push to GitHub, and Vercel redeploys in about
thirty seconds. That's the entire loop.

```
index.html      the whole app — guest site, admin dashboard, cleaning view (~1,500 lines)
optin.html      SMS opt-in policy page (required by the phone carrier)
privacy.html    privacy policy
terms.html      terms of service
photos/         property photos, served at /photos/*
vercel.json     one line of config: the daily cron schedule
api/            serverless functions (Node, zero dependencies)
  sheet.js        read/write all site data to the Google Sheet
  notify.js       every email + SMS the system sends
  cron.js         daily check-in / check-out reminders
  sms.js          inbound SMS webhook (guest texts the number)
lib/google.js   Google Sheets auth + read/write helpers
```

**Data lives in a Google Sheet, not a database.** The first tab holds two
columns, `key` and `value`. Each row is one key — `config`, `bookings`,
`pricing`, `requests`, `messages` — whose value is a JSON string. `api/sheet.js`
reads and writes that whole map. You can read and fix it by hand if you ever need
to, but be careful: every POST rewrites the sheet, so don't hand-edit while
someone is using the dashboard.

The browser also keeps a `localStorage` cache so the UI is instant, then hydrates
from the Sheet on load. Writes go to both. Remote writes are serialized through a
queue (`_enqueueWrite`, around line 137 of `index.html`) because each POST is a
read-modify-write of the entire sheet — two concurrent writes would clobber each
other. If you add a new write path, send it through that queue.

---

## 2. Making a change

```bash
git clone https://github.com/zalmywork/troy-ave-rental.git
```

Edit `index.html`, then:

```bash
git commit -am "what you changed" && git push
```

Vercel builds from `main` automatically. Nothing needs to run locally — but if
you want a preview, any static server works (`npx serve .`). The `/api/*` routes
won't respond locally unless you run `vercel dev` with the env vars below.

### Where things are in `index.html`

| What | Around line |
| --- | --- |
| Default photos (`DEFAULT_PHOTOS`) | 38 |
| Default property config — rates, times, PINs, host name (`defaultConfig`) | 46 |
| Length-of-stay discounts: 7 nights 10%, 14 nights 25% (`LOS_DISCOUNTS`) | 81 |
| localStorage + Sheet sync | 114 |
| Colors and fonts (`P`, `F`, `FD`, `FH`) | 183 |
| Shared UI pieces — Modal, Input, Button, Gallery, Lightbox, Calendar | 196–450 |
| Main app state (`function App()`) | 412 |
| PIN login screen | 760 |
| Guest-facing site | 775 |
| Cleaning view | 1041 |
| Admin dashboard and its tab list | 1089 |

The admin tabs are Property, Calendar, Bookings, Pricing, Requests, Messages,
Metrics, Guide and Settings. Each one is a `{aTab==="…" && (…)}` block under the
tab list, so adding a tab is one entry in the `tabs` array plus one block.

Most day-to-day settings — nightly rate, weekend rate, cleaning fee, deposit,
check-in/out times, PINs, host and cleaner contacts, payment instructions, the
guest guide — are edited **in the dashboard under Settings**, not in code. They
live in the Sheet's `config` row. Only change `defaultConfig` if you want to
change what a brand-new install starts with.

---

## 3. The booking flow

1. A guest picks dates on the public page and submits a request. It's saved to
   `requests`, and `notify("request")` emails and texts the guest a "we got it"
   note, then alerts the host.
2. The host opens **Requests** and approves, which sends the guest payment
   instructions (`approved`) taken from `config.paymentInstructions`. Payment
   happens off-site — there's no payment processor wired in.
3. The host marks it paid and it becomes a confirmed **booking** with a code like
   `TRA-7K2QX`. The guest gets a confirmation; the cleaner gets the dates and
   times.
4. `api/cron.js` runs daily at 14:00 UTC and sends check-in reminders three days
   out and on the day, check-out reminders two days out and on the day. Each
   reminder sets a flag on the booking *before* sending, so re-running the job
   never double-sends.
5. Guests look up their booking with their code. `TEST1234` is a permanent test
   code for checking the guest portal.

Guests who text the Twilio number hit `api/sms.js`, which threads the message
onto their booking (matched by phone number) into the **Messages** tab and alerts
the host. Replying from the dashboard texts and emails them back.

---

## 4. Accounts and environment variables

Everything secret is a **Vercel environment variable** — nothing sensitive is in
this repo, which is public. Set them under Vercel → Project → Settings →
Environment Variables. Missing ones degrade gracefully: no `RESEND_API_KEY` means
email is skipped rather than erroring.

| Variable | What it's for |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The full service-account JSON, pasted as one line. That service account's email has to be shared on the Sheet as an Editor. |
| `SHEET_ID` | The Google Sheet's ID — the long string in its URL. |
| `RESEND_API_KEY` | Resend, for all outbound email. |
| `MAIL_FROM` | Sender address. Emailing anyone but yourself requires a verified domain in Resend. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Twilio credentials. |
| `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | The sending number or messaging service. |
| `CRON_SECRET` | Optional. If set, `/api/cron` rejects anything without `Authorization: Bearer <secret>`; Vercel sends it automatically. |
| `NOTIFY_TEST_EMAIL` | Optional safety net: redirects **every** email to one inbox, subject prefixed `[TEST → real@address]`. Set it while testing so real guests are never contacted, and unset it to go live. |
| `NOTIFY_TEST_SMS` | Same idea for SMS. |

Services in play: **Vercel** (hosting and cron), **GitHub** (source), **Google
Sheets** (data), **Resend** (email), **Twilio** (SMS). The Twilio number is
toll-free and carrier-verified against `/optin.html`, `/privacy.html` and
`/terms.html` — leave those three pages up.

---

## 5. Worth knowing before you change something

- **JSX compiles in the browser.** A syntax error in `index.html` won't fail the
  build — Vercel deploys it happily and the page renders blank. Always open the
  live URL after a push and check the browser console.
- **Don't reformat `index.html` wholesale.** It's dense on purpose (inline
  styles, compact JSX). A reformat makes every future diff unreadable.
- **The Sheet is the source of truth.** If the dashboard looks stale, check the
  Sheet before suspecting the code.
- **`api/notify.js` is the big one** (~450 lines). Every email template and SMS
  string lives there, organized by `kind`: `request`, `approved`, `confirmed`,
  `checkin`, `checkout`, `message`, `reply`, `cancelled`. Copy changes go here.
  Its `send(kind, data)` is exported so `api/cron.js` can call it directly
  without an HTTP hop.
- **Recipients are resolved server-side** from the Sheet config and never sent by
  the browser, so `/api/notify` can't be abused as an open mail relay. Keep it
  that way if you extend it.
- **PINs aren't real security.** They live in the Sheet config and gate the admin
  and cleaning views client-side. Fine for this use — just don't put anything
  genuinely sensitive behind them.

---

## 6. Taking over — checklist

- [ ] GitHub: get added as a collaborator on `zalmywork/troy-ave-rental`, or have the repo transferred.
- [ ] Vercel: get added to the project, or transfer it to your own account — and copy the env vars over if you transfer.
- [ ] Google Sheet: get Editor access (or ownership) on the data sheet, and keep the service account shared on it.
- [ ] Resend: account access and the verified sending domain.
- [ ] Twilio: account access, the toll-free number, and its messaging configuration — the inbound webhook must point at `https://<your-domain>/api/sms`.
- [ ] Change the admin and cleaning PINs under Settings.
- [ ] Update the admin email and phone under Settings so alerts come to you.
