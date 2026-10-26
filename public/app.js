// MAGLARD OS screens. Plain ES module, no build step; talks to the same server's JSON API.

const view = document.getElementById("view");

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n) => (n == null ? "" : `₪${Number(n).toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);
const date = (d) => (d ? new Date(d).toLocaleDateString("he-IL") : "");
const today = () => new Date().toISOString().slice(0, 10);

const STATUS = {
  new: ["קריאה חדשה", "warn"],
  triage: ["בבירור ותיאום", "warn"],
  with_supplier: ["בטיפול ספק", ""],
  awaiting_resolution: ["ממתין לאישור פתרון", ""],
  closed: ["נסגרה", "good"],
};
const CHARGE = { client: "הלקוח", owner: "בעל הדירה", maglard: "מגלארד" };
const SYNC = { synced: ["סונכרן ל-Planfix", "good"], pending: ["ממתין לסנכרון", "warn"], failed: ["סנכרון נכשל", "bad"] };
const JOB = { "engagement.push": "קליטת דירה", "supplier_invoice.push": "חשבונית ספק", "service_request.sync": "קריאת שירות" };

// The signed-in user, with the permissions the server grants their role. The
// server enforces them; here they only decide what to show.
let me = null;
const allowed = (permission) => Boolean(me?.permissions.includes(permission));

const pill = ([text, tone]) => `<span class="pill ${tone}">${esc(text)}</span>`;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== "/auth/login") {
    showLogin();
    throw new Error("נדרשת כניסה");
  }
  if (!res.ok) {
    const issue = data.issues?.[0];
    throw new Error(issue ? `${issue.path.join(".")}: ${issue.message}` : data.error || `שגיאה ${res.status}`);
  }
  return data;
}

function toast(text) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2600);
}

// What the person should do next on a service request, and the button for it.
function nextStep(r) {
  switch (r.status) {
    case "new":
      return { text: "לבחור ספק ולקבוע על חשבון מי העבודה", action: "assign", label: "שיוך ספק" };
    case "triage":
      return r.charge_to === "client" && !r.client_approved_at
        ? { text: "העבודה על חשבון הלקוח: צריך את אישור הלקוח לפני שהספק מתחיל", action: "approve", label: "רישום אישור לקוח" }
        : { text: "לבחור ספק", action: "assign", label: "שיוך ספק" };
    case "with_supplier":
      return { text: "כשהספק סיים: לקלוט את החשבונית שלו", action: "invoice", label: "קליטת חשבונית ספק" };
    case "awaiting_resolution":
      return { text: "לוודא מול הפונה שהתקלה נפתרה ולסגור", action: "close", label: "סגירת קריאה" };
    default:
      return null;
  }
}

// ---------- dialogs ----------

function dialog(title, fields, onSubmit, submitLabel = "שמירה") {
  const d = document.createElement("dialog");
  d.innerHTML = `<form method="dialog" novalidate>
    <h3>${esc(title)}</h3>
    <div class="grid">${fields}</div>
    <div class="err" role="alert"></div>
    <div class="actions"><button class="btn primary" value="ok">${esc(submitLabel)}</button>
    <button class="btn" value="cancel" formnovalidate>ביטול</button></div></form>`;
  document.body.append(d);
  const form = d.querySelector("form");
  form.addEventListener("submit", async (e) => {
    if (e.submitter?.value === "cancel") return;
    e.preventDefault();
    const btn = form.querySelector(".primary");
    btn.disabled = true;
    try {
      await onSubmit(Object.fromEntries(new FormData(form)));
      d.close();
    } catch (err) {
      form.querySelector(".err").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
  d.addEventListener("close", () => d.remove());
  d.showModal();
  return d;
}

const field = (name, label, attrs = "", full = false) =>
  `<label class="${full ? "full" : ""}">${esc(label)}<input name="${name}" ${attrs}></label>`;

// A contact field: pick an existing name from the list, or type a new one.
async function contactField(name, label, kind) {
  const list = await api("GET", `/contacts?kind=${kind}`);
  const id = `dl-${name}`;
  return {
    html: `<label>${esc(label)}<input name="${name}" list="${id}" required autocomplete="off">
      <datalist id="${id}">${list.map((c) => `<option value="${esc(c.name)}">`).join("")}</datalist></label>`,
    resolve: (value) => {
      const match = list.find((c) => c.name === value.trim());
      return match ? { id: match.id } : { name: value.trim() };
    },
  };
}

async function intakeDialog() {
  const owner = await contactField("owner", "בעל הדירה", "owner");
  const client = await contactField("client", "לקוח (תאגיד)", "client");
  dialog(
    "קליטת דירה חדשה",
    field("baseNumber", "מספר בסיס דירה", 'type="number" required min="1"') +
      field("monthlyRent", "שכר דירה חודשי", 'type="number" required min="0" step="0.01"') +
      field("address", "כתובת מלאה", "required", true) +
      owner.html +
      client.html +
      field("startsOn", "תחילת התקשרות", 'type="date" required') +
      field("endsOn", "סיום התקשרות", 'type="date" required') +
      field("moveInOn", "תאריך כניסה", 'type="date" required'),
    async (v) => {
      await api("POST", "/intakes", {
        baseNumber: Number(v.baseNumber),
        address: v.address,
        owner: owner.resolve(v.owner),
        client: client.resolve(v.client),
        startsOn: v.startsOn,
        endsOn: v.endsOn,
        moveInOn: v.moveInOn,
        monthlyRent: Number(v.monthlyRent),
      });
      toast("הדירה נשמרה. הסנכרון ל-Planfix רץ ברקע.");
      route();
    },
    "קליטה",
  );
}

async function newRequestDialog(engagementId) {
  const engagements = await api("GET", "/engagements");
  if (!engagements.length) return toast("קודם צריך לקלוט דירה");
  dialog(
    "פתיחת קריאת שירות",
    `<label class="full">דירה<select name="engagementId" required>${engagements
      .map((e) => `<option value="${e.id}" ${e.id === engagementId ? "selected" : ""}>${esc(e.apartment_code)} — ${esc(e.address)}</option>`)
      .join("")}</select></label>` +
      field("subject", "נושא התקלה", "required", true) +
      field("reportedBy", "פותח הקריאה", "required") +
      `<label class="full">פירוט<textarea name="description" rows="3"></textarea></label>`,
    async (v) => {
      const { id } = await api("POST", "/service-requests", { ...v, description: v.description || undefined });
      toast("הקריאה נפתחה");
      location.hash = `#/requests/${id}`;
    },
    "פתיחה",
  );
}

async function stepDialog(r, action) {
  const base = `/service-requests/${r.id}`;
  const done = (msg) => {
    toast(msg);
    route();
  };
  if (action === "assign") {
    const supplier = await contactField("supplier", "ספק מטפל", "supplier");
    dialog(
      "שיוך ספק",
      supplier.html +
        `<label>על חשבון מי<select name="chargeTo" required>
          <option value="client">הלקוח</option><option value="owner">בעל הדירה</option><option value="maglard">מגלארד</option>
        </select></label>`,
      async (v) => {
        const res = await api("POST", `${base}/assign`, { supplier: supplier.resolve(v.supplier), chargeTo: v.chargeTo });
        done(res.status === "triage" ? "נשמר. ממתין לאישור הלקוח." : "הקריאה עברה לספק");
      },
    );
  } else if (action === "approve") {
    dialog("אישור לקוח לעבודה לחיוב", field("reference", "אסמכתה (מייל, הודעה, מסמך)", "required", true), async (v) => {
      await api("POST", `${base}/client-approval`, v);
      done("אישור הלקוח נרשם");
    });
  } else if (action === "invoice") {
    dialog(
      "קליטת חשבונית ספק",
      field("invoiceNumber", "מספר חשבונית", "required") +
        field("invoiceDate", "תאריך חשבונית", `type="date" required value="${today()}"`) +
        field("amountNet", "סכום לפני מע״מ", 'type="number" required min="0" step="0.01"') +
        field("amountVat", "מע״מ", 'type="number" required min="0" step="0.01"'),
      async (v) => {
        const net = Number(v.amountNet);
        const vat = Number(v.amountVat);
        await api("POST", `${base}/invoice`, {
          invoiceNumber: v.invoiceNumber,
          invoiceDate: v.invoiceDate,
          amountNet: net,
          amountVat: vat,
          amountTotal: Math.round((net + vat) * 100) / 100,
        });
        done("החשבונית נקלטה ונשלחת ל-Planfix");
      },
    );
  } else if (action === "close") {
    dialog("סגירת קריאה", `<p class="full">לסגור את הקריאה "${esc(r.subject)}"?</p>`, async () => {
      await api("POST", `${base}/close`);
      done("הקריאה נסגרה");
    }, "סגירה");
  }
}

// ---------- views ----------

async function workCenterView() {
  const w = await api("GET", "/work-center");
  const c = w.counts;
  view.innerHTML = `
    <h1>מרכז עבודה</h1>
    <p class="sub">כל מה שמחכה לך עכשיו, מהישן לחדש.</p>
    <div class="kpis">
      <div class="kpi"><b>${c.open_requests}</b><span>קריאות פתוחות</span></div>
      <div class="kpi"><b>${c.engagements}</b><span>דירות בהתקשרות</span></div>
      <div class="kpi"><b>${c.sync_pending}</b><span>ממתינים לסנכרון</span></div>
      <div class="kpi"><b>${c.sync_failed}</b><span>כשלי סנכרון</span></div>
    </div>
    ${
      w.syncFailures.length
        ? `<h2>כשלי סנכרון</h2>${w.syncFailures
            .map(
              (f) => `<div class="card"><div class="grow"><b>${esc(JOB[f.job_type] || f.job_type)}</b><br>
              <small>${esc(f.last_error)}</small></div>${allowed("sync.view") ? `<a class="btn" href="#/sync">לטיפול</a>` : ""}</div>`,
            )
            .join("")}`
        : ""
    }
    <h2>קריאות שמחכות לפעולה</h2>
    ${
      w.requests.length
        ? w.requests
            .map((r) => {
              const n = nextStep(r);
              return `<div class="card"><div class="grow"><b>${esc(r.subject)}</b> ${pill(STATUS[r.status])}<br>
                <small>${esc(r.apartment_code)} · ${esc(r.address)} · נפתחה ${date(r.created_at)}</small><br>${esc(n.text)}</div>
                <a class="btn primary" href="#/requests/${r.id}">${esc(n.label)}</a></div>`;
            })
            .join("")
        : `<div class="empty">אין קריאות פתוחות</div>`
    }`;
}

async function apartmentsView() {
  const rows = await api("GET", "/engagements");
  view.innerHTML = `
    <div class="head"><div><h1>דירות</h1><p class="sub">דירות בהתקשרות וסטטוס הסנכרון שלהן ל-Planfix.</p></div>
    ${allowed("apartments.create") ? `<button class="btn primary" id="add">קליטת דירה</button>` : ""}</div>
    ${
      rows.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>קוד</th><th>כתובת</th><th>בעל דירה</th><th>לקוח</th>
          <th>תקופה</th>${allowed("amounts.view") ? "<th>שכ״ד</th>" : ""}<th>Planfix</th></tr></thead><tbody>${rows
            .map(
              (e) => `<tr><td>${esc(e.apartment_code)}</td><td><a href="#/properties/${e.property_id}">${esc(e.address)}</a></td><td>${esc(e.owner_name)}</td>
              <td><a href="#/clients/${e.client_id}">${esc(e.client_name)}</a></td><td>${date(e.starts_on)}–${date(e.ends_on)}</td>${allowed("amounts.view") ? `<td>${money(e.monthly_rent)}</td>` : ""}
              <td>${pill(SYNC[e.sync])}${e.planfix_task_id ? ` <small>#${e.planfix_task_id}</small>` : ""}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">עדיין אין דירות.</div>`
    }`;
  view.querySelector("#add")?.addEventListener("click", intakeDialog);
}

async function requestsView() {
  const rows = await api("GET", "/service-requests");
  view.innerHTML = `
    <div class="head"><div><h1>קריאות שירות</h1><p class="sub">תקלות וקריאות, כולל עבודה לחיוב הלקוח.</p></div>
    ${allowed("requests.manage") ? `<button class="btn primary" id="add">קריאה חדשה</button>` : ""}</div>
    ${
      rows.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>נושא</th><th>דירה</th><th>סטטוס</th><th>על חשבון</th>
          <th>ספק</th><th>נפתחה</th></tr></thead><tbody>${rows
            .map(
              (r) => `<tr class="click" data-id="${r.id}" tabindex="0"><td>${esc(r.subject)}</td>
              <td>${esc(r.apartment_code)}</td><td>${pill(STATUS[r.status])}</td><td>${esc(CHARGE[r.charge_to] || "")}</td>
              <td>${esc(r.supplier_name || "")}</td><td>${date(r.created_at)}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">אין קריאות</div>`
    }`;
  view.querySelector("#add")?.addEventListener("click", () => newRequestDialog());
  view.querySelectorAll("tr.click").forEach((tr) => {
    const go = () => (location.hash = `#/requests/${tr.dataset.id}`);
    tr.onclick = go;
    tr.onkeydown = (e) => e.key === "Enter" && go();
  });
}

async function requestView(id) {
  const r = await api("GET", `/service-requests/${id}`);
  const step = nextStep(r);
  // Show the step to everyone, but the button only to a role that may take it.
  const mayAct = step && allowed(step.action === "invoice" ? "invoices.create" : "requests.manage");
  const n = step && { ...step, label: mayAct ? step.label : null };
  view.innerHTML = `
    <p><a href="#/requests">→ כל הקריאות</a></p>
    <h1>${esc(r.subject)}</h1>
    <p class="sub">${pill(STATUS[r.status])} · פתח: ${esc(r.reported_by)} · ${date(r.created_at)}</p>
    ${n ? `<div class="next"><div class="grow" style="flex:1">${esc(n.text)}</div>${n.label ? `<button class="btn primary" id="next">${esc(n.label)}</button>` : ""}</div>` : ""}
    ${r.description ? `<p>${esc(r.description)}</p>` : ""}
    <div class="kpis">
      <div class="kpi"><span>על חשבון</span><b style="font-size:18px">${esc(CHARGE[r.charge_to] || "טרם נקבע")}</b></div>
      <div class="kpi"><span>אישור לקוח</span><b style="font-size:18px">${r.client_approved_at ? esc(r.client_approval_ref) : "—"}</b></div>
    </div>
    <h2>היסטוריה</h2>
    <ul class="timeline">${r.events
      .map((e) => `<li>${esc(STATUS[e.to_status][0])} ${e.note ? `· ${esc(e.note)}` : ""} <small>${new Date(e.created_at).toLocaleString("he-IL")}</small></li>`)
      .join("")}</ul>`;
  view.querySelector("#next")?.addEventListener("click", () => stepDialog(r, n.action));
}

async function invoicesView() {
  const rows = await api("GET", "/supplier-invoices");
  view.innerHTML = `
    <h1>חשבוניות ספק</h1><p class="sub">חשבוניות שנקלטו, ומצב הסנכרון שלהן ל-Planfix.</p>
    ${
      rows.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>מספר</th><th>ספק</th><th>דירה</th><th>תאריך</th>
          <th>לפני מע״מ</th><th>סה״כ</th><th>אופן טיפול</th><th>Planfix</th></tr></thead><tbody>${rows
            .map(
              (i) => `<tr><td>${esc(i.invoice_number)}</td><td>${esc(i.supplier_name)}</td><td>${esc(i.apartment_code)}</td>
              <td>${date(i.invoice_date)}</td><td>${money(i.amount_net)}</td><td>${money(i.amount_total)}</td>
              <td>${esc(i.handling)}</td><td>${pill(SYNC[i.sync])}${i.planfix_task_id ? ` <small>#${i.planfix_task_id}</small>` : ""}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">אין חשבוניות</div>`
    }`;
}

// Import of the apartments that already live in Planfix (admin). A dry run
// first shows what would change; only the second button writes.
function importCard() {
  if (!allowed("import.run")) return "";
  return `<div class="card" id="import"><div class="grow"><b>ייבוא דירות מ-Planfix</b><br>
    <small>מביא בעלי דירות, לקוחות, דירות והתקשרויות שכבר קיימים ב-Planfix. הרצה חוזרת מעדכנת ולא יוצרת כפילויות. Planfix לא משתנה.</small>
    <div id="import-result"></div></div>
    <button class="btn" id="import-dry">בדיקה בלי לשמור</button></div>`;
}

function importReport(r) {
  const line = (label, t) => `<li>${label}: ${t.created} חדשים, ${t.updated} עודכנו</li>`;
  const skipped = r.skipped.length
    ? `<p><b>${r.skipped.length} לא ${r.dryRun ? "ייובאו" : "יובאו"}:</b></p><ul>${r.skipped
        .map((s) => `<li>משימה ${s.planfixTaskId} (${s.what === "property" ? "דירה" : "התקשרות"}): ${esc(s.reason)}</li>`)
        .join("")}</ul>`
    : "";
  return `<p><b>${r.dryRun ? "בדיקה, שום דבר לא נשמר:" : "הייבוא הסתיים:"}</b></p><ul>
    ${line("אנשי קשר", r.contacts)}${line("דירות", r.properties)}${line("התקשרויות", r.engagements)}</ul>${skipped}
    ${r.dryRun ? `<button class="btn primary" id="import-run">ייבוא בפועל</button>` : ""}`;
}

function wireImport() {
  const box = view.querySelector("#import-result");
  if (!box) return;
  const run = async (dryRun, btn) => {
    btn.disabled = true;
    box.innerHTML = "<p>קורא מ-Planfix…</p>";
    try {
      box.innerHTML = importReport(await api("POST", "/import/planfix", { dryRun }));
      box.querySelector("#import-run")?.addEventListener("click", (e) => run(false, e.target));
      if (!dryRun) toast("הייבוא הסתיים");
    } catch (err) {
      box.innerHTML = `<p class="err">${esc(err.message)}</p>`;
    } finally {
      btn.disabled = false;
    }
  };
  view.querySelector("#import-dry").onclick = (e) => run(true, e.target);
}

async function syncView() {
  const { jobs } = await api("GET", "/sync/status");
  const tone = { done: ["הושלם", "good"], pending: ["ממתין", "warn"], running: ["רץ", "warn"], failed: ["נכשל", "bad"] };
  view.innerHTML = `
    <h1>סנכרון Planfix</h1><p class="sub">כל פעולה נשמרת קודם כאן ונשלחת ל-Planfix ברקע. פעולה שנכשלה אפשר לשלוח שוב.</p>
    ${importCard()}
    ${
      jobs.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>פעולה</th><th>מצב</th><th>ניסיונות</th><th>שגיאה</th><th>עודכן</th><th></th></tr></thead><tbody>${jobs
            .map(
              (j) => `<tr><td>${esc(JOB[j.job_type] || j.job_type)}</td><td>${pill(tone[j.status])}</td><td>${j.attempts}</td>
              <td><small>${esc(j.last_error || "")}</small></td><td>${new Date(j.updated_at).toLocaleString("he-IL")}</td>
              <td>${j.status === "failed" && allowed("sync.retry") ? `<button class="btn" data-retry="${j.id}">שליחה חוזרת</button>` : ""}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">עדיין לא נשלח דבר ל-Planfix</div>`
    }`;
  wireImport();
  view.querySelectorAll("[data-retry]").forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        await api("POST", `/sync/${b.dataset.retry}/retry`);
        toast("נשלח שוב לתור");
        route();
      } catch (err) {
        toast(err.message);
        b.disabled = false;
      }
    };
  });
}

// ---------- login ----------

function showLogin() {
  if (document.getElementById("login")) return;
  document.body.innerHTML = `<main class="login">
    <form id="login" novalidate>
      <h1>MAGLARD OS</h1><p class="sub">כניסה למערכת</p>
      <label>אימייל<input name="email" type="email" autocomplete="username" required></label>
      <label>סיסמה<input name="password" type="password" autocomplete="current-password" required></label>
      <div class="err" role="alert"></div>
      <button class="btn primary">כניסה</button>
    </form></main>`;
  const form = document.getElementById("login");
  form.querySelector("input").focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("POST", "/auth/login", Object.fromEntries(new FormData(form)));
      location.reload();
    } catch (err) {
      form.querySelector(".err").textContent = err.message;
    }
  });
}


// ---------- clients and properties ----------

const period = (e) => `${date(e.starts_on)} עד ${date(e.ends_on)}`;
const activePill = (e) => (e.active ? pill(["בתוקף", "good"]) : pill([new Date(e.ends_on) < new Date() ? "הסתיים" : "עתידי", ""]));

function requestsTable(rows) {
  if (!rows.length) return `<div class="empty">אין קריאות שירות</div>`;
  return `<div class="wrap"><table class="table"><thead><tr><th>נושא</th><th>דירה</th><th>סטטוס</th><th>ספק</th><th>נפתחה</th></tr></thead><tbody>${rows
    .map(
      (r) => `<tr><td><a href="#/requests/${r.id}">${esc(r.subject)}</a></td><td>${esc(r.apartment_code)}</td>
      <td>${pill(STATUS[r.status])}</td><td>${esc(r.supplier_name || "")}</td><td>${date(r.created_at)}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function invoicesTable(rows) {
  if (!allowed("invoices.view")) return "";
  return `<h2>חשבוניות ספק</h2>${
    rows.length
      ? `<div class="wrap"><table class="table"><thead><tr><th>מספר</th><th>ספק</th><th>דירה</th><th>תאריך</th>${
          allowed("amounts.view") ? "<th>סה״כ</th>" : ""
        }<th>אופן טיפול</th></tr></thead><tbody>${rows
          .map(
            (i) => `<tr><td>${esc(i.invoice_number)}</td><td>${esc(i.supplier_name)}</td><td>${esc(i.apartment_code)}</td>
            <td>${date(i.invoice_date)}</td>${allowed("amounts.view") ? `<td>${money(i.amount_total)}</td>` : ""}<td>${esc(i.handling)}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : `<div class="empty">אין חשבוניות</div>`
  }`;
}

// What an engagement still lacks, in the words an employee would use.
function missingFor(e) {
  const gaps = [];
  if (!e.move_in_on) gaps.push("תאריך כניסה");
  if (allowed("amounts.view") && e.monthly_rent == null) gaps.push("שכר דירה");
  return gaps;
}

async function clientsView() {
  const rows = await api("GET", "/clients");
  view.innerHTML = `
    <h1>לקוחות</h1><p class="sub">התאגידים שמגלארד מנהלת עבורם דירות.</p>
    ${
      rows.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>לקוח</th><th>דירות בתוקף</th><th>כל הדירות</th><th>קריאות פתוחות</th></tr></thead><tbody>${rows
            .map(
              (c) => `<tr class="click" data-href="#/clients/${c.id}" tabindex="0"><td>${esc(c.name)}</td><td>${c.active_apartments}</td>
              <td>${c.apartments}</td><td>${c.open_requests || ""}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">אין לקוחות עדיין</div>`
    }`;
  clickableRows();
}

async function clientView(id) {
  const c = await api("GET", `/clients/${id}`);
  const active = c.engagements.filter((e) => e.active);
  const openReqs = c.requests.filter((r) => r.status !== "closed");
  const gaps = active.flatMap((e) => missingFor(e).map((g) => `${e.apartment_code}: ${g}`));
  view.innerHTML = `
    <p><a href="#/clients">→ כל הלקוחות</a></p>
    <div class="head"><div><h1>${esc(c.name)}</h1><p class="sub">לקוח${c.planfix_id ? ` · איש קשר ${c.planfix_id} ב-Planfix` : ""}</p></div>
    ${allowed("requests.manage") && active.length ? `<button class="btn primary" id="new-req">פתיחת קריאת שירות</button>` : ""}</div>
    ${gaps.length ? `<div class="missing"><b>מה חסר:</b> ${esc(gaps.join(" · "))}</div>` : ""}
    <div class="facts">
      <div><span>דירות בתוקף</span><b>${active.length}</b></div>
      <div><span>קריאות פתוחות</span><b>${openReqs.length}</b></div>
      ${allowed("amounts.view") ? `<div><span>שכ״ד חודשי בדירות בתוקף</span><b>${money(active.reduce((t, e) => t + Number(e.monthly_rent || 0), 0))}</b></div>` : ""}
    </div>
    <h2>דירות</h2>
    ${
      c.engagements.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>קוד</th><th>כתובת</th><th>בעל דירה</th><th>תקופה</th>${
            allowed("amounts.view") ? "<th>שכ״ד</th>" : ""
          }<th></th></tr></thead><tbody>${c.engagements
            .map(
              (e) => `<tr><td>${esc(e.apartment_code)}</td><td><a href="#/properties/${e.property_id}">${esc(e.address)}</a></td>
              <td>${esc(e.owner_name)}</td><td>${period(e)}</td>${allowed("amounts.view") ? `<td>${money(e.monthly_rent)}</td>` : ""}
              <td>${activePill(e)}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">אין דירות</div>`
    }
    <h2>קריאות שירות</h2>${requestsTable(c.requests)}
    ${invoicesTable(c.invoices)}`;
  view.querySelector("#new-req")?.addEventListener("click", () =>
    newRequestDialog(active.length === 1 ? active[0].id : undefined),
  );
}

async function propertyView(id) {
  const p = await api("GET", `/properties/${id}`);
  const current = p.engagements.find((e) => e.active) || p.engagements[0];
  const gaps = current ? missingFor(current) : ["התקשרות"];
  view.innerHTML = `
    <p><a href="#/apartments">→ כל הדירות</a></p>
    <div class="head"><div><h1>${esc(p.address)}</h1>
      <p class="sub">דירה ${p.base_number} · ${current ? activePill(current) : pill(["אין התקשרות", "warn"])}
      ${p.planfix_task_id ? ` · משימה ${p.planfix_task_id} ב-Planfix` : ""}</p></div>
    ${allowed("requests.manage") && current ? `<button class="btn primary" id="new-req">פתיחת קריאת שירות</button>` : ""}</div>
    ${gaps.length ? `<div class="missing"><b>מה חסר:</b> ${esc(gaps.join(" · "))}</div>` : ""}
    <div class="facts">
      <div><span>בעל הדירה</span><b>${esc(p.owner_name)}</b></div>
      ${current ? `<div><span>לקוח</span><b><a href="#/clients/${current.client_id}">${esc(current.client_name)}</a></b></div>
      <div><span>תקופת התקשרות</span><b>${period(current)}</b></div>
      <div><span>כניסה</span><b>${current.move_in_on ? date(current.move_in_on) : "—"}</b></div>
      ${allowed("amounts.view") ? `<div><span>שכ״ד חודשי</span><b>${current.monthly_rent == null ? "—" : money(current.monthly_rent)}</b></div>` : ""}` : ""}
    </div>
    <h2>קריאות שירות</h2>${requestsTable(p.requests)}
    ${invoicesTable(p.invoices)}
    <h2>ספקים שעבדו בדירה</h2>
    ${p.suppliers.length ? `<ul>${p.suppliers.map((s) => `<li>${esc(s.name)} · ${s.jobs} קריאות</li>`).join("")}</ul>` : `<div class="empty">עדיין לא</div>`}
    ${
      p.engagements.length > 1
        ? `<h2>התקשרויות קודמות</h2><ul>${p.engagements
            .filter((e) => e !== current)
            .map((e) => `<li>${esc(e.client_name)} · ${period(e)}</li>`)
            .join("")}</ul>`
        : ""
    }`;
  view.querySelector("#new-req")?.addEventListener("click", () => newRequestDialog(current.id));
}

function clickableRows() {
  view.querySelectorAll("tr[data-href]").forEach((tr) => {
    const go = () => (location.hash = tr.dataset.href);
    tr.onclick = go;
    tr.onkeydown = (e) => e.key === "Enter" && go();
  });
}

// ---------- global search ----------

const HIT_LINK = {
  client: (id) => `#/clients/${id}`,
  property: (id) => `#/properties/${id}`,
  request: (id) => `#/requests/${id}`,
  invoice: () => "#/invoices",
  supplier: () => null, // supplier cards come with the suppliers module
};

function wireSearch() {
  const input = document.getElementById("search");
  const box = document.getElementById("hits");
  let timer;
  let seq = 0;
  const close = () => (box.hidden = true);
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++seq;
      const q = input.value.trim();
      if (q.length < 2) return close();
      const { hits } = await api("GET", `/search?q=${encodeURIComponent(q)}`).catch(() => ({ hits: [] }));
      if (mine !== seq) return; // a newer search is on its way
      box.innerHTML = hits.length
        ? hits
            .map((h) => {
              const href = HIT_LINK[h.type](h.id);
              return href
                ? `<a href="${href}"><span>${esc(h.title)}</span><small>${esc(h.detail)}</small></a>`
                : `<a aria-disabled="true"><span>${esc(h.title)}</span><small>${esc(h.detail)}</small></a>`;
            })
            .join("")
        : `<a aria-disabled="true"><small>לא נמצא דבר עבור "${esc(q)}"</small></a>`;
      box.hidden = false;
    }, 200);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter") box.querySelector("a[href]")?.click();
  });
  box.addEventListener("click", () => {
    input.value = "";
    close();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".top")) close();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      input.focus();
    }
  });
}

// ---------- users and audit (admin) ----------

async function usersView() {
  const { users, roles } = await api("GET", "/users");
  const roleOptions = (selected) =>
    Object.entries(roles)
      .map(([k, label]) => `<option value="${k}" ${k === selected ? "selected" : ""}>${esc(label)}</option>`)
      .join("");
  view.innerHTML = `
    <div class="head"><div><h1>משתמשים</h1><p class="sub">מי נכנס למערכת ובאיזה תפקיד. התפקיד קובע מה המשתמש רואה ומה מותר לו לעשות.</p></div>
    <button class="btn primary" id="add">משתמש חדש</button></div>
    <div class="wrap"><table class="table"><thead><tr><th>שם</th><th>אימייל</th><th>תפקיד</th><th>מצב</th><th></th></tr></thead><tbody>${users
      .map(
        (u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
        <td><select data-role="${u.id}" aria-label="תפקיד של ${esc(u.name)}" ${u.id === me.id ? "disabled" : ""}>${roleOptions(u.role)}</select></td>
        <td>${u.active ? pill(["פעיל", "good"]) : pill(["חסום", "bad"])}</td>
        <td>${
          u.id === me.id
            ? "<small>זה אתה</small>"
            : `<button class="btn" data-active="${u.id}" data-to="${!u.active}">${u.active ? "חסימה" : "הפעלה"}</button>
               <button class="btn" data-password="${u.id}">סיסמה חדשה</button>`
        }</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
  const save = async (id, change, msg) => {
    try {
      await api("POST", `/users/${id}`, change);
      toast(msg);
    } catch (err) {
      toast(err.message);
    }
    route();
  };
  view.querySelectorAll("[data-role]").forEach((sel) => {
    sel.onchange = () => save(sel.dataset.role, { role: sel.value }, "התפקיד עודכן");
  });
  view.querySelectorAll("[data-active]").forEach((b) => {
    b.onclick = () =>
      save(b.dataset.active, { active: b.dataset.to === "true" }, b.dataset.to === "true" ? "המשתמש הופעל" : "המשתמש נחסם ונותק");
  });
  view.querySelectorAll("[data-password]").forEach((b) => {
    b.onclick = () =>
      dialog("סיסמה חדשה", field("password", "סיסמה חדשה (10 תווים לפחות)", 'type="password" required', true), async (v) => {
        await api("POST", `/users/${b.dataset.password}`, { password: v.password });
        toast("הסיסמה הוחלפה והמשתמש נותק");
      });
  });
  view.querySelector("#add").onclick = () =>
    dialog(
      "משתמש חדש",
      field("name", "שם", "required") +
        field("email", "אימייל", 'type="email" required') +
        `<label>תפקיד<select name="role" required>${roleOptions("operations")}</select></label>` +
        field("password", "סיסמה ראשונית (10 תווים לפחות)", 'type="password" required'),
      async (v) => {
        await api("POST", "/users", v);
        toast("המשתמש נוצר");
        route();
      },
      "יצירה",
    );
}

const AUDIT_ACTION = {
  login: "כניסה",
  "POST /auth/logout": "יציאה",
  "POST /intakes": "קליטת דירה",
  "POST /service-requests": "פתיחת קריאה",
  "POST /service-requests/:id/assign": "שיוך ספק",
  "POST /service-requests/:id/client-approval": "רישום אישור לקוח",
  "POST /service-requests/:id/invoice": "קליטת חשבונית לקריאה",
  "POST /service-requests/:id/close": "סגירת קריאה",
  "POST /supplier-invoices": "קליטת חשבונית ספק",
  "POST /sync/:id/retry": "שליחה חוזרת ל-Planfix",
  "POST /users": "יצירת משתמש",
  "POST /users/:id": "עדכון משתמש",
  "POST /import/planfix": "ייבוא מ-Planfix",
};

async function auditView() {
  const { entries } = await api("GET", "/audit");
  view.innerHTML = `
    <h1>יומן פעולות</h1><p class="sub">כל שינוי וכל ניסיון כניסה, כולל פעולות שנחסמו. 100 האחרונים.</p>
    ${
      entries.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>מתי</th><th>מי</th><th>פעולה</th><th>תוצאה</th></tr></thead><tbody>${entries
            .map(
              (e) => `<tr><td>${new Date(e.created_at).toLocaleString("he-IL")}</td>
              <td>${esc(e.user_name || e.detail?.email || "—")}</td>
              <td>${esc(AUDIT_ACTION[e.action] || e.action)}</td>
              <td>${e.ok ? pill(["בוצע", "good"]) : pill([e.detail?.status === 403 ? "נחסם: אין הרשאה" : "נכשל", "bad"])}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">היומן ריק</div>`
    }`;
}

function showUser() {
  document.querySelectorAll(".nav[data-perm]").forEach((a) => (a.hidden = !allowed(a.dataset.perm)));
  const box = document.createElement("div");
  box.className = "me";
  box.innerHTML = `${esc(me.name)}<small>${esc(me.roleLabel)}</small><button type="button">יציאה</button>`;
  box.querySelector("button").onclick = async () => {
    await api("POST", "/auth/logout");
    location.reload();
  };
  document.querySelector(".rail").append(box);
}

// ---------- routing ----------

async function refreshCounts() {
  try {
    const { counts } = await api("GET", "/work-center");
    document.getElementById("cnt-work").textContent = counts.open_requests + counts.sync_failed || "";
    document.getElementById("cnt-req").textContent = counts.open_requests || "";
    document.getElementById("cnt-sync").textContent = counts.sync_failed || "";
  } catch {
    // counts are a convenience; the page still works without them
  }
}

async function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [, section, id] = hash.split("/");
  document.querySelectorAll(".nav").forEach((a) => {
    const target = a.getAttribute("href").replace(/^#/, "").split("/")[1];
    const current = section === "properties" ? "apartments" : section || "";
    a.toggleAttribute("aria-current", target === current);
    if (target === current) a.setAttribute("aria-current", "page");
  });
  try {
    if (!section) await workCenterView();
    else if (section === "apartments") await apartmentsView();
    else if (section === "clients" && id) await clientView(id);
    else if (section === "clients") await clientsView();
    else if (section === "properties" && id) await propertyView(id);
    else if (section === "requests" && id) await requestView(id);
    else if (section === "requests") await requestsView();
    else if (section === "invoices") await invoicesView();
    else if (section === "sync") await syncView();
    else if (section === "users") await usersView();
    else if (section === "audit") await auditView();
    else view.innerHTML = `<div class="empty">הדף לא נמצא</div>`;
  } catch (err) {
    view.innerHTML = `<div class="empty">לא הצלחתי לטעון: ${esc(err.message)}</div>`;
  }
  refreshCounts();
}

async function start() {
  try {
    me = await api("GET", "/auth/me");
  } catch {
    return; // not signed in: api() has shown the login form
  }
  showUser();
  wireSearch();
  window.addEventListener("hashchange", route);
  route();
}

start();
