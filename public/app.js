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
// Same list as the server (src/domain/contacts.ts).
const PAYMENT_TERMS = ["מיידי", "שוטף", "שוטף+15", "שוטף+30", "שוטף+45", "שוטף+60", "שוטף+90", "שוטף+120"];
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

// The client's approval covers the estimate when given for at least that amount.
const clientCovers = (r) => {
  const estimate = r.estimated_cost ?? r.approval_estimate;
  return Boolean(r.client_approved_at) && r.client_approved_amount != null && estimate != null && Number(r.client_approved_amount) >= Number(estimate);
};
const APPROVAL_METHOD = { email: "מייל", whatsapp: "וואטסאפ", phone: "טלפון", signed: "מסמך חתום", other: "אחר" };
// As the server lists them (src/domain/billing.ts).
const CREDIT_REASONS = ["טעות בחיוב", "יציאה מוקדמת", "זיכוי ספק שעובר ללקוח", "מחיקת הוצאה שלא תיגבה", "אחר"];
const REFUND_METHODS = ["העברה בנקאית", "צ׳ק", "מזומן", "כרטיס אשראי"];

// What the person should do next on a service request, and the button for it.
function nextStep(r) {
  switch (r.status) {
    case "new":
      return { text: "לבחור ספק ולקבוע על חשבון מי העבודה", action: "assign", label: "שיוך ספק" };
    case "triage": {
      const cost = r.approval?.status ?? (r.awaiting_approval ? "pending" : "none");
      if (r.charge_to === "client" && !clientCovers(r)) {
        return {
          text: r.client_approved_at
            ? "העלות מעל מה שהלקוח אישר: צריך אישור לקוח מחדש לפני שהספק מתחיל"
            : "העבודה על חשבון הלקוח: צריך את אישור הלקוח לפני שהספק מתחיל",
          action: "approve",
          label: "רישום אישור לקוח",
        };
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
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  d.setAttribute("aria-labelledby", titleId);
  d.innerHTML = `<form method="dialog" novalidate>
    <h3 id="${titleId}">${esc(title)}</h3>
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

// Picking the apartment a form acts on. Nothing is chosen until the user picks
// one (by code, address or client), unless the form was opened from that
// apartment. After a pick the full code, address and client are shown.
function apartmentPicker(list, preset) {
  const label = (e) => `${e.apartment_code} — ${e.address}${e.client_name ? ` — ${e.client_name}` : ""}`;
  const fixed = list.find((e) => e.id === preset);
  const html = fixed
    ? `<div class="full"><span class="sub">דירה</span><br><b>${esc(label(fixed))}</b><input type="hidden" name="engagementId" value="${fixed.id}"></div>`
    : `<label class="full">דירה<input name="apartment" list="dl-apartment" required autocomplete="off" placeholder="בחר דירה: הקלד קוד, כתובת או לקוח">
        <datalist id="dl-apartment">${list.map((e) => `<option value="${esc(label(e))}">`).join("")}</datalist></label>
       <input type="hidden" name="engagementId" value=""><p class="full sub" id="apartment-picked"></p>`;
  return {
    html,
    wire(d) {
      const input = d.querySelector("input[name=apartment]");
      if (!input) return;
      input.addEventListener("input", () => {
        const match = list.find((e) => label(e) === input.value.trim());
        d.querySelector("input[name=engagementId]").value = match?.id ?? "";
        d.querySelector("#apartment-picked").textContent = match
          ? `נבחרה דירה ${match.apartment_code} · ${match.address} · לקוח: ${match.client_name ?? "—"}`
          : input.value ? "יש לבחור דירה מהרשימה" : "";
      });
    },
    // The chosen engagement id, or an error the form shows.
    value(v) {
      if (!v.engagementId) throw new Error("צריך לבחור דירה מהרשימה");
      return v.engagementId;
    },
  };
}

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

// Opened from an apartment, the request is on it; from a client card, the
// list holds that client's apartments only.
async function newRequestDialog(engagementId, clientId) {
  const all = await api("GET", "/engagements");
  const engagements = clientId ? all.filter((e) => e.client_id === clientId) : all;
  if (!engagements.length) return toast("קודם צריך לקלוט דירה");
  const apartment = apartmentPicker(engagements, engagementId);
  const d = dialog(
    "פתיחת קריאת שירות",
    apartment.html +
      field("subject", "נושא התקלה", "required", true) +
      `<label>סוג תקלה<select name="category">${options(Object.entries(CATEGORY), "other")}</select></label>` +
      `<label>דחיפות<select name="urgency">${options(Object.entries(URGENCY).map(([k, [l]]) => [k, l]), "normal")}</select></label>` +
      field("reportedBy", "פותח הקריאה", "required") +
      `<label class="full">פירוט<textarea name="description" rows="3"></textarea></label>`,
    async (v) => {
      const { apartment: _, ...rest } = v;
      const { id } = await api("POST", "/service-requests", { ...rest, engagementId: apartment.value(v), description: v.description || undefined });
      toast("הקריאה נפתחה");
      location.hash = `#/requests/${id}`;
    },
    "פתיחה",
  );
  apartment.wire(d);
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
    dialog(
      "אישור לקוח לעבודה לחיוב",
      `<label>איך הלקוח אישר<select name="method">${options(Object.entries(APPROVAL_METHOD), "email")}</select></label>` +
        field("approverName", "מי אישר אצל הלקוח", 'required placeholder="שם ותפקיד"') +
        field(
          "amount",
          "הלקוח אישר עד סכום (₪, כולל מע״מ)",
          `type="number" min="0.01" step="0.01" required ${r.estimated_cost == null ? "" : `value="${r.estimated_cost}"`}`,
        ) +
        field("reference", "אסמכתה (מייל, הודעה, מסמך)", "required", true) +
        `<p class="full sub">אישור מנהל לחריגה אינו מחליף את אישור הלקוח. אם העלות תעלה מעל הסכום שאושר, יידרש אישור לקוח מחדש.</p>`,
      async (v) => {
        if (!v.approverName.trim()) throw new Error("צריך לרשום מי אישר אצל הלקוח");
        if (!(Number(v.amount) > 0)) throw new Error("צריך לרשום את הסכום שהלקוח אישר, כולל מע״מ");
        if (!v.reference.trim()) throw new Error("צריך אסמכתה: מייל, הודעה או מסמך");
        await api("POST", `${base}/client-approval`, { reference: v.reference, method: v.method, approverName: v.approverName, amount: Number(v.amount) });
        done("אישור הלקוח נרשם");
      },
    );
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
    ${welcomeCard()}
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
    ${allowed("requests.view") ? `<h2>קריאות שמחכות לפעולה</h2>${requests.length ? requests.join("") : `<div class="empty">אין קריאות פתוחות. קריאה חדשה נפתחת מכרטיס הדירה או מ"קריאות שירות".</div>`}
      ${c.open_requests > requests.length ? `<p class="sub">מוצגות ${requests.length} הדחופות מתוך ${c.open_requests} קריאות פתוחות. <a href="#/requests">לכל הקריאות</a></p>` : ""}` : ""}
    ${w.workload ? teamSection(w) : ""}
    ${w.company ? companySection(w.company) : ""}`;
  wireWelcome();
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

// The engagement's contract against today: in force, ended or not started.
const contractState = (e) => {
  const now = today();
  const from = String(e.starts_on).slice(0, 10);
  const to = String(e.ends_on).slice(0, 10);
  return to < now ? "ended" : from > now ? "future" : "active";
};
const CONTRACT = { active: ["חוזה בתוקף", "good"], ended: ["חוזה הסתיים", ""], future: ["חוזה עתידי", "warn"] };
const cityOf = (address) => (address || "").split(",").at(-1).trim();

async function apartmentsView(params) {
  const archived = params.get("archived") === "1";
  const rows = await api("GET", `/engagements${archived ? "?archived=1" : ""}`);
  const clients = [...new Map(rows.map((e) => [e.client_id, e.client_name])).entries()].sort((a, b) => a[1].localeCompare(b[1], "he"));
  const cities = [...new Set(rows.map((e) => cityOf(e.address)).filter(Boolean))].sort((a, b) => a.localeCompare(b, "he"));
  view.innerHTML = `
    <div class="head"><div><h1>דירות</h1><p class="sub">דירות בהתקשרות, מצב החוזה וסטטוס הסנכרון ל-Planfix.</p></div>
    ${allowed("apartments.create") ? `<button class="btn primary" id="add">קליטת דירה</button>` : ""}</div>
    ${archiveTabs("apartments", archived)}
    ${
      rows.length
        ? `<form class="filters" id="filters">
            <input name="q" type="search" placeholder="קוד, כתובת או בעל דירה" aria-label="חיפוש בדירות">
            <select name="client" aria-label="לקוח"><option value="">כל הלקוחות</option>${clients.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join("")}</select>
            <select name="city" aria-label="עיר"><option value="">כל הערים</option>${cities.map((c) => `<option>${esc(c)}</option>`).join("")}</select>
            <select name="state" aria-label="מצב חוזה"><option value="">כל מצבי החוזה</option>${Object.entries(CONTRACT).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join("")}</select>
            <select name="ends" aria-label="סיום חוזה"><option value="">כל מועדי הסיום</option><option value="30">מסתיים תוך 30 יום</option><option value="60">תוך 60 יום</option><option value="90">תוך 90 יום</option><option value="180">תוך חצי שנה</option></select>
            <button class="btn" type="reset">איפוס</button>
            <span class="sub" id="count"></span>
          </form><div id="apartment-rows"></div>`
        : `<div class="empty">${archived ? "אין דירות בארכיון" : "עדיין אין דירות. לוחצים \"קליטת דירה\" כדי לקלוט את הראשונה."}</div>`
    }`;
  view.querySelector("#add")?.addEventListener("click", intakeDialog);
  const form = view.querySelector("#filters");
  if (!form) return;
  const render = () => {
    const f = Object.fromEntries(new FormData(form));
    const q = f.q.trim().toLowerCase();
    const limit = f.ends ? new Date(Date.now() + Number(f.ends) * 86400000).toISOString().slice(0, 10) : null;
    const shown = rows.filter(
      (e) =>
        (!q || `${e.apartment_code} ${e.address} ${e.owner_name}`.toLowerCase().includes(q)) &&
        (!f.client || e.client_id === f.client) &&
        (!f.city || cityOf(e.address) === f.city) &&
        (!f.state || contractState(e) === f.state) &&
        (!limit || (contractState(e) !== "ended" && String(e.ends_on).slice(0, 10) <= limit)),
    );
    view.querySelector("#count").textContent = `${shown.length} מתוך ${rows.length}`;
    view.querySelector("#apartment-rows").innerHTML = shown.length
      ? `<div class="wrap"><table class="table stack"><thead><tr><th>קוד</th><th>כתובת</th><th>בעל דירה</th><th>לקוח</th>
          <th>תקופה</th><th>חוזה</th>${allowed("amounts.view") ? "<th>שכ״ד</th>" : ""}<th>Planfix</th></tr></thead><tbody>${shown
            .map(
              (e) => `<tr><td data-label="קוד">${esc(e.apartment_code)}</td><td data-label="כתובת"><a href="#/properties/${e.property_id}">${esc(e.address)}</a></td>
              <td data-label="בעל דירה">${esc(e.owner_name)}</td><td data-label="לקוח"><a href="#/clients/${e.client_id}">${esc(e.client_name)}</a></td>
              <td data-label="תקופה">${date(e.starts_on)}–${date(e.ends_on)}</td><td data-label="חוזה">${pill(CONTRACT[contractState(e)])}</td>
              ${allowed("amounts.view") ? `<td data-label="שכ״ד">${money(e.monthly_rent)}</td>` : ""}
              <td data-label="Planfix">${pill(SYNC[e.sync])}${e.planfix_task_id ? ` <small>#${e.planfix_task_id}</small>` : ""}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
      : `<div class="empty">אין דירות שמתאימות לסינון. אפשר ללחוץ "איפוס".</div>`;
  };
  form.addEventListener("input", render);
  form.addEventListener("reset", () => setTimeout(render));
  form.addEventListener("submit", (e) => e.preventDefault());
  render();
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
      <div><span>אישור מנהל לעלות</span><b>${a ? pill(APPROVAL[a.status]) : r.estimated_cost == null ? "—" : "לא נדרש (מתחת לסף)"}</b></div>
    </div>
    ${
      r.charge_to === "client"
        ? `<div class="card"><div class="grow"><b>אישור לקוח</b> ${
            clientCovers(r) ? pill(["אושר", "good"]) : r.client_approved_at ? pill(["נדרש אישור מחדש", "warn"]) : pill(["ממתין לאישור הלקוח", "warn"])
          }<br><small>${
            r.client_approved_at
              ? `${r.client_approver_name ? `${esc(r.client_approver_name)} אישר/ה ` : ""}עד ${money(r.client_approved_amount)} כולל מע״מ · ${esc(APPROVAL_METHOD[r.client_approval_method] || "")}: ${esc(r.client_approval_ref)} · נרשם על ידי ${esc(r.client_approved_by_name || "—")} · ${new Date(r.client_approved_at).toLocaleString("he-IL")}`
              : "העבודה על חשבון הלקוח. הספק לא מתחיל לפני אישור הלקוח."
          }</small></div></div>`
        : ""
    }
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

// ---------- client, owner and supplier cards ----------

const KIND_LABEL = { client: "לקוח", owner: "בעל דירה", supplier: "ספק" };
const yesNo = (v) => (v === true ? "כן" : v === false ? "לא" : "—");
const cardPill = (missing) => (missing.length ? pill(["לא מלא", "warn"]) : pill(["מלא", "good"]));

// The fields of each kind, in form order: [key, column, label, type, required].
function contactFields(kind) {
  const f = [
    ["name", "name", "שם", "text", true],
    ...(kind !== "owner" ? [["isCompany", "is_company", "סוג", "company", false]] : []),
    ["idNumber", "id_number", kind === "client" ? "ח.פ / ת.ז" : "ת.ז / ח.פ", "text", true],
    ["phone", "phone", "טלפון", "tel", false],
    ["email", "email", "דוא״ל", "email", false],
    ["address", "address", "כתובת", "text", false],
  ];
  if (kind === "client") {
    f.push(
      ["vatOnRent", "vat_on_rent", "מע״מ על שכירות", "bool", true],
      ["vatOnExpenses", "vat_on_expenses", "מע״מ על הוצאות (טכנאים, חשמל, מים וכד׳)", "bool", true],
      ["withholdingTax", "withholding_tax", "ניכוי מס במקור", "bool", true],
      ["withholdingRate", "withholding_rate", "שיעור ניכוי במקור (%)", "number", false],
      ["ledgerCard", "ledger_card", "מספר כרטיס", "text", true],
    );
  }
  if (kind === "owner") {
    f.push(
      ["licensedDealer", "licensed_dealer", "עוסק מורשה", "bool", true],
      ["withholdingCertUntil", "withholding_cert_until", "אישור ניכוי במקור בתוקף עד", "date", true],
      ["ledgerCard", "ledger_card", "מספר כרטיס", "text", true],
    );
  }
  if (kind === "supplier") {
    f.push(
      ["supplierType", "supplier_type", "סוג ספק", "text", true],
      ["serviceAreas", "service_areas", "תחומי שירות", "text", true],
      ["regions", "regions", "אזורים", "text", false],
      ["withholdingCertUntil", "withholding_cert_until", "אישור ניכוי במקור בתוקף עד", "date", true],
      ["paymentTerms", "payment_terms", "תנאי תשלום", "terms", true],
    );
  }
  if (kind !== "client" && allowed("bank.view")) {
    f.push(
      ["bankName", "bank_name", "בנק", "text", true],
      ["bankBranch", "bank_branch", "סניף", "text", true],
      ["bankAccount", "bank_account", "מספר חשבון", "text", true],
    );
  }
  f.push(["notes", "notes", "הערות", "textarea", false]);
  return f;
}

function contactDialog(kind, c, onSaved) {
  const input = ([key, col, label, type, required]) => {
    const v = c?.[col];
    // Only the name is needed to open the card; the starred fields complete it.
    const mark = key === "name" ? " (חובה)" : required ? " *" : "";
    if (type === "bool") {
      return `<label>${esc(label + mark)}<select name="${key}"><option value="">—</option>
        <option value="true" ${v === true ? "selected" : ""}>כן</option><option value="false" ${v === false ? "selected" : ""}>לא</option></select></label>`;
    }
    if (type === "company") {
      return `<label>${esc(label)}<select name="${key}"><option value="true" ${v !== false ? "selected" : ""}>תאגיד</option>
        <option value="false" ${v === false ? "selected" : ""}>פרטי</option></select></label>`;
    }
    if (type === "terms") {
      // A value saved before the list existed stays selectable.
      const terms = PAYMENT_TERMS.includes(v) || !v ? PAYMENT_TERMS : [v, ...PAYMENT_TERMS];
      return `<label>${esc(label + mark)}<select name="${key}"><option value="">—</option>${options(
        terms.map((t) => [t, t]),
        v,
      )}</select></label>`;
    }
    if (type === "textarea") return `<label class="full">${esc(label)}<textarea name="${key}" rows="2">${esc(v ?? "")}</textarea></label>`;
    const attrs = `type="${type}" value="${esc(v ?? "")}" ${key === "name" ? "required" : ""} ${type === "number" ? 'step="0.01" min="0" max="100"' : ""}`;
    return `<label>${esc(label + mark)}<input name="${key}" ${attrs}></label>`;
  };
  const fields = contactFields(kind);
  dialog(
    c ? `עריכת פרטי ${KIND_LABEL[kind]}` : `${KIND_LABEL[kind]} חדש`,
    fields.map(input).join("") + `<p class="full"><small>(חובה) נדרש כדי לפתוח את הכרטיס. * נדרש כדי שהכרטיס יהיה מלא: אפשר לשמור גם בלי, והכרטיס יסומן "לא מלא" עד שישלימו.</small></p>`,
    async (v) => {
      const body = {};
      for (const [key, , , type] of fields) {
        const raw = v[key];
        if (raw === undefined) continue;
        if (type === "bool" || type === "company") body[key] = raw === "" ? null : raw === "true";
        else if (type === "number") body[key] = raw === "" ? null : Number(raw);
        else body[key] = raw.trim() === "" ? null : raw.trim();
      }
      if (c) {
        // Bank details come masked for roles without bank access; never send the mask back.
        for (const k of ["bankName", "bankBranch", "bankAccount"]) if (body[k] === "•••") delete body[k];
        await api("POST", `/contacts/${c.id}`, body);
        toast("הפרטים נשמרו");
        onSaved?.(c.id);
      } else {
        const { id } = await api("POST", "/contacts", { kind, ...body });
        toast("הכרטיס נפתח");
        onSaved?.(id);
      }
    },
    c ? "שמירה" : "פתיחת כרטיס",
  );
}

// ---------- archive ----------

// Active cards or the archive, on top of each list.
const archiveTabs = (base, archived) => `
  <div class="tabs">
    <a class="btn ${archived ? "" : "primary"}" href="#/${base}" title="רשומות שלא הועברו לארכיון, בלי קשר למצב החוזה">לא בארכיון</a>
    <a class="btn ${archived ? "primary" : ""}" href="#/${base}?archived=1">ארכיון</a>
  </div>`;

// Archive, restore, and delete for a card opened by mistake. The server
// decides what is allowed; these buttons only follow it.
function recordActions(rec) {
  const archive = allowed("records.archive");
  const del = allowed("records.delete") && rec.deletable;
  return `
    ${rec.archived_at ? `<div class="missing"><b>בארכיון</b> מאז ${date(rec.archived_at)}. לא מופיע ברשימות ובחיפוש, וההיסטוריה נשמרת.</div>` : ""}
    ${
      archive || del
        ? `<p class="actions">${archive ? `<button class="btn" id="archive">${rec.archived_at ? "החזרה מהארכיון" : "העברה לארכיון"}</button>` : ""}
           ${del ? `<button class="btn" id="delete">מחיקה</button>` : ""}</p>`
        : ""
    }`;
}

function wireRecordActions(type, rec, back) {
  const base = type === "contact" ? "/contacts" : "/properties";
  view.querySelector("#archive")?.addEventListener("click", async () => {
    try {
      await api("POST", `${base}/${rec.id}/archive`, { archived: !rec.archived_at });
      toast(rec.archived_at ? "הוחזר מהארכיון" : "הועבר לארכיון");
      route();
    } catch (err) {
      toast(err.message);
    }
  });
  view.querySelector("#delete")?.addEventListener("click", () =>
    dialog(
      "מחיקת כרטיס",
      `<p class="full">${esc(rec.name ?? rec.address)} יימחק לצמיתות. אפשר למחוק רק כרטיס שנפתח בטעות: אין לו קישורים והוא לא נשלח ל-Planfix.</p>`,
      async () => {
        await api("POST", `${base}/${rec.id}/delete`);
        toast("הכרטיס נמחק");
        location.hash = back;
      },
      "מחיקה",
    ),
  );
}

// Details, missing fields and contact people, on the client, owner and supplier cards.
function contactSection(c) {
  const shown = contactFields(c.kind).filter(([key]) => key !== "name" && key !== "notes");
  const value = ([, col, , type]) =>
    type === "bool" ? yesNo(c[col]) : type === "company" ? (c[col] ? "תאגיד" : "פרטי") : type === "date" ? date(c[col]) || "—" : esc(c[col] ?? "—");
  const edit = allowed("contacts.manage");
  return `
    ${recordActions(c)}
    ${c.missing.length ? `<div class="missing"><b>כרטיס לא מלא. חסר:</b> ${esc(c.missing.join(" · "))}</div>` : ""}
    <div class="head" style="align-items:center"><h2 style="margin:16px 0 0">פרטים</h2>
      ${edit ? `<button class="btn" id="edit-contact">עריכת פרטים</button>` : ""}</div>
    <div class="facts">${shown.map((f) => `<div><span>${esc(f[2])}</span><b>${value(f)}</b></div>`).join("")}</div>
    ${c.notes ? `<p>${esc(c.notes)}</p>` : ""}
    <h2>אנשי קשר</h2>
    ${
      c.people.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>שם</th><th>תפקיד</th><th>טלפון</th><th>דוא״ל</th>${edit ? "<th></th>" : ""}</tr></thead><tbody>${c.people
            .map(
              (p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.role || "")}</td>
              <td>${p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : ""}</td>
              <td>${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : ""}</td>
              ${edit ? `<td><button class="btn" data-remove-person="${p.id}">הסרה</button></td>` : ""}</tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">אין אנשי קשר</div>`
    }
    ${edit ? `<p><button class="btn" id="add-person">הוספת איש קשר</button></p>` : ""}`;
}

function wireContact(c) {
  wireRecordActions("contact", c, { client: "#/clients", owner: "#/owners", supplier: "#/suppliers" }[c.kind]);
  view.querySelector("#edit-contact")?.addEventListener("click", () => contactDialog(c.kind, c, () => route()));
  view.querySelector("#add-person")?.addEventListener("click", () =>
    dialog(
      "איש קשר חדש",
      field("name", "שם", "required") + field("role", "תפקיד") + field("phone", "טלפון", 'type="tel"') + field("email", "דוא״ל", 'type="email"'),
      async (v) => {
        await api("POST", `/contacts/${c.id}/people`, {
          name: v.name,
          role: v.role || null,
          phone: v.phone || null,
          email: v.email || null,
        });
        toast("איש הקשר נוסף");
        route();
      },
      "הוספה",
    ),
  );
  view.querySelectorAll("[data-remove-person]").forEach((b) => {
    b.onclick = async () => {
      try {
        await api("POST", `/contacts/${c.id}/people/${b.dataset.removePerson}/remove`);
        toast("איש הקשר הוסר");
      } catch (err) {
        toast(err.message);
      }
      route();
    };
  });
}

async function ownersView(params) {
  const archived = params.get("archived") === "1";
  const rows = await api("GET", `/owners${archived ? "?archived=1" : ""}`);
  view.innerHTML = `
    <div class="head"><div><h1>בעלי דירות</h1><p class="sub">בעלי הדירות שמגלארד שוכרת מהם, ומה חסר בכרטיס של כל אחד.</p></div>
    ${allowed("contacts.manage") ? `<button class="btn primary" id="add">בעל דירה חדש</button>` : ""}</div>
    ${archiveTabs("owners", archived)}
    ${
      rows.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>שם</th><th>ת.ז / ח.פ</th><th>טלפון</th><th>דירות</th><th>כרטיס</th></tr></thead><tbody>${rows
            .map(
              (o) => `<tr class="click" data-href="#/owners/${o.id}" tabindex="0"><td>${esc(o.name)}</td><td>${esc(o.id_number || "")}</td>
              <td>${esc(o.phone || "")}</td><td>${o.properties}</td><td>${cardPill(o.missing)}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">${archived ? "אין בעלי דירות בארכיון" : "אין בעלי דירות עדיין"}</div>`
    }`;
  view.querySelector("#add")?.addEventListener("click", () => contactDialog("owner", null, (id) => (location.hash = `#/owners/${id}`)));
  clickableRows();
}

async function ownerView(id) {
  const [c, { properties }] = await Promise.all([api("GET", `/contacts/${id}`), api("GET", `/owners/${id}`)]);
  view.innerHTML = `
    <p><a href="#/owners">→ כל בעלי הדירות</a></p>
    <h1>${esc(c.name)}</h1>
    <p class="sub">בעל דירה · ${cardPill(c.missing)}${c.planfix_id ? ` · איש קשר ${c.planfix_id} ב-Planfix` : ""}</p>
    ${contactSection(c)}
    <h2>דירות</h2>
    ${
      properties.length
        ? `<ul>${properties.map((p) => `<li><a href="#/properties/${p.id}">${esc(p.address)}</a> · דירה ${p.base_number}${p.client_name ? ` · ${esc(p.client_name)}` : ""}</li>`).join("")}</ul>`
        : `<div class="empty">אין דירות</div>`
    }`;
  wireContact(c);
}

async function suppliersView(params) {
  const archived = params.get("archived") === "1";
  const rows = await api("GET", `/suppliers${archived ? "?archived=1" : ""}`);
  view.innerHTML = `
    <div class="head"><div><h1>ספקים</h1><p class="sub">ספקים וטכנאים, ועבודות פתוחות אצל כל אחד.</p></div>
    ${allowed("contacts.manage") ? `<button class="btn primary" id="add">ספק חדש</button>` : ""}</div>
    ${archiveTabs("suppliers", archived)}
    ${
      rows.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>ספק</th><th>עבודות פתוחות</th><th>עבודות שנסגרו</th><th>עבודה אחרונה</th><th>כרטיס</th></tr></thead><tbody>${rows
            .map(
              (s) => `<tr class="click" data-href="#/suppliers/${s.id}" tabindex="0"><td>${esc(s.name)}</td><td>${s.open_jobs}</td>
              <td>${s.closed_jobs}</td><td>${s.last_job ? date(s.last_job) : "—"}</td><td>${cardPill(s.missing)}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">${archived ? "אין ספקים בארכיון" : "עדיין אין ספקים"}</div>`
    }`;
  view.querySelector("#add")?.addEventListener("click", () => contactDialog("supplier", null, (id) => (location.hash = `#/suppliers/${id}`)));
  clickableRows();
}

async function supplierView(id, params) {
  const month = /^\d{4}-\d{2}$/.test(params.get("month") || "") ? params.get("month") : today().slice(0, 7);
  const [s, c] = await Promise.all([api("GET", `/suppliers/${id}`), api("GET", `/contacts/${id}`)]);
  view.innerHTML = `
    <p><a href="#/suppliers">→ כל הספקים</a></p>
    <h1>${esc(s.name)}</h1>
    <p class="sub">ספק · ${cardPill(c.missing)}${s.planfix_id ? ` · איש קשר ${s.planfix_id} ב-Planfix` : ""}</p>
    <div class="facts">
      <div><span>עבודות פתוחות</span><b>${s.open_jobs}</b></div>
      <div><span>עבודות שנסגרו</span><b>${s.closed_jobs}</b></div>
      <div><span>זמן ממוצע עד סגירה</span><b>${s.avg_days_to_close == null ? "—" : `${s.avg_days_to_close} ימים`}</b></div>
      <div><span>דירות שעבד בהן</span><b>${s.properties.length}</b></div>
    </div>
    ${contactSection(c)}
    ${allowed("invoices.view") ? `<div id="statement">${await statementSection(id, month)}</div>` : ""}
    <h2>קריאות שירות</h2>${requestsTable(s.requests)}
    ${invoicesTable(s.invoices)}
    <h2>דירות</h2>
    ${s.properties.length ? `<ul>${s.properties.map((p) => `<li><a href="#/properties/${p.id}">${esc(p.address)}</a> · ${p.jobs} קריאות</li>`).join("")}</ul>` : `<div class="empty">עדיין לא</div>`}`;
  wireContact(c);
  view.querySelector("#statement-month")?.addEventListener("change", (e) => {
    if (e.target.value) location.hash = `#/suppliers/${id}?month=${e.target.value}`;
  });
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

// Values of Planfix field 9978 "אופן טיפול בהוצאה" seen on maglardsand invoices.
const HANDLING = ["לחיוב", "כללי"];
// What happens to the expense after it is taken in.
const HANDLING_LABEL = {
  "לחיוב": "לחיוב הלקוח: ההוצאה תיכנס לחשבון הבא של הלקוח",
  "כללי": "הוצאה כללית של מגלארד: לא מחויבת ללקוח",
};

async function invoiceDialog() {
  const [engagements, supplier] = await Promise.all([api("GET", "/engagements"), contactField("supplier", "ספק", "supplier")]);
  if (!engagements.length) return toast("קודם צריך לקלוט דירה");
  const apartment = apartmentPicker(engagements);
  const d = dialog(
    "קליטת חשבונית ספק",
    apartment.html +
      supplier.html +
      field("invoiceNumber", "מספר חשבונית", "required") +
      field("invoiceDate", "תאריך חשבונית", `type="date" required value="${today()}"`) +
      field("amountNet", "סכום לפני מע״מ (₪)", 'type="number" required min="0" step="0.01"') +
      field("amountVat", "סכום המע״מ בחשבונית (₪, לא אחוז)", 'type="number" required min="0" step="0.01"') +
      `<label>אופן טיפול בהוצאה<select name="handling">${options(HANDLING.map((h) => [h, HANDLING_LABEL[h]]), HANDLING[0])}</select></label>
      <p class="full sub" id="invoice-total"></p>`,
    async (v) => {
      const net = Number(v.amountNet);
      const vat = Number(v.amountVat);
      await api("POST", "/supplier-invoices", {
        engagementId: apartment.value(v),
        supplier: supplier.resolve(v.supplier),
        invoiceNumber: v.invoiceNumber,
        invoiceDate: v.invoiceDate,
        amountNet: net,
        amountVat: vat,
        amountTotal: Math.round((net + vat) * 100) / 100,
        handling: v.handling,
      });
      toast("החשבונית נקלטה ונשלחת ל-Planfix");
      route();
    },
    "קליטה",
  );
  apartment.wire(d);
  // The total the invoice will carry, before it is taken in.
  const form = d.querySelector("form");
  const total = () => {
    const net = Number(form.amountNet.value || 0);
    const vat = Number(form.amountVat.value || 0);
    const rate = net ? Math.round((vat / net) * 1000) / 10 : 0;
    d.querySelector("#invoice-total").textContent = `סה״כ חשבונית: ${money(Math.round((net + vat) * 100) / 100)}${net ? ` (מע״מ ${rate}%)` : ""}`;
  };
  form.addEventListener("input", total);
  total();
}

// Where an invoice came from: made here (with its sync state), or entered in Planfix and shown read only.
const invoiceSource = (i) =>
  i.source === "planfix"
    ? `${pill(["נקלטה ב-Planfix", ""])} <small>#${i.planfix_task_id}</small>`
    : `${pill(SYNC[i.sync])}${i.planfix_task_id ? ` <small>#${i.planfix_task_id}</small>` : ""}`;
const supplierLink = (i) => (i.supplier_id ? `<a href="#/suppliers/${i.supplier_id}">${esc(i.supplier_name)}</a>` : esc(i.supplier_name || "—"));

async function invoicesView() {
  const rows = await api("GET", "/supplier-invoices");
  view.innerHTML = `
    <div class="head"><div><h1>חשבוניות ספק</h1><p class="sub">חשבוניות שנקלטו כאן ומצב הסנכרון שלהן, וחשבוניות שנקלטו ישירות ב-Planfix (לקריאה בלבד).</p></div>
    <div class="actions" style="margin:0">
      ${allowed("invoices.create") ? `<button class="btn primary" id="add">קליטת חשבונית</button>` : ""}
      <button class="btn" id="refresh">רענון מ-Planfix</button>
    </div></div>
    ${
      rows.length
        ? `<div class="wrap"><table class="table stack"><thead><tr><th>מספר</th><th>ספק</th><th>דירה</th><th>תאריך</th>
          <th>לפני מע״מ</th><th>סה״כ</th><th>אופן טיפול</th><th>Planfix</th></tr></thead><tbody>${rows
            .map(
              (i) => `<tr><td data-label="מספר">${esc(i.invoice_number || "—")}${i.suspected_duplicate ? ` ${pill(["חשד לכפילות", "warn"])}` : ""}</td><td data-label="ספק">${supplierLink(i)}</td><td data-label="דירה">${esc(i.apartment_code || "—")}</td>
              <td data-label="תאריך">${date(i.invoice_date)}</td><td data-label="לפני מע״מ">${money(i.amount_net)}</td><td data-label="סה״כ">${money(i.amount_total)}</td>
              <td data-label="אופן טיפול">${esc(i.handling || "")}</td><td data-label="Planfix">${invoiceSource(i)}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">אין עדיין חשבוניות ספק. חשבונית נקלטת מכאן ("קליטת חשבונית") או מתוך קריאת שירות, וחשבוניות שנקלטו ב-Planfix יופיעו אחרי "רענון מ-Planfix".</div>`
    }`;
  view.querySelector("#add")?.addEventListener("click", invoiceDialog);
  view.querySelector("#refresh").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const r = await api("POST", "/supplier-invoices/refresh");
      toast(`נקראו ${r.read} חשבוניות מ-Planfix`);
      route();
    } catch (err) {
      toast(err.message);
      e.target.disabled = false;
    }
  });
}

// The supplier's monthly account: the month's invoices, totals and due dates.
async function statementSection(supplierId, month) {
  const st = await api("GET", `/suppliers/${supplierId}/statement?month=${month}`);
  return `
    <div class="head" style="align-items:end"><h2 style="margin:16px 0 0">חשבון חודשי</h2>
      <label>חודש <input type="month" id="statement-month" value="${month}"></label></div>
    <p class="sub">תנאי תשלום: ${esc(st.supplier.payment_terms || "לא נקבעו")}${st.supplier.payment_terms ? "" : " (בלי תנאי תשלום אין תאריך לתשלום)"}</p>
    ${
      st.invoices.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>מספר</th><th>דירה</th><th>תאריך</th><th>לפני מע״מ</th><th>מע״מ</th>
          <th>סה״כ</th><th>לתשלום עד</th><th>מקור</th></tr></thead><tbody>${st.invoices
            .map(
              (i) => `<tr><td>${esc(i.invoice_number || "—")}</td><td>${esc(i.apartment_code || "—")}</td><td>${date(i.invoice_date)}</td>
              <td>${money(i.amount_net)}</td><td>${money(i.amount_vat)}</td><td>${money(i.amount_total)}</td>
              <td>${i.due_on ? date(i.due_on) : "—"}</td><td>${invoiceSource(i)}</td></tr>`,
            )
            .join("")}
            <tr><td colspan="3"><b>סה״כ לחודש</b></td><td><b>${money(st.totals.net)}</b></td><td><b>${money(st.totals.vat)}</b></td>
            <td><b>${money(st.totals.total)}</b></td><td colspan="2"></td></tr></tbody></table></div>`
        : `<div class="empty">אין חשבוניות בחודש הזה</div>`
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
        .map(
          (s) => `<li>משימה <a href="${PLANFIX_TASK}${s.planfixTaskId}" target="_blank" rel="noopener">${s.planfixTaskId}</a> (${
            s.what === "property" ? "דירה" : "התקשרות"
          })${s.about ? ` <b>${esc(s.about)}</b>` : ""}<br>${esc(s.reason)}${s.fix ? ` <button class="btn" data-fix="${s.planfixTaskId}">תיקון</button>` : ""}</li>`,
        )
        .join("")}</ul>`
    : "";
  return `<p><b>${r.dryRun ? "בדיקה, שום דבר לא נשמר:" : "הייבוא הסתיים:"}</b></p><ul>
    ${line("אנשי קשר", r.contacts)}${line("דירות", r.properties)}${line("התקשרויות", r.engagements)}</ul>${skipped}
    ${r.dryRun ? `<button class="btn primary" id="import-run">ייבוא בפועל</button>` : ""}`;
}

const PLANFIX_TASK = "https://maglardsand.planfix.com/task/";

// Completes in Planfix an engagement the import skipped: only the fields that
// changed are sent, then the check runs again.
function fixEngagementDialog(skip, choices, onSaved) {
  const f = skip.fix;
  const people = (list, current) => {
    const all = current && !list.some((c) => c.planfixId === current.planfixId) ? [current, ...list] : list;
    return `<option value="">— לא נבחר —</option>${options(all.map((c) => [String(c.planfixId), c.name]), current ? String(current.planfixId) : "")}`;
  };
  const props = choices.properties;
  const d = dialog(
    `השלמת התקשרות: משימה ${skip.planfixTaskId} ב־Planfix`,
    `<p class="full"><b>${esc(skip.about ?? "")}</b></p><p class="full sub">חסר: ${esc(f.missing.join(", "))}. השדות יעודכנו במשימה ב־Planfix, ואחר כך הבדיקה תרוץ שוב.</p>` +
      `<label class="full">דירה פיזית<select name="propertyTaskId"><option value="">— לא נבחרה —</option>${options(
        props.map((p) => [String(p.planfixTaskId), `${p.baseNumber} — ${p.address}`]),
        f.propertyTaskId ? String(f.propertyTaskId) : "",
      )}</select></label>` +
      field("apartmentCode", "קוד דירה מלא", `value="${esc(f.apartmentCode ?? "")}" maxlength="20"`) +
      field("address", "כתובת מלאה של הנכס", `value="${esc(f.address ?? "")}"`) +
      `<label>בעל דירה<select name="ownerPlanfixId">${people(choices.owners, f.owner)}</select></label>` +
      `<label>לקוח<select name="clientPlanfixId">${people(choices.clients, f.client)}</select></label>` +
      field("startsOn", "תחילת תוקף התקשרות", `type="date" value="${f.startsOn ?? ""}"`) +
      field("endsOn", "סיום תוקף התקשרות", `type="date" value="${f.endsOn ?? ""}"`),
    async (v) => {
      const body = {};
      const text = (k, was) => v[k].trim() && v[k].trim() !== (was ?? "") && (body[k] = v[k].trim());
      const id = (k, was) => v[k] && Number(v[k]) !== (was ?? null) && (body[k] = Number(v[k]));
      id("propertyTaskId", f.propertyTaskId);
      text("apartmentCode", f.apartmentCode);
      text("address", f.address);
      id("ownerPlanfixId", f.owner?.planfixId);
      id("clientPlanfixId", f.client?.planfixId);
      text("startsOn", f.startsOn);
      text("endsOn", f.endsOn);
      if (!Object.keys(body).length) throw new Error("לא שונה אף שדה");
      await api("POST", `/import/engagements/${skip.planfixTaskId}`, body);
      toast(`משימה ${skip.planfixTaskId} עודכנה ב־Planfix`);
      onSaved();
    },
    "עדכון ב־Planfix",
  );
  // Picking the apartment fills its code and address when they are empty.
  const form = d.querySelector("form");
  form.propertyTaskId.addEventListener("change", () => {
    const p = props.find((x) => String(x.planfixTaskId) === form.propertyTaskId.value);
    if (!p) return;
    if (!form.apartmentCode.value) form.apartmentCode.value = String(p.baseNumber);
    if (!form.address.value) form.address.value = p.address;
  });
}

function wireImport() {
  const box = view.querySelector("#import-result");
  if (!box) return;
  const run = async (dryRun, btn) => {
    btn.disabled = true;
    box.innerHTML = "<p>קורא מ-Planfix…</p>";
    try {
      const report = await api("POST", "/import/planfix", { dryRun });
      box.innerHTML = importReport(report);
      box.querySelectorAll("[data-fix]").forEach((b) =>
        b.addEventListener("click", () =>
          fixEngagementDialog(
            report.skipped.find((x) => String(x.planfixTaskId) === b.dataset.fix),
            report.choices,
            () => run(true, view.querySelector("#import-dry")),
          ),
        ),
      );
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
      <label>אימייל<input name="email" type="email" autocomplete="username" required aria-describedby="email-err"><span class="ferr" id="email-err"></span></label>
      <label>סיסמה<input name="password" type="password" autocomplete="current-password" required aria-describedby="password-err"><span class="ferr" id="password-err"></span></label>
      <div class="err" role="alert"></div>
      <button class="btn primary">כניסה</button>
      <p class="sub" style="margin:0">שכחת סיסמה? פנה למנהל המערכת, והוא יקבע לך סיסמה חדשה.</p>
    </form></main>`;
  const form = document.getElementById("login");
  form.querySelector("input").focus();
  const check = (input) => {
    const msg = !input.value.trim()
      ? input.name === "email" ? "צריך למלא אימייל" : "צריך למלא סיסמה"
      : input.validity.typeMismatch ? "האימייל לא תקין, למשל name@example.com" : "";
    form.querySelector(`#${input.name}-err`).textContent = msg;
    input.setAttribute("aria-invalid", msg ? "true" : "false");
    return !msg;
  };
  form.querySelectorAll("input").forEach((i) => i.addEventListener("input", () => i.getAttribute("aria-invalid") === "true" && check(i)));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    form.querySelector(".err").textContent = "";
    const bad = [...form.querySelectorAll("input")].filter((i) => !check(i));
    if (bad.length) return bad[0].focus();
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

async function clientsView(params) {
  const archived = params.get("archived") === "1";
  const rows = await api("GET", `/clients${archived ? "?archived=1" : ""}`);
  view.innerHTML = `
    <div class="head"><div><h1>לקוחות</h1><p class="sub">התאגידים שמגלארד מנהלת עבורם דירות.</p></div>
    ${allowed("contacts.manage") ? `<button class="btn primary" id="add">קליטת לקוח</button>` : ""}</div>
    ${archiveTabs("clients", archived)}
    ${
      rows.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>לקוח</th><th>דירות בתוקף</th><th>כל הדירות</th><th>קריאות פתוחות</th><th>כרטיס</th></tr></thead><tbody>${rows
            .map(
              (c) => `<tr class="click" data-href="#/clients/${c.id}" tabindex="0"><td>${esc(c.name)}</td><td>${c.active_apartments}</td>
              <td>${c.apartments}</td><td>${c.open_requests ?? 0}</td><td>${cardPill(c.missing)}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">${archived ? "אין לקוחות בארכיון" : "אין לקוחות עדיין"}</div>`
    }`;
  view.querySelector("#add")?.addEventListener("click", () => contactDialog("client", null, (id) => (location.hash = `#/clients/${id}`)));
  clickableRows();
}

async function clientView(id) {
  const [c, details] = await Promise.all([api("GET", `/clients/${id}`), api("GET", `/contacts/${id}`)]);
  const active = c.engagements.filter((e) => e.active);
  const openReqs = c.requests.filter((r) => r.status !== "closed");
  const gaps = active.flatMap((e) => missingFor(e).map((g) => `${e.apartment_code}: ${g}`));
  view.innerHTML = `
    <p><a href="#/clients">→ כל הלקוחות</a></p>
    <div class="head"><div><h1>${esc(c.name)}</h1><p class="sub">לקוח · ${cardPill(details.missing)}${c.planfix_id ? ` · איש קשר ${c.planfix_id} ב-Planfix` : ""}</p></div>
    ${allowed("requests.manage") && active.length ? `<button class="btn primary" id="new-req">פתיחת קריאת שירות</button>` : ""}</div>
    ${gaps.length ? `<div class="missing"><b>מה חסר בדירות:</b> ${esc(gaps.join(" · "))}</div>` : ""}
    <div class="facts">
      <div><span>דירות בתוקף</span><b>${active.length}</b></div>
      <div><span>קריאות פתוחות</span><b>${openReqs.length}</b></div>
      ${allowed("amounts.view") ? `<div><span>שכ״ד חודשי בדירות בתוקף</span><b>${money(active.reduce((t, e) => t + Number(e.monthly_rent || 0), 0))}</b></div>` : ""}
    </div>
    ${contactSection(details)}
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
    ${invoicesTable(c.invoices)}
    ${allowed("billing.view") ? `<div id="billing">${await billingSection(id)}</div>` : ""}`;
  view.querySelector("#new-req")?.addEventListener("click", () =>
    newRequestDialog(active.length === 1 ? active[0].id : undefined, id),
  );
  wireBilling(id);
  wireContact(details);
}

// The client's contracts, charges and accumulated bills as Planfix computes
// them. Read only: amounts are changed in Planfix.
const span = (from, to) => (from || to ? `${date(from)} עד ${date(to)}` : "—");
const chargesTable = (rows, status = true, edit = false) =>
  `<div class="wrap"><table class="table"><thead><tr><th>דירה</th><th>סוג</th><th>תקופה</th><th>לפני מע״מ</th><th>מע״מ</th>
    <th>סה״כ</th><th>התקבל</th><th>יתרה</th>${status ? "<th>סטטוס</th>" : ""}${edit ? "<th></th>" : ""}</tr></thead><tbody>${rows
      .map(
        (c) => `<tr><td>${esc(c.apartment_code || "—")}</td><td>${esc(c.charge_type || c.name)}${Number(c.amount_total) < 0 ? ` ${pill(["זיכוי", ""])}` : ""}</td><td>${span(c.period_from, c.period_to)}</td>
        <td>${money(c.amount_net)}</td><td>${money(c.amount_vat)}</td><td>${money(c.amount_total)}</td><td>${money(c.received)}</td>
        <td><b>${money(c.balance)}</b></td>${status ? `<td>${esc(c.status || "")}</td>` : ""}${
          edit ? `<td>${Number(c.received || 0) || c.refunded ? "" : `<button class="btn" data-amount="${c.planfix_task_id}">תיקון סכום</button>`}</td>` : ""
        }</tr>`,
      )
      .join("")}</tbody></table></div>`;

const CREDIT_STATE = {
  open: ["פתוח: חייבים ללקוח", "warn"],
  partly_refunded: ["הוחזר חלקית", "warn"],
  refunded: ["הוחזר ללקוח", "good"],
  offset: ["קוזז בחשבון", "good"],
};

// Credits apart from charges: the charge each corrects, and whether the money
// was offset on a bill or paid back, with the refund's details.
function creditsTable(credits) {
  if (!credits.length) return "";
  const manage = allowed("billing.manage");
  return `<h3>זיכויים והחזרים ללקוח</h3>
    <div class="wrap"><table class="table stack"><thead><tr><th>זיכוי</th><th>חיוב מקורי</th><th>סיבה</th><th>סכום</th>
      <th>מצב</th><th>החזרים שבוצעו</th><th>נשאר להחזיר</th>${manage ? "<th></th>" : ""}</tr></thead><tbody>${credits
      .map(
        (c) => `<tr><td data-label="זיכוי">${esc(c.apartment_code || "—")} · ${esc(c.charge_type || c.name)}</td>
        <td data-label="חיוב מקורי">${c.original ? `${esc(c.original.name)} (${money(c.original.amount_total)})` : "—"}</td>
        <td data-label="סיבה">${esc(c.reason || "לא נרשמה")}</td><td data-label="סכום">${money(c.amount)}</td>
        <td data-label="מצב">${pill(CREDIT_STATE[c.state])}</td>
        <td data-label="החזרים שבוצעו">${
          c.refunds.length
            ? c.refunds
                .map((r) => `${money(r.amount)} · ${date(r.paid_on)} · ${esc(r.method)} · ${esc(r.reference)}${r.recorded_by_name ? ` · נרשם על ידי ${esc(r.recorded_by_name)}` : ""}`)
                .join("<br>")
            : "—"
        }</td>
        <td data-label="נשאר להחזיר"><b>${money(c.remaining)}</b></td>${
          manage ? `<td>${c.remaining > 0 ? `<button class="btn" data-refund="${c.planfix_task_id}">רישום החזר</button>` : ""}</td>` : ""
        }</tr>`,
      )
      .join("")}</tbody></table></div>
    <p class="sub">זיכוי פתוח מקוזז בחשבון הבא, או מוחזר ללקוח ונרשם כאן. אחת משתיים, כדי שלא ייספר פעמיים.</p>`;
}

function refundDialog(clientId, c) {
  const key = crypto.randomUUID();
  dialog(
    `רישום החזר ללקוח: ${c.apartment_code || ""} ${c.charge_type || ""}`,
    `<p class="full sub">זיכוי ${money(c.amount)}${c.refunded ? `, כבר הוחזרו ${money(c.refunded)}` : ""}. רושמים אחרי שהכסף יצא בפועל.</p>` +
      field("amount", "סכום שהוחזר (₪)", `type="number" required min="0.01" step="0.01" max="${c.remaining}" value="${c.remaining}"`) +
      field("paidOn", "תאריך ההחזר", `type="date" required value="${today()}" max="${today()}"`) +
      `<label>אמצעי ההחזר<select name="method">${options(REFUND_METHODS.map((m) => [m, m]), "העברה בנקאית")}</select></label>` +
      field("reference", "אסמכתה (מספר העברה, צ׳ק או קבלה)", "required"),
    async (v) => {
      await api("POST", `/clients/${clientId}/credits/${c.planfix_task_id}/refunds`, {
        amount: Number(v.amount),
        paidOn: v.paidOn,
        method: v.method,
        reference: v.reference,
        requestKey: key,
      });
      toast("ההחזר נרשם, והיתרה עודכנה ב־Planfix");
      view.querySelector("#billing").innerHTML = await billingSection(clientId);
      wireBilling(clientId);
    },
    "רישום החזר",
  );
}

let billing = null;
async function billingSection(clientId) {
  const b = (billing = await api("GET", `/clients/${clientId}/billing`));
  const canCharge = allowed("billing.manage") && b.linked && b.apartments.length;
  const head = `<div class="head" style="align-items:end"><h2 style="margin:16px 0 0">חיובים וחשבונות</h2>
    <div class="actions" style="margin:0">${canCharge ? `<button class="btn primary" id="new-charge">חיוב חדש</button>` : ""}
    ${allowed("billing.manage") && b.linked && b.contracts.length ? `<button class="btn" id="rent-charges">חיובי שכירות</button>` : ""}
    ${allowed("billing.manage") && b.unbilled.length ? `<button class="btn primary" id="issue-bill">הפקת חשבון</button>` : ""}
    <button class="btn" id="billing-refresh">רענון מ־Planfix</button></div></div>
    <p class="sub">הסכומים מחושבים ונשמרים ב־Planfix. חיוב שעוד לא נכלל בחשבון אפשר לתקן כאן, ועל חיוב ששולם פותחים זיכוי.${
      b.readAt ? ` נקרא לאחרונה: ${new Date(b.readAt).toLocaleString("he-IL")}` : ""
    }</p>`;
  if (!b.linked) return `${head}<div class="empty">הלקוח עוד לא נשלח ל־Planfix, ולכן אין לו חיובים שם</div>`;
  return `${head}
    <div class="facts">
      <div><span>הלקוח חייב (יתרת חיובים)</span><b>${money(b.totals.owedByClient)}</b></div>
      <div><span>זיכויים שעוד לא קוזזו או הוחזרו</span><b>${money(b.totals.owedToClient)}</b></div>
      <div><span>הוחזר ללקוח</span><b>${money(b.totals.refunded)}</b></div>
      <div><span>יתרה לגבייה ב־Planfix</span><b>${money(b.totals.balance)}</b></div>
      <div><span>חיובים שעוד לא נכללו בחשבון</span><b>${b.unbilled.length} · ${money(b.totals.unbilled)}</b></div>
      <div><span>חשבונות מצטברים</span><b>${b.bills.length}</b></div>
    </div>
    <h3>חוזי שכירות ללקוח</h3>
    ${
      b.contracts.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>דירה</th><th>חוזה</th><th>כניסה ויציאה</th><th>מחיר חודשי</th>
          <th>דמי תיווך והקמה</th><th>פיקדון</th><th>סטטוס</th></tr></thead><tbody>${b.contracts
            .map(
              (k) => `<tr><td>${k.property_id ? `<a href="#/properties/${k.property_id}">${esc(k.apartment_code || "—")}</a>` : esc(k.apartment_code || "—")}</td>
              <td>${esc(k.name)}</td><td>${span(k.move_in_on, k.move_out_on)}</td><td>${money(k.monthly_price)}</td>
              <td>${money(k.setup_fee)}</td><td>${money(k.deposit)}</td><td>${esc(k.status || "")}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">אין חוזים ב־Planfix</div>`
    }
    <h3>חיובים שעוד לא נכללו בחשבון</h3>
    ${b.unbilled.length ? chargesTable(b.unbilled, true, allowed("billing.manage")) : `<div class="empty">כל החיובים כבר בחשבון</div>`}
    ${creditsTable(b.credits)}
    <h3>חשבונות מצטברים</h3>
    ${
      b.bills.length
        ? `<div class="wrap"><table class="table"><thead><tr><th>חשבון</th><th>תקופה</th><th>סכום</th><th>יתרה לגבייה</th>
          <th>חיובים חסרים</th><th>הוגש</th><th>סטטוס</th></tr></thead><tbody>${b.bills
            .map(
              (x) => `<tr class="click" data-href="#/clients/${clientId}/bills/${x.planfix_task_id}" tabindex="0"><td>${esc(x.name)}</td><td>${span(x.period_from, x.period_to)}</td><td>${money(x.computed_total ?? x.amount)}</td>
              <td><b>${money(x.balance)}</b></td><td>${x.missing_charges ? pill([`${x.missing_charges} חסרים`, "warn"]) : "—"}</td>
              <td>${x.submitted_on ? date(x.submitted_on) : "—"}</td><td>${esc(x.status || "")}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">אין חשבונות ב־Planfix</div>`
    }
    ${b.billed.length ? `<details><summary>חיובים שכבר בחשבון (${b.billed.length})</summary>${chargesTable(b.billed)}</details>` : ""}`;
}

// A charge or credit opened in Planfix. The VAT split shown follows Planfix's
// expense-type table; the server makes the same split.
function chargeDialog(clientId) {
  const b = billing;
  const now = today();
  const end = new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const key = crypto.randomUUID();
  const apartment = apartmentPicker(
    b.apartments.map((a) => ({ ...a, client_name: b.client.name })),
    b.apartments.length === 1 ? b.apartments[0].id : undefined,
  );
  const d = dialog(
    "חיוב חדש ב־Planfix",
    apartment.html +
      `<label>סוג חיוב<select name="chargeType">${options(b.chargeTypes.map((t) => [t.name, t.name]), b.chargeTypes[0].name)}</select></label>` +
      field("note", "פירוט (לא חובה)", 'maxlength="80" placeholder="למשל: בלון גז"') +
      field("periodFrom", "תקופה מתאריך", `type="date" required value="${now.slice(0, 8)}01"`) +
      field("periodTo", "עד תאריך", `type="date" required value="${end}"`) +
      field("amountTotal", "סכום כולל מע״מ (זיכוי במינוס)", 'type="number" required step="0.01"') +
      `<div class="full grid" id="credit-box" hidden>
        <label>סיבת הזיכוי<select name="creditReason"><option value="">בחר סיבה</option>${options(CREDIT_REASONS.map((r) => [r, r]))}</select></label>
        <label>החיוב שהזיכוי מתקן<select name="creditFor"><option value="">לא קשור לחיוב מסוים</option>${options(
          [...b.unbilled, ...b.billed]
            .filter((c) => Number(c.amount_total) > 0)
            .map((c) => [String(c.planfix_task_id), `${c.apartment_code || ""} · ${c.charge_type || c.name} · ${span(c.period_from, c.period_to)} · ${money(c.amount_total)}`]),
        )}</select></label></div>` +
      `<p class="full sub" id="split"></p>`,
    async (v) => {
      const r = await api("POST", `/clients/${clientId}/charges`, {
        engagementId: apartment.value(v),
        chargeType: v.chargeType,
        note: v.note || undefined,
        periodFrom: v.periodFrom,
        periodTo: v.periodTo,
        amountTotal: Number(v.amountTotal),
        ...(Number(v.amountTotal) < 0 ? { creditReason: v.creditReason || undefined, creditFor: v.creditFor ? Number(v.creditFor) : undefined } : {}),
        requestKey: key,
      });
      toast(`${Number(v.amountTotal) < 0 ? "הזיכוי" : "החיוב"} נפתח ב־Planfix (#${r.planfixTaskId})`);
      view.querySelector("#billing").innerHTML = await billingSection(clientId);
      wireBilling(clientId);
    },
    "פתיחת חיוב",
  );
  const form = d.querySelector("form");
  const showSplit = () => {
    const type = b.chargeTypes.find((t) => t.name === form.chargeType.value);
    const total = Number(form.amountTotal.value);
    const box = d.querySelector("#split");
    const from = { client_rent: "כרטיס הלקוח (מע״מ על שכירות)", client_expenses: "כרטיס הלקוח (מע״מ על הוצאות)", planfix: "טבלת סוגי ההוצאה ב־Planfix", planfix_unverified: "טבלת סוגי ההוצאה ב־Planfix" }[type.source];
    d.querySelector("#credit-box").hidden = !(total < 0);
    form.creditReason.required = total < 0;
    form.querySelector(".primary").disabled = type.vat === null;
    if (type.vat === null)
      box.textContent =
        type.source === "planfix"
          ? `החיוב "${type.name}" לא זמין: סוג החיוב עוד לא נוסף לטבלה "מגלארד — סוגי הוצאה ומע״מ" ב־Planfix. אחרי שיוסיפו אותו שם (כולל "חייבת במע״מ" ו"הגדרת מע״מ אומתה") הוא ייפתח כאן מעצמו.`
          : type.source === "planfix_unverified"
            ? `החיוב "${type.name}" לא זמין: הגדרת המע״מ שלו ב־Planfix עוד לא סומנה "הגדרת מע״מ אומתה".`
            : `ב${from} לא הוגדר אם יש מע״מ. יש להשלים את השדה בכרטיס הלקוח, ואז לפתוח את החיוב.`;
    else if (!total) box.textContent = `${type.vat ? `חייב במע״מ (${b.vatRate}%)` : "לא חייב במע״מ"} לפי ${from}`;
    else {
      const net = type.vat ? Math.round((total / (1 + b.vatRate / 100)) * 100) / 100 : total;
      box.textContent = `לפני מע״מ ${money(net)} · מע״מ ${money(Math.round((total - net) * 100) / 100)} (לפי ${from})`;
    }
  };
  form.addEventListener("input", showSplit);
  showSplit();
  apartment.wire(d);
}

// An accumulated bill issued in Planfix over the charges picked here. Planfix
// sums them; submitting the bill to the client stays a step in Planfix.
function billDialog(clientId) {
  const b = billing;
  const key = crypto.randomUUID();
  const now = today();
  const end = new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const d = dialog(
    "הפקת חשבון מצטבר ב־Planfix",
    field("periodFrom", "תקופה מתאריך", `type="date" required value="${now.slice(0, 8)}01"`) +
      field("periodTo", "עד תאריך", `type="date" required value="${end}"`) +
      `<div class="full"><b>חיובים שייכללו בחשבון</b>${b.unbilled
        .filter((c) => !c.refunded)
        .map(
          (c) => `<label style="display:flex;flex-direction:row;gap:8px;align-items:center;font-weight:400;margin-top:6px"><input type="checkbox" style="width:auto" data-charge="${c.planfix_task_id}"
            data-from="${c.period_from || ""}" data-total="${c.amount_total ?? 0}">
            ${esc(c.apartment_code || "—")} · ${esc(c.charge_type || c.name)} · ${span(c.period_from, c.period_to)} · ${money(c.amount_total)}</label>`,
        )
        .join("")}</div>
      <p class="full sub" id="bill-total"></p>`,
    async (v) => {
      const charges = [...d.querySelectorAll("[data-charge]:checked")].map((x) => Number(x.dataset.charge));
      const r = await api("POST", `/clients/${clientId}/bills`, { periodFrom: v.periodFrom, periodTo: v.periodTo, charges, requestKey: key });
      toast("החשבון הופק ב־Planfix");
      location.hash = `#/clients/${clientId}/bills/${r.planfixTaskId}`;
    },
    "הפקת חשבון",
  );
  const form = d.querySelector("form");
  const boxes = [...d.querySelectorAll("[data-charge]")];
  // Everything that starts by the end of the period is picked by default.
  const pick = () => boxes.forEach((x) => (x.checked = !x.dataset.from || x.dataset.from <= form.periodTo.value));
  const total = () => {
    const picked = boxes.filter((x) => x.checked);
    d.querySelector("#bill-total").textContent = `${picked.length} חיובים · ${money(picked.reduce((t, x) => t + Number(x.dataset.total), 0))} (Planfix מחשב את הסכום הסופי)`;
  };
  form.periodTo.addEventListener("change", () => (pick(), total()));
  form.addEventListener("change", total);
  pick();
  total();
}

// The month's rent, one charge per contract not yet charged. Planfix computes
// the rent by days from the contract.
function rentDialog(clientId) {
  const key = crypto.randomUUID();
  const d = dialog(
    "חיובי שכירות לחודש",
    field("month", "חודש", `type="month" required value="${today().slice(0, 7)}"`) + `<div class="full" id="rent-plan"></div>`,
    async (v) => {
      const r = await api("POST", `/clients/${clientId}/rent-charges`, { month: v.month, requestKey: key });
      const problems = r.created.filter((c) => c.problem);
      toast(`נפתחו ${r.created.length} חיובי שכ״ד ב־Planfix${problems.length ? `, ${problems.length} צריכים השלמה ב־Planfix` : ""}`);
      view.querySelector("#billing").innerHTML = await billingSection(clientId);
      wireBilling(clientId);
    },
    "פתיחת חיובים",
  );
  const box = d.querySelector("#rent-plan");
  const load = async () => {
    box.textContent = "בודק…";
    try {
      const p = await api("GET", `/clients/${clientId}/rent-charges?month=${d.querySelector("form").month.value}`);
      const todo = p.contracts.filter((k) => !k.charged);
      box.innerHTML = p.contracts.length
        ? `${p.contracts
            .map(
              (k) => `<div>${esc(k.apartment_code || "—")} · ${span(k.period_from, k.period_to)} · ${money(k.monthly_price)} לחודש ·
                ${k.charged ? pill(["כבר חויב", ""]) : pill(["ייפתח", "good"])}</div>`,
            )
            .join("")}<p class="sub">${todo.length} חיובים ייפתחו. הסכום לפי ימים יחושב ב־Planfix מתוך החוזה.</p>`
        : `<p class="sub">אין חוזים עם מחיר חודשי שפעילים בחודש הזה</p>`;
    } catch (err) {
      box.textContent = err.message;
    }
  };
  d.querySelector("form").month.addEventListener("change", load);
  load();
}

// One bill as the client receives it, ready to print.
async function billView(clientId, billId) {
  const { client, bill, charges, totals } = await api("GET", `/clients/${clientId}/bills/${billId}`);
  const byApartment = new Map();
  for (const c of charges) byApartment.set(c.apartment_code || "—", [...(byApartment.get(c.apartment_code || "—") || []), c]);
  view.innerHTML = `
    <p class="no-print"><a href="#/clients/${clientId}">→ ${esc(client.name)}</a></p>
    <div class="head"><div><h1>${esc(bill.name)}</h1>
      <p class="sub">${esc(client.name)}${client.id_number ? ` · ח.פ ${esc(client.id_number)}` : ""}${client.address ? ` · ${esc(client.address)}` : ""}</p>
      <p class="sub">תקופה: ${span(bill.period_from, bill.period_to)} · ${esc(bill.status || "")}${bill.submitted_on ? ` · הוגש ${date(bill.submitted_on)}` : ""}</p></div>
      <button class="btn no-print" id="print">הדפסה</button></div>
    ${bill.missing_charges ? `<div class="missing">ב־Planfix חסרים פרטים ב־${bill.missing_charges} חיובים בחשבון הזה</div>` : ""}
    ${
      charges.length
        ? [...byApartment]
            .map(([code, rows]) => `<h3>דירה ${esc(code)}</h3>${chargesTable(rows, false)}`)
            .join("")
        : `<div class="empty">אין חיובים בחשבון</div>`
    }
    <div class="facts">
      <div><span>לפני מע״מ</span><b>${money(totals.net)}</b></div>
      <div><span>מע״מ</span><b>${money(totals.vat)}</b></div>
      <div><span>סה״כ לפי Planfix</span><b>${money(bill.computed_total ?? totals.total)}</b></div>
      <div><span>יתרה לגבייה</span><b>${money(bill.balance ?? totals.balance)}</b></div>
    </div>`;
  view.querySelector("#print").addEventListener("click", () => window.print());
}

function wireBilling(clientId) {
  view.querySelector("#new-charge")?.addEventListener("click", () => chargeDialog(clientId));
  view.querySelector("#issue-bill")?.addEventListener("click", () => billDialog(clientId));
  view.querySelector("#rent-charges")?.addEventListener("click", () => rentDialog(clientId));
  view.querySelectorAll("#billing [data-amount]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const c = billing.unbilled.find((x) => String(x.planfix_task_id) === btn.dataset.amount);
      dialog(
        `תיקון סכום: ${c.apartment_code || ""} ${c.charge_type || c.name}`,
        `<p class="full sub">סכום נוכחי: ${money(c.amount_total)} · ${span(c.period_from, c.period_to)}</p>` +
          field("amountTotal", "סכום חדש כולל מע״מ", `type="number" required step="0.01" value="${c.amount_total ?? ""}"`) +
          field("reason", "סיבת התיקון", "required", true),
        async (v) => {
          await api("POST", `/clients/${clientId}/charges/${c.planfix_task_id}/amount`, { amountTotal: Number(v.amountTotal), reason: v.reason });
          toast("הסכום תוקן ב־Planfix");
          view.querySelector("#billing").innerHTML = await billingSection(clientId);
          wireBilling(clientId);
        },
        "תיקון",
      );
    }),
  );
  view.querySelectorAll("#billing [data-refund]").forEach((btn) =>
    btn.addEventListener("click", () => refundDialog(clientId, billing.credits.find((x) => String(x.planfix_task_id) === btn.dataset.refund))),
  );
  view.querySelectorAll("#billing tr[data-href]").forEach((tr) => {
    const go = () => (location.hash = tr.dataset.href);
    tr.addEventListener("click", go);
    tr.addEventListener("keydown", (e) => e.key === "Enter" && go());
  });
  const btn = view.querySelector("#billing-refresh");
  btn?.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "קורא מ־Planfix…";
    try {
      await api("POST", "/billing/refresh");
    } catch (err) {
      toast(err.message);
    }
    view.querySelector("#billing").innerHTML = await billingSection(clientId);
    wireBilling(clientId);
  });
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
      ${allowed("requests.manage") && current && !p.archived_at ? `<button class="btn primary" id="new-req">פתיחת קריאת שירות</button>` : ""}
      ${current && !p.archived_at ? `<button class="btn" id="new-task">משימה לדירה</button>` : ""}
    </div></div>
    ${recordActions(p)}
    ${gaps.length && !p.archived_at ? `<div class="missing"><b>מה חסר:</b> ${esc(gaps.join(" · "))}</div>` : ""}
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
  wireRecordActions("property", p, "#/apartments");
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
  owner: (id) => `#/owners/${id}`,
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
      <label class="grow">שיעור מע״מ (%) לפיצול חיוב חדש, בסוגים שמוגדרים ב־Planfix כחייבים במע״מ.
      <input name="vatRate" type="number" min="0" max="100" step="0.01" required value="${settings.vatRate}"></label>
      <button class="btn">שמירה</button></form>`;
  view.querySelector("#settings").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("POST", "/settings", { approvalThreshold: Number(f.get("approvalThreshold")), vatRate: Number(f.get("vatRate")) });
      toast("ההגדרות עודכנו");
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

// ---------- short guide ----------

// Each topic shows only to the roles that can do it: [id, title, permission, steps].
const GUIDE = [
  ["start", "מרכז עבודה", null, [
    "המסך הראשון אחרי הכניסה. למעלה: מה מחכה לך היום, המשימות שלך והקריאות הדחופות.",
    "כל כרטיס אומר מה הצעד הבא, והכפתור שלו מוביל ישר לפעולה.",
    "חיפוש מהיר: Ctrl+K או שורת החיפוש. אפשר לחפש לקוח, בעל דירה, ספק, כתובת, קוד דירה, קריאה או חשבונית.",
  ]],
  ["requests", "קריאת שירות מתחילתה ועד סופה", "requests.manage", [
    "פותחים מכרטיס הדירה, או מ\"קריאות שירות\" ובוחרים דירה בחיפוש לפי קוד, כתובת או לקוח.",
    "משייכים ספק, עלות משוערת כולל מע״מ ועל חשבון מי: הלקוח, בעל הדירה או מגלרד.",
    "על חשבון הלקוח: רושמים את אישור הלקוח (איך אישר ועד איזה סכום). העבודה לא מתחילה בלי אישור שמכסה את ההערכה, ואם ההערכה עולה צריך אישור חדש.",
    "עלות מעל סף האישור מחכה גם לאישור מנהל. אישור מנהל לא מחליף את אישור הלקוח.",
    "בסוף העבודה קולטים את חשבונית הספק מתוך הקריאה וסוגרים אותה.",
  ]],
  ["approvals", "אישור עלויות", "approvals.decide", [
    "ב\"אישורים\" מופיעות קריאות שהעלות שלהן מעל הסף.",
    "מאשרים או דוחים. בדחייה כותבים מה צריך לעשות, והפותח מקבל התראה.",
  ]],
  ["invoices", "קליטת חשבונית ספק", "invoices.create", [
    "\"קליטת חשבונית\" ב\"חשבוניות ספק\", או מתוך קריאת השירות.",
    "מספר החשבונית כמו שמופיע עליה. חשבונית שכבר נקלטה, כאן או ב־Planfix, תיחסם.",
    "המע״מ נרשם כסכום בשקלים, לא כאחוז. הסה״כ מחושב לבד ומוצג לבדיקה.",
    "אופן הטיפול קובע מי משלם: לחיוב הלקוח, על חשבון בעל הדירה או הוצאה של מגלרד.",
  ]],
  ["billing", "חיובים וחשבונות ללקוח", "billing.view", [
    "בכרטיס הלקוח, בחלק \"חיובים וחשבונות\": החוזים, החיובים שעוד לא נכנסו לחשבון והחשבונות שהופקו.",
    "חיוב חדש, חיוב שכר דירה לחודש והפקת חשבון נשמרים ב־Planfix, שמחשב את הסכומים.",
    "המע״מ נקבע לפי כרטיס הלקוח: מע״מ על שכירות ומע״מ על הוצאות. אם הם לא מולאו, החיוב נעצר עד שימלאו.",
    "חיוב שעוד לא נכלל בחשבון אפשר לתקן. על חיוב ששולם פותחים זיכוי (סכום במינוס).",
  ]],
  ["contacts", "כרטיסי לקוח, בעל דירה וספק", "contacts.manage", [
    "שדה שמסומן (חובה) נדרש כדי לפתוח את הכרטיס.",
    "שדה שמסומן * נדרש כדי שהכרטיס יהיה מלא. אפשר לשמור בלעדיו, והכרטיס יסומן \"לא מלא\" עד שישלימו.",
  ]],
  ["tasks", "משימות", "tasks.use", [
    "\"משימה חדשה\" במרכז העבודה או בכרטיס הדירה: מה לעשות, למי ועד מתי.",
    "משימה באיחור או דחופה מסומנת באדום ומופיעה ראשונה.",
  ]],
  ["sync", "סנכרון Planfix", "sync.view", [
    "כל שמירה כאן נשלחת ל־Planfix ברקע. \"ממתין לסנכרון\" הוא מצב רגיל לכמה שניות.",
    "פעולה שנכשלה מופיעה במרכז העבודה וב\"סנכרון Planfix\" עם הסיבה, ואפשר לנסות שוב.",
  ]],
  ["users", "משתמשים והרשאות", "users.manage", [
    "ב\"משתמשים\": הוספת עובד, תפקיד (שקובע מה הוא רואה ועושה), השבתה וקביעת סיסמה חדשה.",
    "עובד ששכח סיסמה פונה אליך, ואתה קובע לו סיסמה חדשה.",
  ]],
];

const guideFor = () => GUIDE.filter(([, , perm]) => !perm || allowed(perm));

function helpView(params) {
  view.innerHTML = `
    <div class="head"><div><h1>מדריך קצר</h1><p class="sub">מה אפשר לעשות במערכת לפי התפקיד שלך (${esc(me.roleLabel)}).</p></div></div>
    <nav class="toc" aria-label="נושאים">${guideFor()
      .map(([id, title]) => `<a href="#/help?t=${id}">${esc(title)}</a>`)
      .join("")}</nav>
    ${guideFor()
      .map(
        ([id, title, , steps]) => `<section class="card guide" id="guide-${id}" aria-labelledby="h-${id}"><div class="grow">
          <h2 id="h-${id}">${esc(title)}</h2><ol>${steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></div></section>`,
      )
      .join("")}
    <p class="sub">שכחת סיסמה? פנה למנהל המערכת.</p>`;
  const target = params.get("t") && view.querySelector(`#guide-${CSS.escape(params.get("t"))}`);
  if (target) {
    target.scrollIntoView();
    target.querySelector("h2").setAttribute("tabindex", "-1");
    target.querySelector("h2").focus();
    return true;
  }
}

// A first visit gets a short welcome on the work center until it is dismissed.
const welcomeKey = () => `mos-welcome-${me.id}`;
function welcomeCard() {
  try {
    if (localStorage.getItem(welcomeKey())) return "";
  } catch {
    // no storage: show the card
  }
  const topics = guideFor().slice(0, 4);
  return `<section class="card welcome" aria-labelledby="welcome-h"><div class="grow">
    <h2 id="welcome-h" style="margin:0 0 6px">ברוך הבא ל־MAGLARD OS</h2>
    <p style="margin:0 0 8px">כאן מנהלים את הדירות, הקריאות, החשבוניות והחיובים. Planfix ממשיך לעבוד ברקע ומתעדכן לבד.</p>
    <p style="margin:0">להתחלה: ${topics.map(([id, title]) => `<a href="#/help?t=${id}">${esc(title)}</a>`).join(" · ")}</p></div>
    <button class="btn" id="welcome-ok">הבנתי</button></section>`;
}
function wireWelcome() {
  view.querySelector("#welcome-ok")?.addEventListener("click", (e) => {
    try {
      localStorage.setItem(welcomeKey(), "1");
    } catch {
      // the card comes back next time
    }
    e.target.closest(".welcome").remove();
  });
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
  const [, section, id, sub, subId] = path.split("/");
  document.querySelectorAll(".nav").forEach((a) => {
    const target = a.getAttribute("href").replace(/^#/, "").split("?")[0].split("/")[1];
    const current = section === "properties" ? "apartments" : section || "";
    a.toggleAttribute("aria-current", target === current);
    if (target === current) {
      a.setAttribute("aria-current", "page");
      if (menuLabel) menuLabel.textContent = a.firstChild.textContent.trim();
    }
  });
  closeMenu();
  // Show that the page is loading only when it takes long enough to notice.
  const slow = setTimeout(() => {
    view.setAttribute("aria-busy", "true");
    document.body.classList.add("loading");
  }, 150);
  let placed = false;
  try {
    if (!section) await workCenterView();
    else if (section === "apartments") await apartmentsView(params);
    else if (section === "tasks" && id) await taskView(id);
    else if (section === "tasks") await tasksView(params);
    else if (section === "clients" && id && sub === "bills" && subId) await billView(id, subId);
    else if (section === "clients" && id) await clientView(id);
    else if (section === "clients") await clientsView(params);
    else if (section === "properties" && id) await propertyView(id);
    else if (section === "requests" && id) await requestView(id);
    else if (section === "requests") await requestsView();
    else if (section === "invoices") await invoicesView();
    else if (section === "suppliers" && id) await supplierView(id, params);
    else if (section === "owners" && id) await ownerView(id);
    else if (section === "owners") await ownersView(params);
    else if (section === "suppliers") await suppliersView(params);
    else if (section === "approvals") await approvalsView(params);
    else if (section === "notifications") await notificationsView();
    else if (section === "sync") await syncView();
    else if (section === "users") await usersView();
    else if (section === "audit") await auditView();
    else if (section === "help") placed = helpView(params);
    else view.innerHTML = `<div class="empty">הדף לא נמצא</div>`;
  } catch (err) {
    view.innerHTML = `<div class="empty">לא הצלחתי לטעון: ${esc(err.message)}</div>`;
  } finally {
    clearTimeout(slow);
    view.removeAttribute("aria-busy");
    document.body.classList.remove("loading");
  }
  // Name the screen in the tab and move focus to it, so a screen reader
  // announces the new page; the first load keeps focus where the browser put it.
  const h1 = view.querySelector("h1");
  document.title = h1 ? `${h1.textContent} · MAGLARD OS` : "MAGLARD OS";
  if (routed && !placed && h1) {
    h1.setAttribute("tabindex", "-1");
    h1.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  routed = true;
  refreshCounts();
}
let routed = false;

// On a phone the menu folds into one button that names the current screen.
const menuBtn = document.getElementById("menu-btn");
const menuLabel = document.getElementById("menu-label");
function closeMenu() {
  document.querySelector(".rail")?.classList.remove("open");
  menuBtn?.setAttribute("aria-expanded", "false");
}
// The skip link moves focus without touching the hash, which drives routing.
document.getElementById("skip")?.addEventListener("click", (e) => {
  e.preventDefault();
  view.focus();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.querySelector(".rail.open")) {
    closeMenu();
    menuBtn.focus();
  }
});
menuBtn?.addEventListener("click", () => {
  const open = document.querySelector(".rail").classList.toggle("open");
  menuBtn.setAttribute("aria-expanded", String(open));
});

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
