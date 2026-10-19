/* برنامج المنير — single-page app (hash routing, Supabase backend) */
(function () {
  const C = window.APP_CONFIG;
  const R = window.Rules;
  const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey);
  const root = document.getElementById("root");

  const S = {
    me: null,
    groups: [],
    tab: null,
    scope: "",
    weekSun: null,
    month: null,
    today: R.todayISO(C.timeZone),
  };

  const ROLE_NAMES = { admin: "مدير البرنامج", assistant: "مساعد", supervisor: "مشرف", student: "طالب" };
  const TRACKS = ["الأنوار", "الألفية", "المدارج"];
  const EXCUSE_TYPES = ["المرض أو العارض الصحي", "السفر أو الانتقال", "الاختبارات والارتباطات الدراسية", "الظروف العائلية أو الطارئة", "ظروف العمل والالتزامات الضرورية", "أخرى"];
  const STATUS_NAMES = { active: "نشط", expelled: "مطرود", withdrawn: "منسحب" };

  /* ---------- helpers ---------- */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isStaff = () => S.me && (S.me.role === "admin" || S.me.role === "assistant");
  const isManager = () => S.me && S.me.role !== "student";
  const normPhone = (p) => {
    let d = String(p || "").replace(/[٠-٩]/g, (c) => "٠١٢٣٤٥٦٧٨٩".indexOf(c)).replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    if (d.length === 8) d = "968" + d;
    return d;
  };
  const phoneEmail = (p) => `${normPhone(p)}@${C.emailDomain}`;
  const siteUrl = () => location.href.split("#")[0];

  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  function modal(html) {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal glass">${html}</div>`;
    back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("[data-close]")) back.remove(); });
    document.body.appendChild(back);
    return back;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast("تم النسخ ✔"); }
    catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); toast("تم النسخ ✔"); }
  }

  async function callFn(name, body) {
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); msg = j.error || msg; } catch {}
      throw new Error(msg);
    }
    if (data && data.error) throw new Error(data.error);
    return data;
  }

  // Page through results beyond the default 1000-row limit.
  async function fetchAll(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await build().range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  }

  function busy(btn, on) { if (!btn) return; btn.disabled = on; if (on) { btn.dataset.t = btn.textContent; btn.textContent = "لحظة…"; } else if (btn.dataset.t) btn.textContent = btn.dataset.t; }

  /* ---------- data ---------- */
  async function loadMe() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { S.me = null; return; }
    const { data } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
    S.me = data;
  }

  async function loadGroups() {
    const { data } = await sb.from("groups").select("*").order("track").order("name");
    S.groups = data || [];
  }

  const myGroups = () => (isStaff() ? S.groups : S.groups.filter((g) => g.supervisor_id === S.me.id));
  const groupName = (id) => { const g = S.groups.find((x) => x.id === id); return g ? `${g.track} - ${g.name}` : "بلا مجموعة"; };

  async function loadStudents({ includeInactive = false } = {}) {
    let q = () => sb.from("profiles").select("*").eq("is_student", true).order("full_name");
    let rows = await fetchAll(q);
    const allowed = new Set(myGroups().map((g) => g.id));
    if (S.scope) rows = rows.filter((r) => r.group_id === S.scope);
    else if (!isStaff()) rows = rows.filter((r) => allowed.has(r.group_id));
    if (!includeInactive) rows = rows.filter((r) => r.status === "active");
    return rows;
  }

  async function loadMarks(ids, from, to) {
    const reports = new Set();
    const excuses = new Map();
    const reportRows = new Map();
    if (!ids.length) return { reports, excuses, reportRows };
    const chunks = [];
    for (let i = 0; i < ids.length; i += 150) chunks.push(ids.slice(i, i + 150));
    for (const ch of chunks) {
      const rr = await fetchAll(() => sb.from("reports").select("student_id,day,memorized,review,note").in("student_id", ch).gte("day", from).lte("day", to));
      rr.forEach((r) => { reports.add(r.student_id + "|" + r.day); reportRows.set(r.student_id + "|" + r.day, r); });
      const ee = await fetchAll(() => sb.from("excuses").select("student_id,day,status").in("student_id", ch).gte("day", from).lte("day", to));
      ee.forEach((e) => excuses.set(e.student_id + "|" + e.day, e.status));
    }
    return { reports, excuses, reportRows };
  }

  /* ---------- router ---------- */
  window.addEventListener("hashchange", render);
  // Supabase calls inside this callback deadlock the auth lock, so defer the work.
  sb.auth.onAuthStateChange((ev) => {
    if (ev === "SIGNED_OUT") { S.me = null; setTimeout(render, 0); }
  });

  async function render() {
    S.today = R.todayISO(C.timeZone);
    const h = location.hash || "#/";
    if (h.startsWith("#/login")) return renderLogin();
    if (h.startsWith("#/activate")) return renderActivate();
    if (h.startsWith("#/setup")) return renderSetup();
    if (h.startsWith("#/app")) {
      if (!S.me) { location.hash = "#/login"; return; }
      return renderApp();
    }
    return renderLanding();
  }

  function topBar(extra = "") {
    const right = S.me
      ? `<a class="btn small gold" href="#/app">لوحتي</a>`
      : `<a class="btn small ghost" href="#/activate">تفعيل حساب</a><a class="btn small gold" href="#/login">دخول</a>`;
    return `<header class="top glass wrap"><a class="brand" href="#/"><span class="mark">☾</span>برنامج المنير</a><nav>${extra}${right}</nav></header>`;
  }

  /* ---------- landing ---------- */
  async function renderLanding() {
    root.innerHTML = `
      ${topBar()}
      <main class="wrap">
        <section class="hero">
          <h1>برنامج <span>المنير</span></h1>
          <p class="lead">برنامج لحفظ المنظومات العلمية، مثل منظومة أنوار العقول وألفية ابن مالك ومدارج الكمال، يرسل فيه الطالب تقريره اليومي، ويتابعه مشرفه، ويُكرَّم الملتزمون بالقلادات والأوسمة.</p>
          <div class="cta"><a class="btn gold" href="#/login">دخول الطلاب والمشرفين</a><a class="btn" href="#rules">تعرّف على اللوائح</a></div>
          <div id="setupLink"></div>
        </section>

        <section class="section">
          <h2>كيف يسير البرنامج</h2>
          <div class="grid">
            <div class="card glass"><div class="ico">✍🏻</div><h3>تقرير يومي</h3><p>يسجّل الطالب ما حفظه وما راجعه كل يوم من الأحد إلى الخميس، والجمعة والسبت للمراجعة.</p></div>
            <div class="card glass"><div class="ico">📿</div><h3>قلادة أسبوعية</h3><p>تُحسب القلادة تلقائيًا في نهاية كل أسبوع بحسب عدد أيام الالتزام.</p></div>
            <div class="card glass"><div class="ico">🏅</div><h3>وسام شهري</h3><p>تُجمع نقاط القلادات في نهاية الشهر، ويُكرَّم الطلاب في الملتقى بحسب مجموعها.</p></div>
            <div class="card glass"><div class="ico">🤝</div><h3>متابعة لا تنقطع</h3><p>لكل مجموعة مشرف يتابع طلابه، والإدارة تتواصل مع من يحتاج إلى عون.</p></div>
          </div>
        </section>

        <section class="section" id="rules">
          <h2>اللوائح</h2>
          <div class="grid">
            <div class="card glass"><h3>المكافآت 🎖️</h3><div class="legend">
              <div><span>الالتزام ٥ أيام في الأسبوع</span><b>🥇 ذهبية · ٣ نقاط</b></div>
              <div><span>الالتزام ٤ أيام</span><b>🥈 فضية · نقطتان</b></div>
              <div><span>الالتزام ٣ أيام</span><b>🥉 برونزية · نقطة</b></div>
            </div></div>
            <div class="card glass"><h3>الأوسمة الشهرية 🏆</h3><div class="legend">
              <div><span>١٠ إلى ١٢ نقطة</span><b>🏆 وسام التميّز</b></div>
              <div><span>٧ إلى ٩ نقاط</span><b>🌟 وسام الاجتهاد</b></div>
              <div><span>٤ إلى ٦ نقاط</span><b>💫 وسام الالتزام</b></div>
            </div><p class="muted" style="margin-top:10px">تُحتسب أول أربعة أسابيع من كل شهر.</p></div>
            <div class="card glass"><h3>العقوبات ⛔</h3><div class="legend">
              <div><span>يومان فقط في الأسبوع</span><b>⭕ تنبيه</b></div>
              <div><span>يوم واحد أو لا شيء</span><b>⚠️ إنذار</b></div>
              <div><span>⭕⭕⭕ أو ⚠️ في الشهر</span><b>تنبيه على الخاص</b></div>
              <div><span>⚠️⚠️ في الشهر</span><b>تواصل من الإدارة</b></div>
              <div><span>⚠️⚠️⚠️ في الشهر</span><b>طرد</b></div>
            </div><p class="muted" style="margin-top:10px">تُصفَّر التنبيهات والإنذارات مع بداية كل شهر.</p></div>
            <div class="card glass"><h3>الأعذار 📝</h3>
              <p>يُقبل العذر إذا طرأ على الطالب ظرف يمنعه من إرسال التقرير، كالمرض والسفر والاختبارات والظروف العائلية وظروف العمل.</p>
              <p>يُبلغ الطالب بعذره في اليوم نفسه، أو فور تمكّنه إن تعذّر ذلك.</p>
              <p class="muted">يوم العذر المقبول لا يُحتسب تقصيرًا، ولا يُحتسب يوم التزام عند تحديد القلادة.</p>
            </div>
          </div>
        </section>

        <section class="section">
          <div class="glass quote">وإنَّ كتابَ اللهِ أوثقُ شافعٍ ** وأغنى غَناءٍ واهبًا متفضِّلا<small>الإمام الشاطبي</small></div>
        </section>

        <section class="section">
          <h2>المجموعات</h2>
          <div class="grid">
            <div class="card glass" style="text-align:center"><h3>الأنوار</h3></div>
            <div class="card glass" style="text-align:center"><h3>الألفية</h3></div>
            <div class="card glass" style="text-align:center"><h3>المدارج</h3></div>
          </div>
        </section>
      </main>
      <footer class="foot wrap">© ${R.ar(S.today.slice(0, 4))} برنامج المنير</footer>`;
    try {
      const st = await callFn("activate", { action: "status" });
      if (st.needsSetup) document.getElementById("setupLink").innerHTML = `<p style="margin-top:18px"><a class="btn small" href="#/setup">إعداد حساب المدير لأول مرة</a></p>`;
    } catch {}
  }

  /* ---------- auth pages ---------- */
  function authShell(title, sub, form) {
    root.innerHTML = `${topBar()}<main class="wrap"><div class="auth glass"><h2>${title}</h2><p class="muted">${sub}</p><div id="authMsg"></div>${form}</div></main>`;
  }
  const authMsg = (t, ok) => (document.getElementById("authMsg").innerHTML = `<div class="msg ${ok ? "ok" : "err"}">${esc(t)}</div>`);

  function renderLogin() {
    if (S.me) { location.hash = "#/app"; return; }
    authShell("تسجيل الدخول", "برقم الهاتف وكلمة المرور", `
      <form id="f">
        <div class="field"><label>رقم الهاتف</label><input name="phone" inputmode="tel" autocomplete="username" placeholder="9XXXXXXX" required></div>
        <div class="field"><label>كلمة المرور</label><input name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn gold" style="width:100%">دخول</button>
      </form>
      <p class="muted" style="margin-top:16px">أول مرة؟ <a href="#/activate">فعّل حسابك برمز من مشرفك</a></p>`);
    document.getElementById("f").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target), btn = e.target.querySelector("button");
      busy(btn, true);
      const { error } = await sb.auth.signInWithPassword({ email: phoneEmail(fd.get("phone")), password: fd.get("password") });
      busy(btn, false);
      if (error) return authMsg("رقم الهاتف أو كلمة المرور غير صحيحة");
      await loadMe();
      location.hash = "#/app";
    };
  }

  function renderActivate() {
    authShell("تفعيل الحساب", "أدخل رقمك ورمز التفعيل الذي أرسله لك مشرفك، ثم اختر كلمة المرور", `
      <form id="f">
        <div class="field"><label>رقم الهاتف</label><input name="phone" inputmode="tel" required></div>
        <div class="field"><label>رمز التفعيل</label><input name="code" inputmode="numeric" maxlength="6" required></div>
        <div class="field"><label>كلمة المرور الجديدة</label><input name="password" type="password" minlength="6" autocomplete="new-password" required></div>
        <button class="btn gold" style="width:100%">تفعيل والدخول</button>
      </form>`);
    document.getElementById("f").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target), btn = e.target.querySelector("button");
      busy(btn, true);
      try {
        await callFn("activate", { action: "activate", phone: fd.get("phone"), code: fd.get("code"), password: fd.get("password") });
        const { error } = await sb.auth.signInWithPassword({ email: phoneEmail(fd.get("phone")), password: fd.get("password") });
        if (error) throw error;
        await loadMe();
        location.hash = "#/app";
      } catch (err) { authMsg(err.message); }
      busy(btn, false);
    };
  }

  function renderSetup() {
    authShell("إعداد حساب المدير", "يظهر هذا مرة واحدة فقط قبل إنشاء أول مدير", `
      <form id="f">
        <div class="field"><label>الاسم</label><input name="full_name" required></div>
        <div class="field"><label>رقم الهاتف</label><input name="phone" inputmode="tel" required></div>
        <div class="field"><label>كلمة المرور</label><input name="password" type="password" minlength="6" required></div>
        <button class="btn gold" style="width:100%">إنشاء الحساب</button>
      </form>`);
    document.getElementById("f").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target), btn = e.target.querySelector("button");
      busy(btn, true);
      try {
        await callFn("activate", { action: "bootstrap", full_name: fd.get("full_name"), phone: fd.get("phone"), password: fd.get("password") });
        await sb.auth.signInWithPassword({ email: phoneEmail(fd.get("phone")), password: fd.get("password") });
        await loadMe();
        location.hash = "#/app";
      } catch (err) { authMsg(err.message); }
      busy(btn, false);
    };
  }

  /* ---------- app shell ---------- */
  function tabsFor() {
    const t = [];
    if (S.me.role === "student") return [["mine", "تقريري"], ["history", "سجلّي"], ["myexcuses", "أعذاري"]];
    t.push(["follow", "المتابعة"], ["excuses", "الأعذار"], ["reports", "التقارير"], ["actions", "الإجراءات"], ["students", "الطلاب"]);
    if (S.me.is_student) t.push(["mine", "تقريري"], ["history", "سجلّي"], ["myexcuses", "أعذاري"]);
    if (isStaff()) t.push(["admin", "الإدارة"]);
    return t;
  }

  async function renderApp() {
    await loadGroups();
    const tabs = tabsFor();
    if (!S.tab || !tabs.find((t) => t[0] === S.tab)) S.tab = tabs[0][0];
    if (S.scope && !myGroups().find((g) => g.id === S.scope)) S.scope = "";
    if (!isStaff() && !S.scope && myGroups().length === 1) S.scope = myGroups()[0].id;
    root.innerHTML = `
      ${topBar(`<button class="btn small ghost" id="logout">خروج</button>`)}
      <main class="wrap app">
        <div class="hello"><div><p class="muted" style="margin:0">${R.DAY_NAMES[R.dow(S.today)]} ${R.fmtDay(S.today)}</p><h2>أهلًا، ${esc(S.me.full_name.split(" ")[0])}</h2></div><span class="badge gold">${ROLE_NAMES[S.me.role]}</span></div>
        <nav class="tabs glass">${tabs.map(([k, n]) => `<button class="tab ${k === S.tab ? "on" : ""}" data-tab="${k}">${n}</button>`).join("")}</nav>
        <div id="view"><div class="empty">جارٍ التحميل…</div></div>
      </main>`;
    document.getElementById("logout").onclick = async () => { S.me = null; S.tab = null; await sb.auth.signOut({ scope: "local" }); location.hash = "#/"; render(); };
    root.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; renderApp(); }));
    const view = document.getElementById("view");
    if (S.me.status !== "active" && S.me.role === "student") { view.innerHTML = `<div class="panel glass empty">حسابك ${STATUS_NAMES[S.me.status]} في البرنامج. للاستفسار تواصل مع الإدارة.</div>`; return; }
    try { await VIEWS[S.tab](view); }
    catch (err) { console.error(err); view.innerHTML = `<div class="panel glass"><div class="msg err">حدث خطأ: ${esc(err.message)}</div></div>`; }
  }

  function scopeSelect(allowAll = true) {
    const gs = myGroups();
    const opts = (isStaff() && allowAll ? [`<option value="">كل المجموعات</option>`] : []).concat(gs.map((g) => `<option value="${g.id}" ${g.id === S.scope ? "selected" : ""}>${esc(g.track)} - ${esc(g.name)}</option>`));
    if (!gs.length) return `<span class="muted">لا توجد مجموعات بعد</span>`;
    return `<select id="scope">${opts.join("")}</select>`;
  }
  function bindScope(rerender) { const s = document.getElementById("scope"); if (s) s.onchange = () => { S.scope = s.value; rerender(); }; }

  const VIEWS = {};

  /* ---------- follow-up grid ---------- */
  VIEWS.follow = async (view) => {
    if (!S.weekSun) S.weekSun = R.weekStart(S.today);
    const days = R.weekDays(S.weekSun);
    const students = await loadStudents();
    const data = await loadMarks(students.map((s) => s.id), days[0], days[4]);
    const todayIsWork = R.dow(S.today) <= 4;
    const submittedToday = students.filter((s) => data.reports.has(s.id + "|" + S.today)).length;
    const { count: pendingEx } = await sb.from("excuses").select("id", { count: "exact", head: true }).eq("status", "pending");
    const rows = students.map((st) => ({ st, w: R.weekResult(st, S.weekSun, data, S.today) }))
      .sort((a, b) => (b.w?.ok ?? -1) - (a.w?.ok ?? -1) || a.st.full_name.localeCompare(b.st.full_name, "ar"));
    view.innerHTML = `
      <div class="stats">
        <div class="stat glass"><b>${R.ar(students.length)}</b><span>طالبًا نشطًا</span></div>
        <div class="stat glass"><b>${todayIsWork ? R.ar(submittedToday) : "—"}</b><span>${todayIsWork ? "أرسلوا تقرير اليوم" : "اليوم يوم مراجعة"}</span></div>
        <div class="stat glass"><b>${R.ar(pendingEx || 0)}</b><span>عذر بانتظار القرار</span></div>
      </div>
      <div class="panel glass">
        <div class="toolbar">${scopeSelect()}
          <button class="btn small" id="prev">→ الأسبوع السابق</button>
          <span class="badge">${R.fmtShort(days[0])} - ${R.fmtShort(days[4])}</span>
          <button class="btn small" id="next" ${S.weekSun >= R.weekStart(S.today) ? "disabled" : ""}>الأسبوع التالي ←</button>
        </div>
        <p class="muted">اضغط على خانة اليوم لتغييرها: ✅ ثم 📝 ثم ❌. الخانات المستقبلية لا تُعدَّل.</p>
        ${students.length ? `<div class="scroll"><table class="gridtable"><thead><tr><th>الطالب</th>${days.map((d) => `<th>${R.DAY_NAMES[R.dow(d)]}<br>${R.fmtShort(d)}</th>`).join("")}<th>النتيجة</th></tr></thead><tbody>
          ${rows.map(({ st, w }) => `<tr><td>${esc(st.full_name)}</td>${days.map((d, i) => {
            const m = w ? w.marks[i] : "off";
            const rep = data.reportRows.get(st.id + "|" + d);
            const tip = rep ? [rep.memorized && "الحفظ: " + rep.memorized, rep.review && "المراجعة: " + rep.review, rep.note].filter(Boolean).join(" · ") : "";
            const dis = m === "off" || d > S.today;
            return `<td><button class="cell ${m === "pend" ? "wait" : m} ${dis ? "off" : ""}" ${dis ? "disabled" : ""} data-cell="${st.id}|${d}|${m}" title="${esc(tip)}">${R.MARK_SYM[m]}</button></td>`;
          }).join("")}<td>${w ? (w.final ? `<span class="badge">${w.necklace.sym}<span class="nk-name"> ${w.necklace.name}</span></span>` : `<span class="muted">${R.ar(w.ok)}/٥</span>`) : "—"}</td></tr>`).join("")}
        </tbody></table></div>` : `<div class="empty">لا يوجد طلاب في هذه المجموعة بعد. أضفهم من تبويب «الطلاب».</div>`}
      </div>`;
    bindScope(() => renderApp());
    document.getElementById("prev").onclick = () => { S.weekSun = R.addDays(S.weekSun, -7); renderApp(); };
    document.getElementById("next").onclick = () => { S.weekSun = R.addDays(S.weekSun, 7); renderApp(); };
    view.querySelectorAll("[data-cell]").forEach((b) => (b.onclick = async () => {
      const [sid, day, m] = b.dataset.cell.split("|");
      b.disabled = true;
      try {
        if (m === "ok") {
          await sb.from("reports").delete().eq("student_id", sid).eq("day", day);
          const { error } = await sb.from("excuses").upsert({ student_id: sid, day, status: "accepted", category: "سجّله المشرف", decided_by: S.me.id }, { onConflict: "student_id,day" });
          if (error) throw error;
        } else if (m === "ex") {
          const { error } = await sb.from("excuses").delete().eq("student_id", sid).eq("day", day);
          if (error) throw error;
        } else {
          const { error } = await sb.from("reports").upsert({ student_id: sid, day, note: "سجّله المشرف" }, { onConflict: "student_id,day" });
          if (error) throw error;
          await sb.from("excuses").delete().eq("student_id", sid).eq("day", day);
        }
        renderApp();
      } catch (err) { toast("تعذّر الحفظ: " + err.message); b.disabled = false; }
    }));
  };

  /* ---------- excuses (managers) ---------- */
  VIEWS.excuses = async (view) => {
    const students = await loadStudents();
    const byId = new Map(students.map((s) => [s.id, s]));
    const ids = students.map((s) => s.id);
    const from = R.addDays(S.today, -45);
    const rows = ids.length ? (await fetchAll(() => sb.from("excuses").select("*").in("student_id", ids.slice(0, 300)).gte("day", from).order("day", { ascending: false }))) : [];
    const pending = rows.filter((r) => r.status === "pending");
    const decided = rows.filter((r) => r.status !== "pending").slice(0, 40);
    const counts = {};
    rows.filter((r) => r.status === "accepted" && r.day.slice(0, 7) === S.today.slice(0, 7)).forEach((r) => (counts[r.student_id] = (counts[r.student_id] || 0) + 1));
    const item = (r) => `<div class="item"><div><b>${esc(byId.get(r.student_id)?.full_name || "")}</b> <span class="badge ${r.status === "accepted" ? "green" : r.status === "rejected" ? "red" : "blue"}">${{ pending: "بانتظار القرار", accepted: "مقبول", rejected: "مرفوض" }[r.status]}</span>
      <div class="meta">${R.DAY_NAMES[R.dow(r.day)]} ${R.fmtDay(r.day)} · ${esc(r.category || "")}${r.reason ? " · " + esc(r.reason) : ""} · أعذار هذا الشهر: ${R.ar(counts[r.student_id] || 0)}</div></div>
      <div class="acts">${r.status !== "accepted" ? `<button class="btn small gold" data-ex="${r.id}|accepted">قبول</button>` : ""}${r.status !== "rejected" ? `<button class="btn small danger" data-ex="${r.id}|rejected">رفض</button>` : ""}</div></div>`;
    view.innerHTML = `
      <div class="panel glass"><div class="toolbar">${scopeSelect()}</div>
        <h3>بانتظار القرار</h3><div class="list">${pending.length ? pending.map(item).join("") : `<div class="empty">لا توجد أعذار معلّقة</div>`}</div></div>
      <div class="panel glass"><h3>تسجيل عذر لطالب</h3>
        <form id="exf" class="row">
          <div><label>الطالب</label><select name="sid" required>${students.map((s) => `<option value="${s.id}">${esc(s.full_name)}</option>`).join("")}</select></div>
          <div><label>من يوم</label><input type="date" name="from" value="${S.today}" required></div>
          <div><label>إلى يوم</label><input type="date" name="to" value="${S.today}" required></div>
          <div><label>نوع العذر</label><select name="cat">${EXCUSE_TYPES.map((t) => `<option>${t}</option>`).join("")}</select></div>
          <div><label>ملاحظة</label><input name="reason"></div>
          <button class="btn gold">حفظ العذر</button>
        </form></div>
      <div class="panel glass"><h3>آخر القرارات</h3><div class="list">${decided.length ? decided.map(item).join("") : `<div class="empty">لا شيء بعد</div>`}</div></div>`;
    bindScope(() => renderApp());
    view.querySelectorAll("[data-ex]").forEach((b) => (b.onclick = async () => {
      const [id, status] = b.dataset.ex.split("|");
      const { error } = await sb.from("excuses").update({ status, decided_by: S.me.id }).eq("id", id);
      if (error) return toast(error.message);
      renderApp();
    }));
    document.getElementById("exf").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const days = [];
      for (let d = fd.get("from"); d <= fd.get("to") && days.length < 60; d = R.addDays(d, 1)) if (R.dow(d) <= 4) days.push(d);
      if (!days.length) return toast("لا توجد أيام عمل في هذه المدة");
      const rows = days.map((day) => ({ student_id: fd.get("sid"), day, category: fd.get("cat"), reason: fd.get("reason"), status: "accepted", decided_by: S.me.id }));
      const { error } = await sb.from("excuses").upsert(rows, { onConflict: "student_id,day" });
      if (error) return toast(error.message);
      toast(`سُجّل العذر لـ ${R.ar(days.length)} يوم`);
      renderApp();
    };
  };

  /* ---------- WhatsApp reports ---------- */
  function rankRows(students, fn) { return students.map((st) => ({ st, r: fn(st) })).filter((x) => x.r); }

  function dailyText(students, data, day, title) {
    const sun = R.weekStart(day);
    const days = R.weekDays(sun).filter((d) => d <= day);
    const rows = rankRows(students, (st) => {
      if (st.start_date > day) return null;
      const marks = days.map((d) => R.dayMark(st, d, data, S.today));
      return { marks, ok: marks.filter((m) => m === "ok").length };
    }).sort((a, b) => b.r.ok - a.r.ok || a.st.full_name.localeCompare(b.st.full_name, "ar"));
    let t = `*✍🏻الـتَّـقْـرِيـرُ الإِدَارِيُّ الـيَـوْمِـيُّ✍🏻*\n *[${R.DAY_NAMES[R.dow(day)]} - ${R.fmtDay(day)}]*\n`;
    if (title) t += ` *${title}*\n`;
    t += "\n";
    rows.forEach(({ st, r }, i) => { t += `${R.ar(i + 1)}. ${st.full_name}\n       ${r.marks.map((m) => R.MARK_SYM[m]).join("")}\n`; });
    return t.trim();
  }

  function weeklyText(students, data, sun, title) {
    const ym = R.weekMonth(sun);
    const idx = R.monthWeeks(ym).indexOf(sun) + 1;
    const days = R.weekDays(sun);
    const rows = rankRows(students, (st) => R.weekResult(st, sun, data, S.today)).sort((a, b) => b.r.ok - a.r.ok || a.st.full_name.localeCompare(b.st.full_name, "ar"));
    let t = `*📄الـتَّـقْـرِيـرُ الإِدَارِيُّ الأُسْـبُـوعِـيُّ (${R.ar(idx)})📄*\n *[${R.fmtShort(days[0])} - ${R.fmtDay(days[4])}]*\n`;
    if (title) t += ` *${title}*\n`;
    t += "\n";
    rows.forEach(({ st, r }) => { t += `- ${st.full_name}\n     ${r.final ? r.necklace.sym : r.marks.map((m) => R.MARK_SYM[m]).join("")}\n`; });
    if (rows.some((x) => !x.r.final)) t += `\n_(الأسبوع لم يكتمل بعد)_`;
    return t.trim();
  }

  function monthlyText(students, data, ym, title) {
    const rows = rankRows(students, (st) => { const m = R.monthSummary(st, ym, data, S.today); return m.weeks.length ? m : null; })
      .sort((a, b) => b.r.points - a.r.points || a.st.full_name.localeCompare(b.st.full_name, "ar"));
    let t = `*🏅الـتَّـقْـرِيـرُ الـشَّـهْـرِيُّ - ${R.monthName(ym)}🏅*\n`;
    if (title) t += ` *${title}*\n`;
    t += "\n";
    rows.forEach(({ st, r }, i) => {
      const counted = R.monthWeeks(ym).slice(0, 4);
      const syms = r.finals.filter((w) => counted.includes(w.sun)).map((w) => w.necklace.sym).join("");
      t += `${R.ar(i + 1)}. ${st.full_name}\n     ${syms || "—"} = ${R.ar(r.points)} ${r.points === 1 ? "نقطة" : "نقاط"}${r.medal ? ` ${r.medal.sym} ${r.medal.name}` : ""}\n`;
    });
    return t.trim();
  }

  VIEWS.reports = async (view) => {
    const kind = S.reportKind || "daily";
    const weeksBack = Array.from({ length: 10 }, (_, i) => R.addDays(R.weekStart(S.today), -7 * i));
    view.innerHTML = `
      <div class="panel glass">
        <div class="toolbar">
          <select id="kind"><option value="daily">تقرير يومي</option><option value="weekly">تقرير أسبوعي</option><option value="monthly">تقرير شهري</option></select>
          ${scopeSelect()}
          <span id="picker"></span>
        </div>
        <div class="wa" id="out">جارٍ التحضير…</div>
        <div class="toolbar" style="margin-top:12px">
          <button class="btn gold" id="copy">نسخ التقرير</button>
          <button class="btn" id="wa">فتح في واتساب</button>
        </div>
      </div>`;
    const kindSel = document.getElementById("kind");
    kindSel.value = kind;
    const picker = document.getElementById("picker");
    const lastWork = (() => { let d = S.today; while (R.dow(d) > 4) d = R.addDays(d, -1); return d; })();
    if (kind === "daily") picker.innerHTML = `<input type="date" id="pick" value="${S.reportDay || lastWork}" max="${S.today}">`;
    if (kind === "weekly") picker.innerHTML = `<select id="pick">${weeksBack.map((s) => `<option value="${s}" ${s === S.reportWeek ? "selected" : ""}>${R.fmtShort(s)} - ${R.fmtShort(R.addDays(s, 4))}</option>`).join("")}</select>`;
    if (kind === "monthly") picker.innerHTML = `<input type="month" id="pick" value="${S.reportMonth || S.today.slice(0, 7)}" max="${S.today.slice(0, 7)}">`;
    kindSel.onchange = () => { S.reportKind = kindSel.value; renderApp(); };
    bindScope(() => renderApp());
    const pick = document.getElementById("pick");
    let text = "";
    const build = async () => {
      document.getElementById("out").textContent = "جارٍ التحضير…";
      const students = await loadStudents();
      const g = S.scope ? S.groups.find((x) => x.id === S.scope) : null;
      const title = g ? `مجموعة ${g.track} - ${g.name}` : "";
      const ids = students.map((s) => s.id);
      if (kind === "daily") {
        S.reportDay = pick.value;
        const data = await loadMarks(ids, R.weekStart(pick.value), pick.value);
        text = dailyText(students, data, pick.value, title);
      } else if (kind === "weekly") {
        S.reportWeek = pick.value;
        const data = await loadMarks(ids, pick.value, R.addDays(pick.value, 4));
        text = weeklyText(students, data, pick.value, title);
      } else {
        S.reportMonth = pick.value;
        const ws = R.monthWeeks(pick.value);
        const data = await loadMarks(ids, ws[0], R.addDays(ws[ws.length - 1], 4));
        text = monthlyText(students, data, pick.value, title);
      }
      document.getElementById("out").textContent = students.length ? text : "لا يوجد طلاب في هذا النطاق.";
    };
    pick.onchange = build;
    document.getElementById("copy").onclick = () => copyText(text);
    document.getElementById("wa").onclick = () => window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank");
    await build();
  };

  /* ---------- penalty actions ---------- */
  VIEWS.actions = async (view) => {
    const ym = S.month || S.today.slice(0, 7);
    const students = await loadStudents();
    const ws = R.monthWeeks(ym);
    const data = await loadMarks(students.map((s) => s.id), ws[0], R.addDays(ws[ws.length - 1], 4));
    const { data: recs } = await sb.from("actions").select("*").eq("month", ym);
    const recMap = new Map((recs || []).map((r) => [r.student_id + "|" + r.kind, r]));
    const list = students.map((st) => ({ st, m: R.monthSummary(st, ym, data, S.today) })).filter((x) => x.m.action)
      .sort((a, b) => R.ACTIONS[b.m.action].rank - R.ACTIONS[a.m.action].rank);
    const stBadge = (r) => !r ? `<span class="badge blue">لم يُنفّذ</span>` : { done: `<span class="badge green">تم</span>`, no_reply: `<span class="badge red">لم يرد</span>`, cancelled: `<span class="badge">أُلغي</span>`, pending: `<span class="badge blue">لم يُنفّذ</span>` }[r.status];
    view.innerHTML = `
      <div class="panel glass">
        <div class="toolbar">${scopeSelect()}<input type="month" id="ym" value="${ym}" max="${S.today.slice(0, 7)}"></div>
        <p class="muted">تُحسب من القلادات المكتملة في ${R.monthName(ym)}، وتُصفَّر مع بداية الشهر التالي. الطرد لا يُنفَّذ إلا باعتماد المدير أو المساعد.</p>
        <div class="list">${list.length ? list.map(({ st, m }) => {
          const kind = m.action;
          const rec = recMap.get(st.id + "|" + kind);
          const expelReady = kind === "expel" || (kind === "contact" && rec?.status === "no_reply");
          return `<div class="item"><div><b>${esc(st.full_name)}</b> <span class="badge ${kind === "notice" ? "gold" : "red"}">${R.ACTIONS[kind].name}</span> ${stBadge(rec)}
            <div class="meta">⭕ ${R.ar(m.notices)} · ⚠️ ${R.ar(m.warnings)} · ${esc(groupName(st.group_id))}</div></div>
            <div class="acts">
              ${kind !== "expel" ? `<button class="btn small" data-act="${st.id}|${kind}|done">${kind === "notice" ? "تم التنبيه" : "تم التواصل"}</button>` : ""}
              ${kind === "contact" ? `<button class="btn small danger" data-act="${st.id}|${kind}|no_reply">لم يرد</button>` : ""}
              ${expelReady && isStaff() ? `<button class="btn small danger" data-expel="${st.id}|${kind}">اعتماد الطرد</button>` : ""}
              ${expelReady && !isStaff() ? `<span class="muted">بانتظار اعتماد الإدارة</span>` : ""}
              <button class="btn small ghost" data-act="${st.id}|${kind}|cancelled">إلغاء</button>
            </div></div>`;
        }).join("") : `<div class="empty">لا توجد إجراءات مطلوبة في هذا الشهر 🌿</div>`}</div>
      </div>`;
    bindScope(() => renderApp());
    document.getElementById("ym").onchange = (e) => { S.month = e.target.value; renderApp(); };
    view.querySelectorAll("[data-act]").forEach((b) => (b.onclick = async () => {
      const [sid, kind, status] = b.dataset.act.split("|");
      const { error } = await sb.from("actions").upsert({ student_id: sid, month: ym, kind, status, updated_by: S.me.id, updated_at: new Date().toISOString() }, { onConflict: "student_id,month,kind" });
      if (error) return toast(error.message);
      renderApp();
    }));
    view.querySelectorAll("[data-expel]").forEach((b) => (b.onclick = async () => {
      const [sid, kind] = b.dataset.expel.split("|");
      if (!confirm("اعتماد طرد هذا الطالب من البرنامج؟")) return;
      const { error } = await sb.from("profiles").update({ status: "expelled" }).eq("id", sid);
      if (error) return toast(error.message);
      await sb.from("actions").upsert({ student_id: sid, month: ym, kind: "expel", status: "done", updated_by: S.me.id, updated_at: new Date().toISOString() }, { onConflict: "student_id,month,kind" });
      toast("تم اعتماد الطرد");
      renderApp();
    }));
  };

  /* ---------- students management ---------- */
  function activationMessage(name, phone, code) {
    return `السلام عليكم ورحمة الله ${name}\nحيّاك الله في برنامج المنير 🌙\n\nلتفعيل حسابك افتح الرابط:\n${siteUrl()}#/activate\n\nرقم الهاتف: ${phone}\nرمز التفعيل: ${code}\n\nثم اختر كلمة المرور التي تريدها.`;
  }
  function showCode(name, phone, code) {
    const msg = activationMessage(name, phone, code);
    const m = modal(`<h3>رمز التفعيل</h3><p>أرسل هذه الرسالة إلى <b>${esc(name)}</b>، وبها يختار كلمة المرور بنفسه.</p><div class="wa" style="min-height:0">${esc(msg)}</div>
      <div class="toolbar" style="margin-top:12px"><button class="btn gold" id="cpy">نسخ الرسالة</button><a class="btn" target="_blank" href="https://wa.me/${phone}?text=${encodeURIComponent(msg)}">إرسال بواتساب</a><button class="btn ghost" data-close>إغلاق</button></div>`);
    m.querySelector("#cpy").onclick = () => copyText(msg);
  }

  VIEWS.students = async (view) => {
    const students = await loadStudents({ includeInactive: true });
    const gs = myGroups();
    view.innerHTML = `
      <div class="panel glass"><h3>إضافة طالب</h3>
        ${gs.length ? `<form id="addf" class="row">
          <div><label>الاسم الكامل</label><input name="full_name" required></div>
          <div><label>رقم الهاتف</label><input name="phone" inputmode="tel" required></div>
          <div><label>المجموعة</label><select name="group_id">${gs.map((g) => `<option value="${g.id}" ${g.id === S.scope ? "selected" : ""}>${esc(g.track)} - ${esc(g.name)}</option>`).join("")}</select></div>
          <div><label>تاريخ البدء</label><input type="date" name="start_date" value="${S.today}"></div>
          <button class="btn gold">إضافة</button>
        </form>` : `<div class="empty">لا توجد مجموعة مسندة إليك بعد. ${isStaff() ? "أنشئ مجموعة من تبويب «الإدارة»." : "تواصل مع الإدارة."}</div>`}
      </div>
      <div class="panel glass"><div class="toolbar">${scopeSelect()}<input id="q" placeholder="بحث بالاسم"></div>
        <div class="list" id="lst">${students.length ? students.map((s) => `<div class="item" data-name="${esc(s.full_name)}"><div><b>${esc(s.full_name)}</b>
          ${s.status !== "active" ? `<span class="badge red">${STATUS_NAMES[s.status]}</span>` : ""} ${s.activated ? `<span class="badge green">مفعّل</span>` : `<span class="badge blue">لم يفعّل</span>`}
          <div class="meta">${esc(s.phone)} · ${esc(groupName(s.group_id))} · بدأ ${R.fmtDay(s.start_date)}</div></div>
          <div class="acts"><button class="btn small" data-code="${s.id}">رمز تفعيل جديد</button><button class="btn small ghost" data-edit="${s.id}">تعديل</button></div></div>`).join("") : `<div class="empty">لا يوجد طلاب بعد</div>`}</div></div>`;
    bindScope(() => renderApp());
    document.getElementById("q").oninput = (e) => view.querySelectorAll("#lst .item").forEach((it) => it.classList.toggle("hide", !it.dataset.name.includes(e.target.value.trim())));
    const f = document.getElementById("addf");
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(f), btn = f.querySelector("button");
      busy(btn, true);
      try {
        const r = await callFn("admin-users", { action: "create", role: "student", full_name: fd.get("full_name"), phone: fd.get("phone"), group_id: fd.get("group_id"), start_date: fd.get("start_date") });
        showCode(fd.get("full_name"), r.phone, r.code);
        f.reset();
        VIEWS.students(view);
      } catch (err) { toast(err.message); }
      busy(btn, false);
    };
    view.querySelectorAll("[data-code]").forEach((b) => (b.onclick = async () => {
      const s = students.find((x) => x.id === b.dataset.code);
      if (s.activated && !confirm("الطالب مفعّل. الرمز الجديد يتيح له اختيار كلمة مرور جديدة. متابعة؟")) return;
      try { const r = await callFn("admin-users", { action: "reset_code", user_id: s.id }); showCode(s.full_name, s.phone, r.code); }
      catch (err) { toast(err.message); }
    }));
    view.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => editPerson(students.find((x) => x.id === b.dataset.edit))));
  };

  function editPerson(p) {
    const gs = myGroups();
    const m = modal(`<h3>تعديل ${esc(p.full_name)}</h3>
      <form id="ef">
        <div class="field"><label>الاسم الكامل</label><input name="full_name" value="${esc(p.full_name)}" required></div>
        ${p.is_student ? `<div class="field"><label>المجموعة</label><select name="group_id">${gs.map((g) => `<option value="${g.id}" ${g.id === p.group_id ? "selected" : ""}>${esc(g.track)} - ${esc(g.name)}</option>`).join("")}</select></div>
        <div class="field"><label>تاريخ البدء</label><input type="date" name="start_date" value="${p.start_date}"></div>` : ""}
        <div class="field"><label>الحالة</label><select name="status">${Object.entries(STATUS_NAMES).map(([k, v]) => `<option value="${k}" ${k === p.status ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        <div class="toolbar"><button class="btn gold">حفظ</button><button type="button" class="btn ghost" data-close>إلغاء</button>
        ${isStaff() && p.id !== S.me.id ? `<button type="button" class="btn danger" id="del">حذف نهائي</button>` : ""}</div>
      </form>`);
    m.querySelector("#ef").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const upd = { full_name: fd.get("full_name"), status: fd.get("status") };
      if (p.is_student) { upd.group_id = fd.get("group_id") || null; upd.start_date = fd.get("start_date"); }
      const { error } = await sb.from("profiles").update(upd).eq("id", p.id);
      if (error) return toast(error.message);
      m.remove(); toast("تم الحفظ"); renderApp();
    };
    const del = m.querySelector("#del");
    if (del) del.onclick = async () => {
      if (!confirm(`حذف ${p.full_name} وكل سجلّه نهائيًا؟ لا يمكن التراجع.`)) return;
      try { await callFn("admin-users", { action: "delete", user_id: p.id }); m.remove(); toast("تم الحذف"); renderApp(); }
      catch (err) { toast(err.message); }
    };
  }

  /* ---------- admin: groups and staff ---------- */
  VIEWS.admin = async (view) => {
    const { data: staff } = await sb.from("profiles").select("*").neq("role", "student").order("full_name");
    const sup = staff || [];
    view.innerHTML = `
      <div class="panel glass"><h3>المجموعات</h3>
        <form id="gf" class="row">
          <div><label>المسار</label><select name="track">${TRACKS.map((t) => `<option>${t}</option>`).join("")}</select></div>
          <div><label>اسم المجموعة</label><input name="name" placeholder="مثلًا: مجموعة حذيفة" required></div>
          <div><label>المشرف</label><select name="supervisor_id"><option value="">—</option>${sup.map((p) => `<option value="${p.id}">${esc(p.full_name)}</option>`).join("")}</select></div>
          <button class="btn gold">إضافة مجموعة</button>
        </form>
        <div class="list" style="margin-top:14px">${S.groups.length ? S.groups.map((g) => `<div class="item"><div><b>${esc(g.track)} - ${esc(g.name)}</b><div class="meta">المشرف: ${esc(sup.find((p) => p.id === g.supervisor_id)?.full_name || "لم يُحدَّد")}</div></div>
          <div class="acts"><select data-gsup="${g.id}" style="width:auto"><option value="">تغيير المشرف…</option>${sup.map((p) => `<option value="${p.id}">${esc(p.full_name)}</option>`).join("")}</select><button class="btn small danger" data-gdel="${g.id}">حذف</button></div></div>`).join("") : `<div class="empty">لا توجد مجموعات بعد</div>`}</div>
      </div>
      <div class="panel glass"><h3>المشرفون والمساعدون</h3>
        <form id="pf" class="row">
          <div><label>الاسم الكامل</label><input name="full_name" required></div>
          <div><label>رقم الهاتف</label><input name="phone" inputmode="tel" required></div>
          <div><label>الدور</label><select name="role"><option value="supervisor">مشرف</option><option value="assistant">مساعد</option><option value="admin">مدير</option></select></div>
          <div><label>هل هو طالب أيضًا؟</label><select name="is_student"><option value="">لا</option><option value="1">نعم</option></select></div>
          <div><label>مجموعته كطالب</label><select name="group_id"><option value="">—</option>${S.groups.map((g) => `<option value="${g.id}">${esc(g.track)} - ${esc(g.name)}</option>`).join("")}</select></div>
          <button class="btn gold">إضافة</button>
        </form>
        <div class="list" style="margin-top:14px">${sup.map((p) => `<div class="item"><div><b>${esc(p.full_name)}</b> <span class="badge gold">${ROLE_NAMES[p.role]}</span> ${p.is_student ? `<span class="badge">طالب أيضًا</span>` : ""} ${p.activated ? "" : `<span class="badge blue">لم يفعّل</span>`}
          <div class="meta">${esc(p.phone)}</div></div>
          <div class="acts">${p.id !== S.me.id ? `<select data-role="${p.id}" style="width:auto">${["supervisor", "assistant", "admin", "student"].map((r) => `<option value="${r}" ${r === p.role ? "selected" : ""}>${ROLE_NAMES[r]}</option>`).join("")}</select><button class="btn small" data-pcode="${p.id}">رمز تفعيل</button><button class="btn small ghost" data-pedit="${p.id}">تعديل</button>` : `<span class="muted">أنت</span>`}</div></div>`).join("")}</div>
      </div>`;
    document.getElementById("gf").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const { error } = await sb.from("groups").insert({ track: fd.get("track"), name: fd.get("name"), supervisor_id: fd.get("supervisor_id") || null });
      if (error) return toast(error.message);
      toast("أُضيفت المجموعة"); renderApp();
    };
    view.querySelectorAll("[data-gsup]").forEach((s) => (s.onchange = async () => {
      if (!s.value) return;
      const { error } = await sb.from("groups").update({ supervisor_id: s.value }).eq("id", s.dataset.gsup);
      if (error) return toast(error.message);
      renderApp();
    }));
    view.querySelectorAll("[data-gdel]").forEach((b) => (b.onclick = async () => {
      if (!confirm("حذف المجموعة؟ يبقى طلابها في البرنامج بلا مجموعة.")) return;
      const { error } = await sb.from("groups").delete().eq("id", b.dataset.gdel);
      if (error) return toast(error.message);
      renderApp();
    }));
    document.getElementById("pf").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target), btn = e.target.querySelector("button");
      busy(btn, true);
      try {
        const r = await callFn("admin-users", { action: "create", role: fd.get("role"), full_name: fd.get("full_name"), phone: fd.get("phone"), is_student: !!fd.get("is_student"), group_id: fd.get("group_id") || null });
        showCode(fd.get("full_name"), r.phone, r.code);
        VIEWS.admin(view);
      } catch (err) { toast(err.message); }
      busy(btn, false);
    };
    view.querySelectorAll("[data-role]").forEach((s) => (s.onchange = async () => {
      const upd = { role: s.value };
      if (s.value === "student") upd.is_student = true;
      const { error } = await sb.from("profiles").update(upd).eq("id", s.dataset.role);
      if (error) return toast(error.message);
      toast("تم تغيير الدور"); renderApp();
    }));
    view.querySelectorAll("[data-pcode]").forEach((b) => (b.onclick = async () => {
      const p = sup.find((x) => x.id === b.dataset.pcode);
      try { const r = await callFn("admin-users", { action: "reset_code", user_id: p.id }); showCode(p.full_name, p.phone, r.code); }
      catch (err) { toast(err.message); }
    }));
    view.querySelectorAll("[data-pedit]").forEach((b) => (b.onclick = () => editPerson(sup.find((x) => x.id === b.dataset.pedit))));
  };

  /* ---------- student views ---------- */
  VIEWS.mine = async (view) => {
    const st = S.me;
    const sun = R.weekStart(S.today);
    const ym = S.today.slice(0, 7);
    const ws = R.monthWeeks(ym);
    const from = ws[0] < sun ? ws[0] : sun;
    const data = await loadMarks([st.id], from, S.today);
    const { data: todayRep } = await sb.from("reports").select("*").eq("student_id", st.id).eq("day", S.today).maybeSingle();
    const w = R.weekResult(st, sun, data, S.today);
    const msum = R.monthSummary(st, ym, data, S.today);
    const isReview = R.dow(S.today) > 4;
    const exToday = data.excuses.get(st.id + "|" + S.today);
    let todayHtml;
    if (isReview) todayHtml = `<div class="empty" style="padding:10px">اليوم ${R.DAY_NAMES[R.dow(S.today)]}، يوم مراجعة. لا يُطلب تقرير اليوم، وفّقك الله.</div>`;
    else if (st.start_date > S.today) todayHtml = `<div class="empty">يبدأ احتساب تقاريرك من ${R.fmtDay(st.start_date)}.</div>`;
    else if (todayRep && !S.editToday) todayHtml = `<div class="msg ok">أرسلت تقرير اليوم ✅ بارك الله فيك</div>
      <div class="legend">${todayRep.memorized ? `<div><span>الحفظ</span><b>${esc(todayRep.memorized)}</b></div>` : ""}${todayRep.review ? `<div><span>المراجعة</span><b>${esc(todayRep.review)}</b></div>` : ""}${todayRep.note ? `<div><span>ملاحظة</span><b>${esc(todayRep.note)}</b></div>` : ""}</div>
      <button class="btn small" id="editRep" style="margin-top:12px">تعديل التقرير</button>`;
    else todayHtml = `${exToday === "accepted" ? `<div class="msg ok">لديك عذر مقبول اليوم 📝</div>` : exToday === "pending" ? `<div class="msg ok">عذرك لليوم بانتظار قرار المشرف</div>` : ""}
      <form id="rf">
        <div class="field"><label>ما حفظته اليوم</label><input name="memorized" value="${esc(todayRep?.memorized || "")}" placeholder="مثلًا: الألفية من البيت ١ إلى ١٠" required></div>
        <div class="field"><label>ما راجعته</label><input name="review" value="${esc(todayRep?.review || "")}" placeholder="اختياري"></div>
        <div class="field"><label>ملاحظة</label><textarea name="note" placeholder="اختياري">${esc(todayRep?.note || "")}</textarea></div>
        <button class="btn gold" style="width:100%">إرسال تقرير اليوم</button>
      </form><p class="muted" style="margin-top:10px">يُقبل تقرير اليوم حتى نهاية اليوم بتوقيت مسقط.</p>`;
    view.innerHTML = `
      <div class="panel glass"><h3>تقرير اليوم</h3>${todayHtml}</div>
      <div class="panel glass"><h3>أسبوعي</h3>
        ${w ? `<div class="strip">${w.days.map((d, i) => `<div class="d"><small>${R.DAY_NAMES[R.dow(d)]}</small><b>${R.MARK_SYM[w.marks[i]]}</b></div>`).join("")}</div>
        <p style="margin-top:12px">${w.final ? `قلادة الأسبوع: <b>${w.necklace.sym} ${w.necklace.name}</b>` : `التزمت ${R.ar(w.ok)} من ٥ أيام حتى الآن${w.ok >= 3 ? "" : "، والقلادة البرونزية تبدأ من ٣ أيام"}.`}</p>` : `<div class="empty">يبدأ احتساب أسبوعك من الأسبوع القادم.</div>`}
      </div>
      <div class="stats">
        <div class="stat glass"><b>${R.ar(msum.points)}</b><span>نقاط ${R.monthName(ym)}</span></div>
        <div class="stat glass"><b>${msum.medal ? msum.medal.sym : "—"}</b><span>${msum.medal ? msum.medal.name : "لم تبلغ وسامًا بعد"}</span></div>
        <div class="stat glass"><b>${R.ar(msum.notices)} ⭕ · ${R.ar(msum.warnings)} ⚠️</b><span>تنبيهات وإنذارات الشهر</span></div>
      </div>`;
    const ed = document.getElementById("editRep");
    if (ed) ed.onclick = () => { S.editToday = true; VIEWS.mine(view); };
    const f = document.getElementById("rf");
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(f), btn = f.querySelector("button");
      busy(btn, true);
      const today = R.todayISO(C.timeZone);
      const { error } = await sb.from("reports").upsert({ student_id: st.id, day: today, memorized: fd.get("memorized"), review: fd.get("review"), note: fd.get("note") }, { onConflict: "student_id,day" });
      busy(btn, false);
      if (error) return toast("تعذّر الإرسال: " + error.message);
      S.editToday = false;
      toast("وصل تقريرك ✅");
      VIEWS.mine(view);
    };
  };

  VIEWS.history = async (view) => {
    const st = S.me;
    const ym = S.histMonth || S.today.slice(0, 7);
    const ws = R.monthWeeks(ym);
    const data = await loadMarks([st.id], ws[0], R.addDays(ws[ws.length - 1], 4));
    const m = R.monthSummary(st, ym, data, S.today);
    view.innerHTML = `
      <div class="panel glass">
        <div class="toolbar"><button class="btn small" id="pm">→ الشهر السابق</button><span class="badge gold">${R.monthName(ym)}</span><button class="btn small" id="nm" ${ym >= S.today.slice(0, 7) ? "disabled" : ""}>الشهر التالي ←</button></div>
        <div class="stats">
          <div class="stat glass"><b>${R.ar(m.points)}</b><span>مجموع النقاط</span></div>
          <div class="stat glass"><b>${m.medal ? m.medal.sym : "—"}</b><span>${m.medal ? m.medal.name : "بلا وسام"}</span></div>
        </div>
        <div class="list">${m.weeks.length ? m.weeks.map((w, i) => `<div class="item"><div><b>الأسبوع ${R.ar(i + 1)}</b> <span class="meta">${R.fmtShort(w.days[0])} - ${R.fmtShort(w.days[4])}</span><div style="font-size:20px;letter-spacing:2px">${w.marks.map((x) => R.MARK_SYM[x]).join("")}</div></div>
          <div>${w.final ? `<span class="badge">${w.necklace.sym} ${w.necklace.name}</span>` : `<span class="muted">جارٍ</span>`}${i >= 4 ? ` <span class="muted">(لا يدخل في النقاط)</span>` : ""}</div></div>`).join("") : `<div class="empty">لا يوجد سجل لهذا الشهر</div>`}</div>
      </div>`;
    document.getElementById("pm").onclick = () => { S.histMonth = R.shiftMonth(ym, -1); VIEWS.history(view); };
    document.getElementById("nm").onclick = () => { S.histMonth = R.shiftMonth(ym, 1); VIEWS.history(view); };
  };

  VIEWS.myexcuses = async (view) => {
    const st = S.me;
    const { data: rows } = await sb.from("excuses").select("*").eq("student_id", st.id).order("day", { ascending: false }).limit(40);
    view.innerHTML = `
      <div class="panel glass"><h3>إبلاغ بعذر</h3>
        <p class="muted">أبلغ بعذرك في اليوم نفسه، أو فور تمكّنك إن تعذّر ذلك. يقبله مشرفك أو يرفضه.</p>
        <form id="xf" class="row">
          <div><label>من يوم</label><input type="date" name="from" value="${S.today}" min="${R.addDays(S.today, -14)}" required></div>
          <div><label>إلى يوم</label><input type="date" name="to" value="${S.today}" min="${R.addDays(S.today, -14)}" required></div>
          <div><label>نوع العذر</label><select name="cat">${EXCUSE_TYPES.map((t) => `<option>${t}</option>`).join("")}</select></div>
          <div><label>التفاصيل</label><input name="reason" required></div>
          <button class="btn gold">إرسال</button>
        </form></div>
      <div class="panel glass"><h3>أعذاري</h3><div class="list">${(rows || []).length ? rows.map((r) => `<div class="item"><div><b>${R.DAY_NAMES[R.dow(r.day)]} ${R.fmtDay(r.day)}</b> <span class="badge ${r.status === "accepted" ? "green" : r.status === "rejected" ? "red" : "blue"}">${{ pending: "بانتظار القرار", accepted: "مقبول", rejected: "مرفوض" }[r.status]}</span><div class="meta">${esc(r.category || "")} · ${esc(r.reason || "")}</div></div>
        ${r.status === "pending" ? `<button class="btn small ghost" data-xdel="${r.id}">سحب</button>` : ""}</div>`).join("") : `<div class="empty">لا توجد أعذار</div>`}</div></div>`;
    document.getElementById("xf").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const days = [];
      for (let d = fd.get("from"); d <= fd.get("to") && days.length < 30; d = R.addDays(d, 1)) if (R.dow(d) <= 4) days.push(d);
      if (!days.length) return toast("اختر أيامًا من الأحد إلى الخميس");
      const { error } = await sb.from("excuses").insert(days.map((day) => ({ student_id: st.id, day, category: fd.get("cat"), reason: fd.get("reason"), status: "pending" })));
      if (error) return toast(error.code === "23505" ? "سبق تسجيل عذر لأحد هذه الأيام" : error.message);
      toast("أُرسل العذر إلى مشرفك");
      VIEWS.myexcuses(view);
    };
    view.querySelectorAll("[data-xdel]").forEach((b) => (b.onclick = async () => { await sb.from("excuses").delete().eq("id", b.dataset.xdel); VIEWS.myexcuses(view); }));
  };

  /* ---------- boot ---------- */
  (async () => { await loadMe(); render(); })();
})();
