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
const JOB = { "engagement.push": "קליטת דירה", "supplier_invoice.push": "חשבונית ספק" };

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

async function newRequestDialog() {
  const engagements = await api("GET", "/engagements");
  if (!engagements.length) return toast("קודם צריך לקלוט דירה");
  dialog(
    "פתיחת קריאת שירות",
    `<label class="full">דירה<select name="engagementId" required>${engagements
      .map((e) => `<option value="${e.id}">${esc(e.apartment_code)} — ${esc(e.address)}</option>`)
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
              <small>${esc(f.last_error)}</small></div><a class="btn" href="#/sync">לטיפול</a></div>`,
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
    <button class="btn primary" id="add">קליטת דירה</button></div>
    ${
      rows.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>קוד</th><th>כתובת</th><th>בעל דירה</th><th>לקוח</th>
          <th>תקופה</th><th>שכ״ד</th><th>Planfix</th></tr></thead><tbody>${rows
            .map(
              (e) => `<tr><td>${esc(e.apartment_code)}</td><td>${esc(e.address)}</td><td>${esc(e.owner_name)}</td>
              <td>${esc(e.client_name)}</td><td>${date(e.starts_on)}–${date(e.ends_on)}</td><td>${money(e.monthly_rent)}</td>
              <td>${pill(SYNC[e.sync])}${e.planfix_task_id ? ` <small>#${e.planfix_task_id}</small>` : ""}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">עדיין אין דירות. התחל בקליטת דירה.</div>`
    }`;
  view.querySelector("#add").onclick = intakeDialog;
}

async function requestsView() {
  const rows = await api("GET", "/service-requests");
  view.innerHTML = `
    <div class="head"><div><h1>קריאות שירות</h1><p class="sub">תקלות וקריאות, כולל עבודה לחיוב הלקוח.</p></div>
    <button class="btn primary" id="add">קריאה חדשה</button></div>
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
  view.querySelector("#add").onclick = newRequestDialog;
  view.querySelectorAll("tr.click").forEach((tr) => {
    const go = () => (location.hash = `#/requests/${tr.dataset.id}`);
    tr.onclick = go;
    tr.onkeydown = (e) => e.key === "Enter" && go();
  });
}

async function requestView(id) {
  const r = await api("GET", `/service-requests/${id}`);
  const n = nextStep(r);
  view.innerHTML = `
    <p><a href="#/requests">→ כל הקריאות</a></p>
    <h1>${esc(r.subject)}</h1>
    <p class="sub">${pill(STATUS[r.status])} · פתח: ${esc(r.reported_by)} · ${date(r.created_at)}</p>
    ${n ? `<div class="next"><div class="grow" style="flex:1">${esc(n.text)}</div><button class="btn primary" id="next">${esc(n.label)}</button></div>` : ""}
    ${r.description ? `<p>${esc(r.description)}</p>` : ""}
    <div class="kpis">
      <div class="kpi"><span>על חשבון</span><b style="font-size:18px">${esc(CHARGE[r.charge_to] || "טרם נקבע")}</b></div>
      <div class="kpi"><span>אישור לקוח</span><b style="font-size:18px">${r.client_approved_at ? esc(r.client_approval_ref) : "—"}</b></div>
    </div>
    <h2>היסטוריה</h2>
    <ul class="timeline">${r.events
      .map((e) => `<li>${esc(STATUS[e.to_status][0])} ${e.note ? `· ${esc(e.note)}` : ""} <small>${new Date(e.created_at).toLocaleString("he-IL")}</small></li>`)
      .join("")}</ul>`;
  if (n) view.querySelector("#next").onclick = () => stepDialog(r, n.action);
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

async function syncView() {
  const { jobs } = await api("GET", "/sync/status");
  const tone = { done: ["הושלם", "good"], pending: ["ממתין", "warn"], running: ["רץ", "warn"], failed: ["נכשל", "bad"] };
  view.innerHTML = `
    <h1>סנכרון Planfix</h1><p class="sub">כל פעולה נשמרת קודם כאן ונשלחת ל-Planfix ברקע. פעולה שנכשלה אפשר לשלוח שוב.</p>
    ${
      jobs.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>פעולה</th><th>מצב</th><th>ניסיונות</th><th>שגיאה</th><th>עודכן</th><th></th></tr></thead><tbody>${jobs
            .map(
              (j) => `<tr><td>${esc(JOB[j.job_type] || j.job_type)}</td><td>${pill(tone[j.status])}</td><td>${j.attempts}</td>
              <td><small>${esc(j.last_error || "")}</small></td><td>${new Date(j.updated_at).toLocaleString("he-IL")}</td>
              <td>${j.status === "failed" ? `<button class="btn" data-retry="${j.id}">שליחה חוזרת</button>` : ""}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">עדיין לא נשלח דבר ל-Planfix</div>`
    }`;
  view.querySelectorAll("[data-retry]").forEach((b) => {
    b.onclick = async () => {
      await api("POST", `/sync/${b.dataset.retry}/retry`);
      toast("נשלח שוב לתור");
      route();
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

async function showUser() {
  const me = await api("GET", "/auth/me").catch(() => null);
  if (!me) return;
  const box = document.createElement("div");
  box.className = "me";
  box.innerHTML = `${esc(me.name)}<br><button type="button">יציאה</button>`;
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
    a.toggleAttribute("aria-current", target === (section || ""));
    if (target === (section || "")) a.setAttribute("aria-current", "page");
  });
  try {
    if (!section) await workCenterView();
    else if (section === "apartments") await apartmentsView();
    else if (section === "requests" && id) await requestView(id);
    else if (section === "requests") await requestsView();
    else if (section === "invoices") await invoicesView();
    else if (section === "sync") await syncView();
    else view.innerHTML = `<div class="empty">הדף לא נמצא</div>`;
  } catch (err) {
    view.innerHTML = `<div class="empty">לא הצלחתי לטעון: ${esc(err.message)}</div>`;
  }
  refreshCounts();
}

window.addEventListener("hashchange", route);
route().then(showUser);
