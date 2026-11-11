// Runs every 30 min on GitHub Actions (free).
// Per device: daily "add your expenses" reminder at the time the user picked.
// Per user, once a day at that same time: bills coming due, budget alerts (80% / 100%),
// and on Sundays a weekly summary.
import admin from "firebase-admin";
import webpush from "web-push";

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
webpush.setVapidDetails("mailto:" + process.env.VAPID_CONTACT, process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);

const LATE_LIMIT_MIN = 180; // if GitHub runs late, still send up to 3h after the chosen time
const now = new Date();
const pad = n => String(n).padStart(2, "0");
const inr = n => "₹" + Math.round(n).toLocaleString("en-IN");

function local(tz) {
  let parts;
  try { parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(now); }
  catch { return local("Asia/Kolkata"); }
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, y: +p.year, m: +p.month, d: +p.day, min: +p.hour * 60 + +p.minute, weekday: p.weekday };
}
const shift = (date, days) => { const t = new Date(date + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10); };
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const isDue = (s, L) => { const [h, m] = (s.time || "20:00").split(":").map(Number), t = h * 60 + m; return L.min >= t && L.min < t + LATE_LIMIT_MIN; };

async function send(dev, title, body, stats) {
  try {
    await webpush.sendNotification({ endpoint: dev.data().endpoint, keys: dev.data().keys },
      JSON.stringify({ title, body }), { TTL: 4 * 3600, urgency: "normal" });
    stats.sent++; return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) { await dev.ref.delete(); stats.removed++; } // device unsubscribed
    else console.error("send failed:", e.statusCode || e.message);
    return false;
  }
}
const sendAll = async (devs, title, body, stats) => { for (const d of devs) await send(d, title, body, stats); };

// Expense rows split into category parts (an expense can be split across categories)
const parts = e => (e.splits && e.splits.length) ? e.splits : [{ category: e.category, amount: e.amount }];
const expensesBetween = async (uid, from, to) =>
  (await db.collection(`users/${uid}/expenses`).where("date", ">=", from).where("date", "<=", to).get())
    .docs.map(d => d.data()).filter(e => e.type !== "income");

function billDue(b, L) { // next due date (YYYY-MM-DD) and the period key it belongs to
  if (b.freq === "yearly") {
    const dm = +b.dueMonth || 1;
    for (const y of [L.y, L.y + 1]) {
      const due = `${y}-${pad(dm)}-${pad(Math.min(+b.dueDay || 1, daysIn(y, dm)))}`;
      if (b.lastPaid !== String(y) && (due >= shift(L.date, -3) || y > L.y)) return { due, period: String(y) };
    }
    return null;
  }
  for (const k of [0, 1]) {
    const y = L.m + k > 12 ? L.y + 1 : L.y, m = ((L.m + k - 1) % 12) + 1, period = `${y}-${pad(m)}`;
    if (b.lastPaid === period) continue;
    return { due: `${period}-${pad(Math.min(+b.dueDay || 1, daysIn(y, m)))}`, period };
  }
  return null;
}

const stats = { devices: 0, sent: 0, removed: 0 };
const snap = await db.collectionGroup("push").get();
const byUser = {};
for (const d of snap.docs) { if (d.data().enabled && d.data().endpoint) (byUser[d.ref.parent.parent.id] ||= []).push(d); }

for (const [uid, devs] of Object.entries(byUser)) {
  stats.devices += devs.length;
  const due = devs.filter(d => { const L = local(d.data().tz); return isDue(d.data(), L) && d.data().lastSent !== L.date; });
  if (!due.length) continue;
  const L = local(due[0].data().tz);

  // 1) Daily reminder on each device that's due
  const today = await expensesBetween(uid, L.date, L.date);
  const tot = today.reduce((t, e) => t + (e.amount || 0), 0);
  const body = today.length ? `${today.length} added today (${inr(tot)}). Anything else to add?`
                            : "You haven't added any expenses today. Tap to add them now.";
  for (const d of due) { if (await send(d, "💸 Daily expense check", body, stats)) await d.ref.update({ lastSent: L.date }); }

  // 2) Once-a-day user alerts (sent to all of the user's devices)
  const metaRef = db.doc(`users/${uid}/meta/alerts`);
  const meta = (await metaRef.get()).data() || {};
  if (meta.day === L.date) continue;
  const upd = { day: L.date, bills: meta.bills || {}, budget: meta.budget || {} };

  // 2a) Bills coming due (within each bill's "remind me" window, or up to 3 days overdue)
  const bills = (await db.collection(`users/${uid}/bills`).get()).docs.map(d => ({ id: d.id, ...d.data() })).filter(b => b.active !== false);
  const dueBills = [];
  for (const b of bills) {
    const x = billDue(b, L); if (!x) continue;
    const days = Math.round((Date.parse(x.due) - Date.parse(L.date)) / 864e5);
    const stage = days < 0 ? "overdue" : "soon";
    if (days <= (+b.remind || 0) && days >= -3 && upd.bills[b.id] !== `${x.period}:${stage}`) {
      upd.bills[b.id] = `${x.period}:${stage}`;
      dueBills.push(`${b.name} ${inr(b.amount)} ${days < 0 ? `overdue ${-days}d` : days === 0 ? "due today" : days === 1 ? "due tomorrow" : `due in ${days} days`}`);
    }
  }
  if (dueBills.length) await sendAll(devs, "🧾 Bills due", dueBills.join(" · "), stats);

  // 2b) Budget alerts at 80% and 100% (overall and per category), once each per month
  const settings = (await db.doc(`users/${uid}/settings/main`).get()).data() || {};
  const mKey = `${L.y}-${pad(L.m)}`;
  const month = await expensesBetween(uid, `${mKey}-01`, `${mKey}-31`);
  const sent = new Set((upd.budget[mKey] || []));
  const alerts = [];
  const check = (key, name, spent, limit) => {
    if (!limit) return;
    for (const lvl of [100, 80]) {
      if (spent >= limit * lvl / 100) {
        if (!sent.has(`${key}:${lvl}`)) { alerts.push(`${name}: ${inr(spent)} of ${inr(limit)} (${Math.round(spent / limit * 100)}%)`); sent.add(`${key}:${lvl}`); sent.add(`${key}:80`); }
        break;
      }
    }
  };
  check("total", "Monthly budget", month.reduce((t, e) => t + e.amount, 0), +settings.budget || 0);
  const byCat = {}; month.forEach(e => parts(e).forEach(p => byCat[p.category] = (byCat[p.category] || 0) + p.amount));
  for (const [c, lim] of Object.entries(settings.catBudget || {})) check("cat:" + c, c, byCat[c] || 0, +lim);
  upd.budget = { [mKey]: [...sent] }; // keep only this month
  if (alerts.length) await sendAll(devs, "⚠️ Budget alert", alerts.join(" · "), stats);

  // 2c) Weekly summary on Sunday
  if (L.weekday === "Sun" && meta.weekly !== L.date) {
    const two = await expensesBetween(uid, shift(L.date, -13), L.date);
    const wkFrom = shift(L.date, -6);
    const thisW = two.filter(e => e.date >= wkFrom), lastW = two.filter(e => e.date < wkFrom);
    const t1 = thisW.reduce((t, e) => t + e.amount, 0), t0 = lastW.reduce((t, e) => t + e.amount, 0);
    const cats = {}; thisW.forEach(e => parts(e).forEach(p => cats[p.category] = (cats[p.category] || 0) + p.amount));
    const top = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
    const chg = t0 ? ` (${t1 >= t0 ? "▲" : "▼"} ${Math.abs(Math.round((t1 - t0) / t0 * 100))}% vs last week)` : "";
    await sendAll(devs, "📊 Your week", `Spent ${inr(t1)} this week${chg}.${top ? ` Top: ${top[0]} ${inr(top[1])}.` : ""}`, stats);
    upd.weekly = L.date;
  }
  await metaRef.set(upd, { merge: false });
}
console.log(JSON.stringify(stats));
