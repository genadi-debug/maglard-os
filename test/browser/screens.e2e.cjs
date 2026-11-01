// Browser checks of the work screens, on a desktop and a phone viewport.
// Not part of `npm test`: it needs a running server with fictitious demo
// data and Playwright (and, optionally, axe-core for an accessibility scan).
//
//   BASE=http://127.0.0.1:3311 SHOTS=/tmp/shots REQUEST=<id> node test/browser/screens.e2e.cjs
//
// Users: admin@example.com (admin) and boss@example.com (department manager),
// password a-long-password, as made by the demo seed. Exits non-zero on the
// first failed check.

const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE || "http://127.0.0.1:3311";
const SHOTS = process.env.SHOTS || "/tmp/shots";
const REQUEST = process.env.REQUEST;
const AXE = process.env.AXE; // path to axe-core/axe.min.js, optional
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` · ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

async function login(page, email) {
  await page.context().clearCookies();
  await page.goto(`${BASE}/`);
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", "a-long-password");
  await page.keyboard.press("Enter");
  await page.waitForSelector("main#view h1");
}

async function go(page, hash) {
  await page.evaluate((h) => (location.hash = h), hash);
  await page.waitForTimeout(500);
  await page.waitForSelector("main#view h1, main#view .empty");
}

async function axeScan(page, label) {
  if (!AXE) return;
  await page.addScriptTag({ path: AXE });
  const r = await page.evaluate(async () => {
    const res = await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa"] });
    return res.violations.map((v) => `${v.id}(${v.nodes.length})`);
  });
  check(`axe ${label}`, r.length === 0, r.join(", "));
}

async function run(device) {
  const browser = await chromium.launch();
  const mobile = device === "mobile";
  const ctx = await browser.newContext(
    mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "he-IL" } : { viewport: { width: 1280, height: 900 }, locale: "he-IL" },
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${device}-${name}.png`), fullPage: true });
  const noSideScroll = async (label) => {
    const w = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${device}: no sideways scroll on ${label}`, w <= 1, `${w}px`);
  };

  await login(page, "boss@example.com");
  check(`${device}: page is Hebrew and right to left`, (await page.getAttribute("html", "dir")) === "rtl" && (await page.getAttribute("html", "lang")) === "he");

  // Work center: own tasks by due date, exceptions, and the manager's blockers.
  await go(page, "#/");
  check(`${device}: work center lists tasks by due date`, (await page.locator("h3.group").count()) > 0);
  check(`${device}: work center shows blockers to a manager`, (await page.getByText("עומסים וחסמים").count()) === 1);
  await noSideScroll("work center");
  await shot("work-center");
  await axeScan(page, `${device} work center`);

  // Keyboard: on a fresh load the first Tab reaches the skip link.
  await page.reload();
  await page.waitForSelector("main#view h1");
  await page.keyboard.press("Tab");
  check(`${device}: first Tab is the skip link`, (await page.evaluate(() => document.activeElement?.id)) === "skip");

  // Requests list: a filter stays in the address, and the back link returns to it.
  await go(page, "#/requests");
  await page.selectOption("select[name=status]", "all");
  await page.fill("input[name=q]", "מזגן");
  await page.waitForTimeout(200);
  const filtered = await page.evaluate(() => location.hash);
  check(`${device}: filters are kept in the address`, filtered.includes("q=") && filtered.includes("status=all"), filtered);
  await page.locator("#request-rows a[href^='#/requests/']").first().click();
  await page.waitForSelector(".progress");
  check(`${device}: request shows progress stages`, (await page.locator(".progress li").count()) === 6);
  check(`${device}: request shows saved and Planfix apart`, (await page.getByText("נשמר במערכת").count()) > 0);
  check(`${device}: focus moves to the new screen's heading`, (await page.evaluate(() => document.activeElement?.tagName)) === "H1");
  await noSideScroll("request");
  await shot("request");
  await axeScan(page, `${device} request`);
  await page.locator("a.back").first().click();
  await page.waitForSelector("#request-rows");
  check(
    `${device}: back returns to the filtered list`,
    (await page.inputValue("input[name=q]")) === "מזגן" && (await page.inputValue("select[name=status]")) === "all",
  );

  // A form in steps: required fields, problems next to the field, a summary, and a warning before leaving.
  await page.click("#add");
  await page.waitForSelector("dialog .steps");
  check(`${device}: the form shows its steps`, (await page.locator("dialog .steps li").count()) === 3);
  check(`${device}: required fields are marked`, (await page.locator("dialog .req").count()) > 0);
  await page.click("dialog [data-next]");
  const err = await page.locator("dialog .ferr").first().textContent();
  check(`${device}: a missing field is explained next to it`, err === "שדה חובה", err);
  check(`${device}: focus goes to the field to fix`, (await page.evaluate(() => document.activeElement?.getAttribute("aria-invalid"))) === "true");
  await page.fill("dialog input[name=apartment]", "לא קיימת");
  await page.click("dialog [data-next]");
  check(`${device}: an apartment not on the list is refused`, ((await page.locator("dialog .ferr").first().textContent()) || "").includes("מהרשימה"));
  const option = await page.evaluate(() => document.querySelector("#dl-apartment option")?.value);
  await page.fill("dialog input[name=apartment]", option);
  await page.dispatchEvent("dialog input[name=apartment]", "input");
  await page.click("dialog [data-next]");
  await page.fill("dialog input[name=subject]", "MOS-TEST בדיקת דפדפן");
  await page.fill("dialog input[name=reportedBy]", "דייר");
  await page.click("dialog [data-next]");
  check(`${device}: the last step sums up before sending`, ((await page.locator("dialog dl.summary").textContent()) || "").includes("MOS-TEST בדיקת דפדפן"));
  await shot("form-summary");
  await page.keyboard.press("Escape");
  check(`${device}: leaving with changes asks first`, await page.locator("dialog .confirm-leave").isVisible());
  await shot("form-leave");
  await page.click("dialog [data-leave]");
  await page.waitForSelector("dialog", { state: "detached", timeout: 2000 }).catch(() => {});
  check(`${device}: leaving closes the form`, (await page.locator("dialog").count()) === 0);

  // Error and empty states.
  await go(page, "#/requests/00000000-0000-4000-8000-000000000000");
  check(`${device}: a missing record shows an error`, ((await page.locator("main#view .empty").textContent()) || "").includes("לא הצלחתי לטעון"));
  await go(page, "#/requests?q=zzzzzz&status=all");
  check(`${device}: an empty filter says so`, ((await page.locator("#request-rows .empty").textContent()) || "").includes("אין קריאות"));

  // The service file for finance, as admin: partial mark on screen and in print.
  await login(page, "admin@example.com");
  if (REQUEST) {
    await go(page, `#/requests/${REQUEST}/file`);
    check(`${device}: service file marks a partial document`, (await page.locator(".partial").count()) === 1);
    await noSideScroll("service file");
    await shot("service-file");
    await axeScan(page, `${device} service file`);
    await page.emulateMedia({ media: "print" });
    check(`${device}: print hides the menu`, !(await page.locator(".rail").isVisible()));
    check(`${device}: print keeps the partial mark`, await page.locator(".partial").isVisible());
    await shot("service-file-print");
    if (!mobile) await page.pdf({ path: path.join(SHOTS, "service-file.pdf"), format: "A4" }).catch(() => {});
    await page.emulateMedia({ media: "screen" });
  }
  await go(page, "#/access");
  await shot("access");

  check(`${device}: no script errors`, errors.length === 0, errors.join(" | "));
  await browser.close();
}

(async () => {
  for (const device of ["desktop", "mobile"]) await run(device);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
})();
