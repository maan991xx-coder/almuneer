// Program rules: daily marks, weekly necklaces, monthly points, medals and penalty actions.
// Dates are plain "YYYY-MM-DD" strings in the program's time zone (Asia/Muscat).
(function (global) {
  const WORKDAYS = 5; // Sunday..Thursday; Friday and Saturday are review days
  const DAY_NAMES = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  const MONTH_NAMES = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

  const NECKLACES = [
    { min: 5, key: "gold", sym: "🥇", name: "قلادة ذهبية", points: 3 },
    { min: 4, key: "silver", sym: "🥈", name: "قلادة فضية", points: 2 },
    { min: 3, key: "bronze", sym: "🥉", name: "قلادة برونزية", points: 1 },
    { min: 2, key: "notice", sym: "⭕", name: "تنبيه", points: 0 },
    { min: 0, key: "warning", sym: "⚠️", name: "إنذار", points: 0 },
  ];
  const MEDALS = [
    { min: 10, key: "excellence", sym: "🏆", name: "وسام التميّز" },
    { min: 7, key: "diligence", sym: "🌟", name: "وسام الاجتهاد" },
    { min: 4, key: "commitment", sym: "💫", name: "وسام الالتزام" },
  ];
  const ACTIONS = {
    notice: { name: "تنبيه على الخاص", rank: 1 },
    contact: { name: "تواصل من الإدارة", rank: 2 },
    expel: { name: "طرد من البرنامج", rank: 3 },
  };
  const MARK_SYM = { ok: "✅", miss: "❌", ex: "📝", wait: "⏳", pend: "⏳", off: "➖" };

  const toDate = (iso) => new Date(iso + "T00:00:00Z");
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const dow = (s) => toDate(s).getUTCDay();
  const weekStart = (s) => addDays(s, -dow(s));
  const weekDays = (sun) => Array.from({ length: WORKDAYS }, (_, i) => addDays(sun, i));
  // A week belongs to the month holding most of its five days, i.e. the month of its Tuesday.
  const weekMonth = (sun) => addDays(sun, 2).slice(0, 7);
  const monthWeeks = (ym) => {
    const first = ym + "-01";
    let sun = weekStart(addDays(first, -2));
    const out = [];
    for (let i = 0; i < 7; i++, sun = addDays(sun, 7)) if (weekMonth(sun) === ym) out.push(sun);
    return out;
  };
  const todayISO = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz || "Asia/Muscat", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const shiftMonth = (ym, n) => { const d = toDate(ym + "-01"); d.setUTCMonth(d.getUTCMonth() + n); return iso(d).slice(0, 7); };

  const ar = (v) => String(v).replace(/\d/g, (c) => "٠١٢٣٤٥٦٧٨٩"[c]);
  const fmtDay = (s) => { const [y, m, d] = s.split("-"); return `${ar(+d)}/ ${ar(+m)}/ ${ar(y)}م`; };
  const fmtShort = (s) => { const [, m, d] = s.split("-"); return `${ar(+d)}/${ar(+m)}`; };
  const monthName = (ym) => { const [y, m] = ym.split("-"); return `${MONTH_NAMES[+m - 1]} ${ar(y)}م`; };

  // data: { reports: Set("sid|day"), excuses: Map("sid|day" -> status) }
  function dayMark(st, day, data, today) {
    if (day < st.start_date) return "off";
    const k = st.id + "|" + day;
    if (data.reports.has(k)) return "ok";
    const ex = data.excuses.get(k);
    if (ex === "accepted") return "ex";
    if (day >= today) return "wait";
    if (ex === "pending") return "pend";
    return "miss";
  }

  function necklaceFor(okCount) { return NECKLACES.find((n) => okCount >= n.min); }

  // Necklace is decided by committed days only (excuse days are not commitment days).
  // A week is evaluated only if the student had joined by its Sunday, and is final once Thursday has passed.
  function weekResult(st, sun, data, today) {
    if (st.start_date > sun) return null;
    const days = weekDays(sun);
    const marks = days.map((d) => dayMark(st, d, data, today));
    const ok = marks.filter((m) => m === "ok").length;
    const final = today > days[WORKDAYS - 1];
    const n = necklaceFor(ok);
    return { sun, days, marks, ok, final, necklace: n };
  }

  function medalFor(points) { return MEDALS.find((m) => points >= m.min) || null; }

  // Monthly: points from the month's first four weeks; penalties from every finished week; reset each month.
  function monthSummary(st, ym, data, today) {
    const weeks = monthWeeks(ym).filter((sun) => sun <= today).map((sun) => weekResult(st, sun, data, today)).filter(Boolean);
    const finals = weeks.filter((w) => w.final);
    const counted = monthWeeks(ym).slice(0, 4);
    const points = finals.filter((w) => counted.includes(w.sun)).reduce((s, w) => s + w.necklace.points, 0);
    const notices = finals.filter((w) => w.necklace.key === "notice").length;
    const warnings = finals.filter((w) => w.necklace.key === "warning").length;
    let action = null;
    if (warnings >= 3) action = "expel";
    else if (warnings === 2) action = "contact";
    else if (warnings === 1 || notices >= 3) action = "notice";
    return { ym, weeks, finals, points, medal: medalFor(points), notices, warnings, action };
  }

  const api = { WORKDAYS, DAY_NAMES, MONTH_NAMES, NECKLACES, MEDALS, ACTIONS, MARK_SYM, addDays, dow, weekStart, weekDays, weekMonth, monthWeeks, todayISO, shiftMonth, ar, fmtDay, fmtShort, monthName, dayMark, necklaceFor, weekResult, medalFor, monthSummary };
  global.Rules = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
