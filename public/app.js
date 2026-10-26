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
const URGENCY = { emergency: ["חירום", "bad"], high: ["גבוהה", "warn"], normal: ["רגילה", ""], low: ["נמוכה", ""] };
const CATEGORY = {
  plumbing: "אינסטלציה",
  electricity: "חשמל",
  ac: "מיזוג אוויר",
  water_heater: "דוד ומים חמים",
  appliances: "מכשירי חשמל",
  carpentry: "נגרות ודלתות",
  locks: "מנעולים ומפתחות",
  paint: "צבע וטיח",
  pests: "הדברה",
  cleaning: "ניקיון",
  other: "אחר",
};
// Urgency is shown only when it is not the usual.
const urgencyPill = (u) => (u && u !== "normal" ? pill(URGENCY[u]) : "");
const options = (entries, selected) =>
  entries.map(([k, label]) => `<option value="${k}" ${k === selected ? "selected" : ""}>${esc(label)}</option>`).join("");
const CHARGE = { client: "הלקוח", owner: "בעל הדירה", maglard: "מגלארד" };
const SYNC = { synced: ["סונכרן ל-Planfix", "good"], pending: ["ממתין לסנכרון", "warn"], failed: ["סנכרון נכשל", "bad"] };
const JOB = {
  "engagement.push": "קליטת דירה",
  "supplier_invoice.push": "חשבונית ספק",
  "service_request.sync": "קריאת שירות",
  "engagement.repush": "עדכון התקשרות",
  "property.repush": "עדכון דירה",
};
const FIELD_LABEL = {
  base_number: "מספר בסיס",
  address: "כתובת",
  owner: "בעל הדירה",
  client: "לקוח",
  apartment_code: "קוד דירה",
  starts_on: "תחילת התקשרות",
  ends_on: "סוף התקשרות",
  move_in_on: "תאריך כניסה",
  monthly_rent: "שכ״ד חודשי",
  status: "סטטוס",
};

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
    case "triage": {
      const cost = r.approval?.status ?? (r.awaiting_approval ? "pending" : "none");
      if (r.charge_to === "client" && !r.client_approved_at) {
        return { text: "העבודה על חשבון הלקוח: צריך את אישור הלקוח לפני שהספק מתחיל", action: "approve", label: "רישום אישור לקוח" };
      }
      if (cost === "pending") {
        return { text: "העלות מעל סף האישור: ממתין לאישור מנהל", action: "decide", label: "לתיבת האישורים" };
      }
      if (cost === "rejected") return { text: "המנהל דחה את העלות: לבחור ספק או הצעה אחרת", action: "assign", label: "שיוך מחדש" };
      return { text: "לבחור ספק", action: "assign", label: "שיוך ספק" };
    }
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
      `<label>סוג תקלה<select name="category">${options(Object.entries(CATEGORY), "other")}</select></label>` +
      `<label>דחיפות<select name="urgency">${options(Object.entries(URGENCY).map(([k, [l]]) => [k, l]), "normal")}</select></label>` +
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
  if (action === "decide") {
    location.hash = "#/approvals";
  } else if (action === "assign") {
    const [supplier, { approvalThreshold }] = await Promise.all([
      contactField("supplier", "ספק מטפל", "supplier"),
      api("GET", "/settings"),
    ]);
    const d = dialog(
      "שיוך ספק",
      supplier.html +
        `<label>על חשבון מי<select name="chargeTo" required>
          <option value="client">הלקוח</option><option value="owner">בעל הדירה</option><option value="maglard">מגלארד</option>
        </select></label>` +
        field("estimatedCost", "עלות משוערת כולל מע״מ", 'type="number" required min="0" step="0.01"') +
        `<label class="full" id="reason-box" hidden>מעל סף האישור (${money(approvalThreshold)}): למה החריגה נחוצה?
          <textarea name="reason" rows="2"></textarea></label>`,
      async (v) => {
        const res = await api("POST", `${base}/assign`, {
          supplier: supplier.resolve(v.supplier),
          chargeTo: v.chargeTo,
          estimatedCost: Number(v.estimatedCost),
          reason: v.reason?.trim() || undefined,
        });
        done(
          res.approval === "pending"
            ? "נשמר. ממתין לאישור מנהל על החריגה."
            : res.status === "triage"
              ? "נשמר. ממתין לאישור הלקוח."
              : "הקריאה עברה לספק",
        );
      },
    );
    const cost = d.querySelector('[name="estimatedCost"]');
    const box = d.querySelector("#reason-box");
    cost.addEventListener("input", () => {
      const over = Number(cost.value) > approvalThreshold;
      box.hidden = !over;
      box.querySelector("textarea").required = over;
    });
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

// A number on the work center that opens the list it was counted from.
const kpi = (n, label, href, tone = "") =>
  `<a class="kpi ${tone}" href="${href}"><b>${n}</b><span>${esc(label)}</span></a>`;

function taskCard(t) {
  return `<div class="card"><div class="grow"><b><a href="#/tasks/${t.id}">${esc(t.title)}</a></b>
    ${t.urgent ? pill(["דחוף", "bad"]) : ""} ${t.overdue ? pill(["באיחור", "bad"]) : ""}<br>
    <small>${t.due_on ? `עד ${date(t.due_on)}` : "ללא מועד"}${t.apartment_code ? ` · דירה ${esc(t.apartment_code)}` : ""}</small></div>
    <a class="btn" href="#/tasks/${t.id}">פתיחה</a></div>`;
}

async function workCenterView() {
  const w = await api("GET", "/work-center");
  const c = w.counts;
  const hour = new Date().getHours();
  const hello = hour < 12 ? "בוקר טוב" : hour < 18 ? "צהריים טובים" : "ערב טוב";
  const requests = w.requests.map((r) => {
    const n = nextStep(r);
    return `<div class="card"><div class="grow"><b>${esc(r.subject)}</b> ${pill(STATUS[r.status])} ${urgencyPill(r.urgency)}<br>
      <small>${esc(r.apartment_code)} · ${esc(r.address)} · נפתחה ${date(r.created_at)}</small><br>${esc(n.text)}</div>
      <a class="btn primary" href="#/requests/${r.id}">${esc(n.label)}</a></div>`;
  });
  view.innerHTML = `
    <div class="head"><div><h1>${hello}, ${esc(me.name)}</h1>
    <p class="sub">מה עליך לעשות, מה דחוף, ומה מחכה למישהו אחר.</p></div>
    <div class="actions" style="margin:0">
      <button class="btn primary" id="new-task">משימה חדשה</button>
      ${allowed("requests.manage") ? `<button class="btn" id="new-req">קריאת שירות</button>` : ""}
    </div></div>
    <div class="kpis">
      ${kpi(c.my_today, "המשימות שלי להיום", "#/tasks?filter=mine")}
      ${kpi(c.my_overdue, "באיחור", "#/tasks?filter=overdue", c.my_overdue ? "bad" : "")}
      ${kpi(c.my_urgent, "דחופות", "#/tasks?filter=urgent", c.my_urgent ? "bad" : "")}
      ${allowed("requests.view") && c.emergencies ? kpi(c.emergencies, "קריאות חירום פתוחות", "#/requests", "bad") : ""}
      ${allowed("approvals.decide") ? kpi(c.pending_approvals, "חריגות לאישורך", "#/approvals", c.pending_approvals ? "warn" : "") : ""}
      ${allowed("sync.resolve") && c.planfix_conflicts ? kpi(c.planfix_conflicts, "התנגשויות מול Planfix", "#/sync", "warn") : ""}
      ${allowed("requests.view") ? kpi(c.awaiting_client, "ממתינות לאישור לקוח", "#/requests") : ""}
      ${allowed("requests.view") ? kpi(c.open_requests, "קריאות שירות פתוחות", "#/requests") : ""}
    </div>
    <h2>המשימות הבאות שלי</h2>
    ${w.myTasks.length ? w.myTasks.map(taskCard).join("") : `<div class="empty">אין לך משימות פתוחות</div>`}
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
    ${allowed("requests.view") ? `<h2>קריאות שמחכות לפעולה</h2>${requests.length ? requests.join("") : `<div class="empty">אין קריאות פתוחות</div>`}` : ""}
    ${w.workload ? teamSection(w) : ""}
    ${w.company ? companySection(w.company) : ""}`;
  view.querySelector("#new-task").onclick = () => newTaskDialog();
  view.querySelector("#new-req")?.addEventListener("click", () => newRequestDialog());
}

// Department manager and up: who carries what, and what has not moved.
function teamSection(w) {
  const pct = (u) => (u.done_30d ? `${Math.round((100 * u.on_time_30d) / u.done_30d)}%` : "—");
  return `<h2>הצוות</h2>
    <div class="wrap"><table class="table"><thead><tr><th>עובד</th><th>משימות פתוחות</th><th>באיחור</th><th>הושלמו ב-30 יום</th><th>בזמן</th></tr></thead><tbody>${w.workload
      .map(
        (u) => `<tr><td>${esc(u.name)}</td><td>${u.open}</td><td>${u.overdue ? pill([String(u.overdue), "bad"]) : "0"}</td>
        <td>${u.done_30d}</td><td>${pct(u)}</td></tr>`,
      )
      .join("")}</tbody></table></div>
    <h2>קריאות תקועות (לא זזו 3 ימים)</h2>
    ${
      w.stuck.length
        ? w.stuck
            .map(
              (r) => `<div class="card"><div class="grow"><b>${esc(r.subject)}</b> ${pill(STATUS[r.status])}<br>
              <small>דירה ${esc(r.apartment_code)} · שינוי אחרון ${date(r.last_move)}</small></div>
              <a class="btn" href="#/requests/${r.id}">פתיחה</a></div>`,
            )
            .join("")
        : `<div class="empty">אין קריאות תקועות</div>`
    }`;
}

// Management: the company at a glance.
function companySection(co) {
  return `<h2>החברה</h2>
    <div class="kpis">
      ${kpi(co.active_properties, "דירות בהתקשרות בתוקף", "#/apartments")}
      ${kpi(co.active_clients, "לקוחות פעילים", "#/clients")}
      ${kpi(co.ending.length, "חוזים שמסתיימים ב-90 יום", "#/apartments", co.ending.length ? "warn" : "")}
    </div>
    ${
      co.ending.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>דירה</th><th>כתובת</th><th>לקוח</th><th>מסתיים</th></tr></thead><tbody>${co.ending
            .map(
              (e) => `<tr><td>${esc(e.apartment_code)}</td><td><a href="#/properties/${e.property_id}">${esc(e.address)}</a></td>
              <td>${esc(e.client_name)}</td><td>${date(e.ends_on)}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : ""
    }`;
}

// ---------- tasks ----------

const TASK_STATUS = { open: ["פתוחה", "warn"], in_progress: ["בטיפול", ""], done: ["הושלמה", "good"] };

async function newTaskDialog(prefill = {}) {
  const team = await api("GET", "/team");
  const assignees = team
    .map((u) => `<option value="${u.id}" ${u.id === me.id ? "selected" : ""}>${esc(u.name)}${u.id === me.id ? " (אני)" : ""}</option>`)
    .join("");
  dialog(
    "משימה חדשה",
    field("title", "מה צריך לעשות", "required", true) +
      `<label>אחראי<select name="assigneeId">${assignees}</select></label>` +
      field("dueOn", "עד מתי", 'type="date"') +
      `<label class="full">פירוט<textarea name="description" rows="3"></textarea></label>` +
      `<label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" name="urgent" value="1"> דחוף</label>`,
    async (v) => {
      const { id } = await api("POST", "/tasks", {
        title: v.title,
        assigneeId: v.assigneeId,
        dueOn: v.dueOn || undefined,
        description: v.description || undefined,
        urgent: v.urgent === "1",
        ...prefill,
      });
      toast("המשימה נוצרה");
      location.hash = `#/tasks/${id}`;
    },
    "יצירה",
  );
}

async function tasksView(params) {
  const filter = params.get("filter") || "mine";
  const rows = await api("GET", `/tasks?filter=${encodeURIComponent(filter)}`);
  const tabs = [
    ["mine", "שלי"],
    ["overdue", "באיחור"],
    ["urgent", "דחופות"],
    ...(allowed("tasks.manage_all") ? [["all", "של כולם"]] : []),
    ["done", "הושלמו"],
  ];
  view.innerHTML = `
    <div class="head"><div><h1>משימות</h1><p class="sub">${
      allowed("tasks.manage_all") ? "המשימות שלך ושל הצוות." : "המשימות שלך."
    }</p></div><button class="btn primary" id="add">משימה חדשה</button></div>
    <div class="tabs">${tabs
      .map(([k, label]) => `<a class="btn ${k === filter ? "primary" : ""}" href="#/tasks?filter=${k}">${label}</a>`)
      .join("")}</div>
    ${
      rows.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>משימה</th><th>אחראי</th><th>עד</th><th>סטטוס</th><th>דירה</th></tr></thead><tbody>${rows
            .map(
              (t) => `<tr class="click" data-href="#/tasks/${t.id}" tabindex="0"><td>${esc(t.title)} ${t.urgent ? pill(["דחוף", "bad"]) : ""}</td>
              <td>${esc(t.assignee_name)}</td><td>${t.due_on ? date(t.due_on) : "—"} ${t.overdue ? pill(["באיחור", "bad"]) : ""}</td>
              <td>${pill(TASK_STATUS[t.status])}</td><td>${esc(t.apartment_code || "")}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">אין משימות כאן</div>`
    }`;
  view.querySelector("#add").onclick = () => newTaskDialog();
  clickableRows();
}

async function taskView(id) {
  const t = await api("GET", `/tasks/${id}`);
  const team = await api("GET", "/team");
  const next = { open: ["in_progress", "התחלת טיפול"], in_progress: ["done", "סימון כהושלמה"], done: ["open", "פתיחה מחדש"] }[t.status];
  view.innerHTML = `
    <p><a href="#/tasks">→ כל המשימות</a></p>
    <h1>${esc(t.title)}</h1>
    <p class="sub">${pill(TASK_STATUS[t.status])} ${t.urgent ? pill(["דחוף", "bad"]) : ""} ${t.overdue ? pill(["באיחור", "bad"]) : ""}</p>
    <div class="next"><div class="grow" style="flex:1">אחראי: <b>${esc(t.assignee_name)}</b> · ${t.due_on ? `עד ${date(t.due_on)}` : "ללא מועד"}
      ${t.apartment_code ? ` · <a href="#/properties/${t.property_id}">דירה ${esc(t.apartment_code)}</a>` : ""}
      ${t.service_request_id ? ` · <a href="#/requests/${t.service_request_id}">הקריאה</a>` : ""}</div>
      <button class="btn primary" id="advance">${next[1]}</button></div>
    ${t.description ? `<p>${esc(t.description)}</p>` : ""}
    <div class="facts">
      <div><span>העברה לאחראי אחר</span><select id="assignee">${team
        .map((u) => `<option value="${u.id}" ${u.id === t.assignee_id ? "selected" : ""}>${esc(u.name)}</option>`)
        .join("")}</select></div>
      <div><span>מועד יעד</span><input type="date" id="due" value="${t.due_on || ""}"></div>
    </div>
    ${await filesSection("task", t.id, true)}
    <h2>הערות והיסטוריה</h2>
    <ul class="timeline">${t.notes
      .map(
        (n) => `<li>${n.system ? `<small>${esc(n.body)}</small>` : esc(n.body)}
        <small> · ${esc(n.user_name || "")} · ${new Date(n.created_at).toLocaleString("he-IL")}</small></li>`,
      )
      .join("")}</ul>
    <form id="note" class="card" style="margin-top:12px"><input name="body" class="grow" placeholder="הערה פנימית" required>
      <button class="btn">הוספה</button></form>`;
  const change = async (body, msg) => {
    try {
      await api("POST", `/tasks/${id}`, body);
      toast(msg);
    } catch (err) {
      toast(err.message);
    }
    route();
  };
  wireFiles();
  view.querySelector("#advance").onclick = () => change({ status: next[0] }, "עודכן");
  view.querySelector("#assignee").onchange = (e) => change({ assigneeId: e.target.value }, "המשימה הועברה");
  view.querySelector("#due").onchange = (e) => change({ dueOn: e.target.value || null }, "המועד עודכן");
  view.querySelector("#note").onsubmit = async (e) => {
    e.preventDefault();
    const body = new FormData(e.target).get("body");
    if (!String(body).trim()) return;
    try {
      await api("POST", `/tasks/${id}/notes`, { body });
    } catch (err) {
      return toast(err.message);
    }
    route();
  };
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
        ? `<div class="wrap"><table class="table"><thead><tr><th>נושא</th><th>סוג</th><th>דירה</th><th>סטטוס</th><th>על חשבון</th>
          <th>ספק</th><th>נפתחה</th></tr></thead><tbody>${rows
            .map(
              (r) => `<tr class="click" data-id="${r.id}" tabindex="0"><td>${esc(r.subject)} ${urgencyPill(r.urgency)}</td>
              <td>${esc(CATEGORY[r.category] || "")}</td>
              <td>${esc(r.apartment_code)}</td><td>${pill(STATUS[r.status])} ${r.awaiting_approval ? pill(["ממתין לאישור חריגה", "warn"]) : ""}</td><td>${esc(CHARGE[r.charge_to] || "")}</td>
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
  const needs = { invoice: "invoices.create", decide: "approvals.decide" }[step?.action] || "requests.manage";
  const mayAct = step && allowed(needs) && !(step.action === "decide" && r.approval?.requested_by === me.id);
  const n = step && { ...step, label: mayAct ? step.label : null };
  const a = r.approval;
  const APPROVAL = { pending: ["ממתין לאישור", "warn"], approved: ["אושרה", "good"], rejected: ["נדחתה", "bad"] };
  view.innerHTML = `
    <p><a href="#/requests">→ כל הקריאות</a></p>
    <h1>${esc(r.subject)}</h1>
    <p class="sub">${pill(STATUS[r.status])} ${urgencyPill(r.urgency)} · ${esc(CATEGORY[r.category] || "")} ·
      <a href="#/properties/${r.property_id}">${esc(r.apartment_code)} · ${esc(r.address)}</a> · פתח: ${esc(r.reported_by)} · ${date(r.created_at)}</p>
    ${n ? `<div class="next"><div class="grow" style="flex:1">${esc(n.text)}</div>${n.label ? `<button class="btn primary" id="next">${esc(n.label)}</button>` : ""}</div>` : ""}
    ${r.description ? `<p>${esc(r.description)}</p>` : ""}
    <div class="facts">
      <div><span>ספק</span><b>${r.supplier_id ? `<a href="#/suppliers/${r.supplier_id}">${esc(r.supplier_name)}</a>` : "טרם נבחר"}</b></div>
      <div><span>על חשבון</span><b>${esc(CHARGE[r.charge_to] || "טרם נקבע")}</b></div>
      <div><span>עלות משוערת</span><b>${r.estimated_cost == null ? "—" : money(r.estimated_cost)}</b></div>
      <div><span>אישור לקוח</span><b>${r.client_approved_at ? esc(r.client_approval_ref) : "—"}</b></div>
    </div>
    ${
      a
        ? `<div class="card"><div class="grow"><b>חריגה מסף האישור</b> ${pill(APPROVAL[a.status])}<br>
          <small>${money(a.amount)} מעל סף של ${money(a.threshold)} · ${esc(a.reason)}${
            a.decided_by_name ? ` · ${esc(a.decided_by_name)}${a.decision_note ? `: ${esc(a.decision_note)}` : ""}` : ""
          }</small></div></div>`
        : ""
    }
    ${await filesSection("service_request", r.id, allowed("requests.manage"))}
    <h2>היסטוריה</h2>
    <ul class="timeline">${r.events
      .map((e) => `<li>${esc(STATUS[e.to_status][0])} ${e.note ? `· ${esc(e.note)}` : ""} <small>${new Date(e.created_at).toLocaleString("he-IL")}</small></li>`)
      .join("")}</ul>`;
  view.querySelector("#next")?.addEventListener("click", () => stepDialog(r, n.action));
  wireFiles();
}

// ---------- files ----------

const FILE_TYPES = "image/jpeg,image/png,image/webp,image/heic,application/pdf,.docx,.xlsx";
const MIME_BY_EXT = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  heic: "image/heic",
};

// Photos and documents on a record. The server decides who may see and add them.
async function filesSection(type, id, canAdd) {
  const list = await api("GET", `/files/${type}/${id}`).catch(() => null);
  if (!list) return "";
  const kb = (n) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);
  return `<h2>תמונות ומסמכים</h2>
    <div class="files">${list
      .map((f) =>
        f.mime.startsWith("image/") && f.mime !== "image/heic"
          ? `<a class="thumb" href="/files/${f.id}" target="_blank" rel="noopener"><img src="/files/${f.id}" alt="${esc(f.filename)}" loading="lazy"><small>${esc(f.filename)}</small></a>`
          : `<a class="thumb doc" href="/files/${f.id}" target="_blank" rel="noopener"><b>${esc(f.filename.split(".").pop().toUpperCase())}</b><small>${esc(f.filename)} · ${kb(f.size)}</small></a>`,
      )
      .join("")}
    ${
      canAdd
        ? `<label class="thumb add">+ הוספת קובץ<input type="file" multiple accept="${FILE_TYPES}" data-upload="${type}/${id}" hidden></label>`
        : list.length
          ? ""
          : `<div class="empty">אין קבצים</div>`
    }</div>`;
}

function wireFiles() {
  view.querySelectorAll("[data-upload]").forEach((input) => {
    input.onchange = async () => {
      for (const file of input.files) {
        const type = file.type || MIME_BY_EXT[file.name.split(".").pop().toLowerCase()] || "application/octet-stream";
        const res = await fetch(`/files/${input.dataset.upload}`, {
          method: "POST",
          headers: { "Content-Type": type, "X-Filename": encodeURIComponent(file.name) },
          body: file,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast(`${file.name}: ${data.error || `שגיאה ${res.status}`}`);
          return route();
        }
      }
      toast(input.files.length > 1 ? "הקבצים נשמרו" : "הקובץ נשמר");
      route();
    };
  });
}

// ---------- approvals, suppliers, notifications ----------

async function approvalsView(params) {
  const which = params.get("which") === "decided" ? "decided" : "pending";
  const rows = await api("GET", `/approvals?which=${which}`);
  const { approvalThreshold } = await api("GET", "/settings");
  view.innerHTML = `
    <div class="head"><div><h1>אישורים</h1>
    <p class="sub">קריאות שירות שהעלות שלהן מעל סף האישור (${money(approvalThreshold)}). הספק מתחיל רק אחרי אישור.</p></div></div>
    <div class="tabs">
      <a class="btn ${which === "pending" ? "primary" : ""}" href="#/approvals">ממתינים</a>
      <a class="btn ${which === "decided" ? "primary" : ""}" href="#/approvals?which=decided">טופלו</a>
    </div>
    ${
      rows.length
        ? rows
            .map(
              (a) => `<div class="card"><div class="grow"><b><a href="#/requests/${a.service_request_id}">${esc(a.subject)}</a></b>
              ${urgencyPill(a.urgency)} · ${money(a.amount)}<br>
              <small>${esc(a.apartment_code)} · ${esc(a.address)} · ספק: ${esc(a.supplier_name || "")} · על חשבון ${esc(CHARGE[a.charge_to] || "")}
              · ביקש: ${esc(a.requested_by_name || "")}</small><br>${esc(a.reason)}
              ${a.decided_by_name ? `<br><small>${a.status === "approved" ? "אושרה" : "נדחתה"} על ידי ${esc(a.decided_by_name)} ${a.decision_note ? `: ${esc(a.decision_note)}` : ""}</small>` : ""}</div>
              ${
                which === "pending"
                  ? a.requested_by === me.id
                    ? `<small>ביקשת בעצמך: מנהל אחר יאשר</small>`
                    : `<button class="btn primary" data-approve="${a.id}">אישור</button><button class="btn" data-reject="${a.id}">דחייה</button>`
                  : ""
              }</div>`,
            )
            .join("")
        : `<div class="empty">${which === "pending" ? "אין בקשות שממתינות לאישור" : "עדיין לא טופלו בקשות"}</div>`
    }`;
  const decide = (id, decision) =>
    dialog(
      decision === "approved" ? "אישור החריגה" : "דחיית החריגה",
      `<label class="full">${decision === "approved" ? "הערה (לא חובה)" : "למה נדחתה? מה צריך לעשות?"}
        <textarea name="note" rows="2" ${decision === "rejected" ? "required" : ""}></textarea></label>`,
      async (v) => {
        await api("POST", `/approvals/${id}`, { decision, note: v.note?.trim() || undefined });
        toast(decision === "approved" ? "אושר. הקריאה עוברת לספק כשהיא מוכנה." : "נדחה. מי שביקש קיבל התראה.");
        route();
      },
      decision === "approved" ? "אישור" : "דחייה",
    );
  view.querySelectorAll("[data-approve]").forEach((b) => (b.onclick = () => decide(b.dataset.approve, "approved")));
  view.querySelectorAll("[data-reject]").forEach((b) => (b.onclick = () => decide(b.dataset.reject, "rejected")));
}

async function suppliersView() {
  const rows = await api("GET", "/suppliers");
  view.innerHTML = `
    <div class="head"><div><h1>ספקים</h1><p class="sub">ספקים וטכנאים, ועבודות פתוחות אצל כל אחד.</p></div></div>
    ${
      rows.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>ספק</th><th>עבודות פתוחות</th><th>עבודות שנסגרו</th><th>עבודה אחרונה</th></tr></thead><tbody>${rows
            .map(
              (s) => `<tr class="click" data-href="#/suppliers/${s.id}" tabindex="0"><td>${esc(s.name)}</td><td>${s.open_jobs}</td>
              <td>${s.closed_jobs}</td><td>${s.last_job ? date(s.last_job) : "—"}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">עדיין אין ספקים</div>`
    }`;
  clickableRows();
}

async function supplierView(id) {
  const s = await api("GET", `/suppliers/${id}`);
  view.innerHTML = `
    <p><a href="#/suppliers">→ כל הספקים</a></p>
    <h1>${esc(s.name)}</h1>
    <p class="sub">ספק${s.planfix_id ? ` · איש קשר ${s.planfix_id} ב-Planfix` : ""}</p>
    <div class="facts">
      <div><span>עבודות פתוחות</span><b>${s.open_jobs}</b></div>
      <div><span>עבודות שנסגרו</span><b>${s.closed_jobs}</b></div>
      <div><span>זמן ממוצע עד סגירה</span><b>${s.avg_days_to_close == null ? "—" : `${s.avg_days_to_close} ימים`}</b></div>
      <div><span>דירות שעבד בהן</span><b>${s.properties.length}</b></div>
    </div>
    <h2>קריאות שירות</h2>${requestsTable(s.requests)}
    ${invoicesTable(s.invoices)}
    <h2>דירות</h2>
    ${s.properties.length ? `<ul>${s.properties.map((p) => `<li><a href="#/properties/${p.id}">${esc(p.address)}</a> · ${p.jobs} קריאות</li>`).join("")}</ul>` : `<div class="empty">עדיין לא</div>`}`;
}

async function notificationsView() {
  const rows = await api("GET", "/notifications");
  view.innerHTML = `
    <div class="head"><div><h1>התראות</h1><p class="sub">משימות שהועברו אליך, אישורים, וקריאות חירום.</p></div>
    ${rows.some((n) => !n.read_at) ? `<button class="btn" id="read-all">סימון הכול כנקרא</button>` : ""}</div>
    ${
      rows.length
        ? rows
            .map(
              (n) => `<div class="card ${n.read_at ? "" : "unread"}"><div class="grow">${n.read_at ? "" : "● "}${esc(n.title)}<br>
              <small>${new Date(n.created_at).toLocaleString("he-IL")}</small></div>
              ${n.link ? `<a class="btn" href="${esc(n.link)}" data-read="${n.id}">פתיחה</a>` : ""}</div>`,
            )
            .join("")
        : `<div class="empty">אין התראות</div>`
    }`;
  view.querySelector("#read-all")?.addEventListener("click", async () => {
    await api("POST", "/notifications/read", {});
    route();
  });
  view.querySelectorAll("[data-read]").forEach((a) =>
    a.addEventListener("click", () => api("POST", "/notifications/read", { id: Number(a.dataset.read) }).catch(() => {})),
  );
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

// Changes made directly in Planfix: the conflicts that wait for a person,
// and what was applied on its own.
function readbackSection(rb) {
  const last = rb.lastRun;
  const when = last ? new Date(last.finished_at).toLocaleString("he-IL") : "עדיין לא";
  const resolver = allowed("sync.resolve");
  return `<h2>שינויים שנעשו ב-Planfix</h2>
    <div class="next"><div class="grow" style="flex:1">בדיקה אחרונה: ${esc(when)}${
      last ? (last.ok ? ` · נבדקו ${last.checked} רשומות` : ` · ${pill(["נכשלה", "bad"])} ${esc(last.error || "")}`) : ""
    }${last?.new_in_planfix ? ` · ${last.new_in_planfix} רשומות קיימות רק ב-Planfix (אפשר לייבא)` : ""}</div>
      ${allowed("sync.retry") ? `<button class="btn" id="readback-run">לבדוק עכשיו</button>` : ""}</div>
    ${
      rb.open.length
        ? rb.open
            .map(
              (c) => `<div class="card"><div class="grow"><b>${esc(c.entity_label || "")}</b> · ${esc(FIELD_LABEL[c.field] || c.field)}<br>
              במערכת: <b>${esc(c.local_label)}</b> · ב-Planfix: <b>${esc(c.remote_label)}</b><br><small>${esc(c.note || "")}</small></div>
              ${
                resolver
                  ? `<button class="btn primary" data-choice="remote" data-change="${c.id}">לקבל מ-Planfix</button>
                     <button class="btn" data-choice="local" data-change="${c.id}">להשאיר ולעדכן את Planfix</button>`
                  : ""
              }</div>`,
            )
            .join("")
        : `<div class="empty">אין התנגשויות שממתינות להחלטה</div>`
    }
    ${
      rb.recent.length
        ? `<details><summary>שינויים אחרונים (${rb.recent.length})</summary><div class="wrap"><table class="table"><thead><tr><th>רשומה</th><th>שדה</th><th>היה</th><th>עכשיו ב-Planfix</th><th>מה נעשה</th><th>מתי</th></tr></thead><tbody>${rb.recent
            .map(
              (c) => `<tr><td>${esc(c.entity_label || "")}</td><td>${esc(FIELD_LABEL[c.field] || c.field)}</td><td>${esc(c.local_label)}</td>
              <td>${esc(c.remote_label)}</td><td>${esc(
                { applied: "נקלט אוטומטית", took_remote: "התקבל מ-Planfix", kept_local: "נשאר ערך המערכת", settled: "הערכים התיישרו" }[c.status],
              )}${c.resolved_by_name ? ` · ${esc(c.resolved_by_name)}` : ""}</td><td>${new Date(c.updated_at).toLocaleString("he-IL")}</td></tr>`,
            )
            .join("")}</tbody></table></div></details>`
        : ""
    }`;
}

function wireReadback() {
  view.querySelector("#readback-run")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const r = await api("POST", "/readback/run");
      toast(r.skipped ? "בדיקה אחרת כבר רצה" : `נבדק. נקלטו ${r.applied}, להחלטה ${r.conflicts}`);
    } catch (err) {
      toast(err.message);
    }
    route();
  });
  view.querySelectorAll("[data-change]").forEach((b) => {
    b.onclick = async () => {
      try {
        await api("POST", `/readback/changes/${b.dataset.change}`, { choice: b.dataset.choice });
        toast(b.dataset.choice === "remote" ? "הערך מ-Planfix נקלט" : "נשאר ערך המערכת, ו-Planfix יעודכן");
      } catch (err) {
        toast(err.message);
      }
      route();
    };
  });
}

async function syncView() {
  const [{ jobs }, rb] = await Promise.all([api("GET", "/sync/status"), api("GET", "/readback")]);
  const tone = { done: ["הושלם", "good"], pending: ["ממתין", "warn"], running: ["רץ", "warn"], failed: ["נכשל", "bad"] };
  view.innerHTML = `
    <h1>סנכרון Planfix</h1><p class="sub">כל פעולה נשמרת קודם כאן ונשלחת ל-Planfix ברקע. פעולה שנכשלה אפשר לשלוח שוב.</p>
    ${readbackSection(rb)}
    ${importCard()}
    <h2>שליחות ל-Planfix</h2>
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
  wireReadback();
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
      (r) => `<tr><td><a href="#/requests/${r.id}">${esc(r.subject)}</a> ${urgencyPill(r.urgency)}</td><td>${esc(r.apartment_code)}</td>
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
    <div class="actions" style="margin:0">
      ${allowed("requests.manage") && current ? `<button class="btn primary" id="new-req">פתיחת קריאת שירות</button>` : ""}
      ${current ? `<button class="btn" id="new-task">משימה לדירה</button>` : ""}
    </div></div>
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
    ${p.suppliers.length ? `<ul>${p.suppliers.map((s) => `<li><a href="#/suppliers/${s.id}">${esc(s.name)}</a> · ${s.jobs} קריאות</li>`).join("")}</ul>` : `<div class="empty">עדיין לא</div>`}
    ${await filesSection("property", p.id, allowed("requests.manage") || allowed("apartments.create"))}
    ${
      p.engagements.length > 1
        ? `<h2>התקשרויות קודמות</h2><ul>${p.engagements
            .filter((e) => e !== current)
            .map((e) => `<li>${esc(e.client_name)} · ${period(e)}</li>`)
            .join("")}</ul>`
        : ""
    }`;
  wireFiles();
  view.querySelector("#new-req")?.addEventListener("click", () => newRequestDialog(current.id));
  view.querySelector("#new-task")?.addEventListener("click", () => newTaskDialog({ engagementId: current.id }));
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
  supplier: (id) => `#/suppliers/${id}`,
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
  const [{ users, roles }, settings] = await Promise.all([api("GET", "/users"), api("GET", "/settings")]);
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
      .join("")}</tbody></table></div>
    <h2>הגדרות</h2>
    <form id="settings" class="card"><label class="grow">סף אישור לעלות קריאת שירות (₪, כולל מע״מ). מעליו נדרשים נימוק ואישור מנהל.
      <input name="approvalThreshold" type="number" min="0" step="1" required value="${settings.approvalThreshold}"></label>
      <button class="btn">שמירה</button></form>`;
  view.querySelector("#settings").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("POST", "/settings", { approvalThreshold: Number(new FormData(e.target).get("approvalThreshold")) });
      toast("סף האישור עודכן");
    } catch (err) {
      toast(err.message);
    }
  };
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
  "POST /tasks": "יצירת משימה",
  "POST /tasks/:id": "עדכון משימה",
  "POST /tasks/:id/notes": "הערה במשימה",
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
    document.getElementById("cnt-work").textContent = counts.my_urgent || "";
    document.getElementById("cnt-tasks").textContent = counts.my_open || "";
    document.getElementById("cnt-req").textContent = counts.open_requests || "";
    document.getElementById("cnt-sync").textContent = counts.sync_failed + (allowed("sync.view") ? counts.planfix_conflicts : 0) || "";
    document.getElementById("cnt-approvals").textContent = counts.pending_approvals || "";
    document.getElementById("cnt-notif").textContent = counts.unread || "";
  } catch {
    // counts are a convenience; the page still works without them
  }
}

async function route() {
  const [path, query] = (location.hash.replace(/^#/, "") || "/").split("?");
  const params = new URLSearchParams(query || "");
  const [, section, id] = path.split("/");
  document.querySelectorAll(".nav").forEach((a) => {
    const target = a.getAttribute("href").replace(/^#/, "").split("?")[0].split("/")[1];
    const current = section === "properties" ? "apartments" : section || "";
    a.toggleAttribute("aria-current", target === current);
    if (target === current) a.setAttribute("aria-current", "page");
  });
  try {
    if (!section) await workCenterView();
    else if (section === "apartments") await apartmentsView();
    else if (section === "tasks" && id) await taskView(id);
    else if (section === "tasks") await tasksView(params);
    else if (section === "clients" && id) await clientView(id);
    else if (section === "clients") await clientsView();
    else if (section === "properties" && id) await propertyView(id);
    else if (section === "requests" && id) await requestView(id);
    else if (section === "requests") await requestsView();
    else if (section === "invoices") await invoicesView();
    else if (section === "suppliers" && id) await supplierView(id);
    else if (section === "suppliers") await suppliersView();
    else if (section === "approvals") await approvalsView(params);
    else if (section === "notifications") await notificationsView();
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
