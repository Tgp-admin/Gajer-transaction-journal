// End-to-end smoke test in a real browser: serves public/index.html, mocks
// every /api/* call with an in-memory fake backend (so no real Google/Sheets
// credentials are needed), fakes a signed-in Google account, and exercises
// the sign-in gate + core CRUD flows through actual DOM interaction.

const path = require("path");
const http = require("http");
const { chromium } = require("playwright");

// ---- tiny static file server for public/index.html ----
const fs = require("fs");
const PORT = 8934;
const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, "../public/index.html");
  res.writeHead(200, { "Content-Type": "text/html" });
  fs.createReadStream(filePath).pipe(res);
});

// ---- in-memory fake backend state ----
let store = {
  inventory: [{ name: "BPC-157", category: "Peptides", unit: "/mg", price: 5 }],
  transactions: [],
  customers: [{ name: "Jane Doe", dob: "N/A", notes: "" }],
  categories: ["Peptides"],
  payments: ["Cash", "Card"],
  addendums: [{ name: "Booking Fee", amount: 15 }],
};
let txnCounter = 0;

function fakeApi(route, request) {
  const url = new URL(request.url());
  const pathname = url.pathname.replace("/api", "");
  const method = request.method();
  const body = request.postData() ? JSON.parse(request.postData()) : {};

  const json = (status, data) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });

  if (pathname === "/inventory") {
    if (method === "GET") return json(200, { inventory: store.inventory });
    if (method === "POST") {
      if (body.originalName) {
        const idx = store.inventory.findIndex((i) => i.name === body.originalName);
        store.inventory[idx] = { name: body.name, category: body.category, unit: body.unit, price: Number(body.price) };
        return json(200, store.inventory[idx]);
      }
      const item = { name: body.name, category: body.category, unit: body.unit, price: Number(body.price) };
      store.inventory.push(item);
      return json(201, item);
    }
    if (method === "DELETE") {
      store.inventory = store.inventory.filter((i) => i.name !== body.name);
      return json(200, { deleted: body.name });
    }
  }

  if (pathname === "/transactions") {
    if (method === "GET") return json(200, { transactions: store.transactions });
    if (method === "POST") {
      const id = body.id || `TXN-TEST${++txnCounter}`;
      const idx = store.transactions.findIndex((t) => t.id === id);
      const record = { ...body, id, loggedBy: "sherry@thegajerpractice.com", loggedAt: new Date().toISOString() };
      if (idx >= 0) store.transactions[idx] = record; else store.transactions.push(record);
      return json(idx >= 0 ? 200 : 201, record);
    }
    if (method === "DELETE") {
      const ids = body.ids || [body.id];
      store.transactions = store.transactions.filter((t) => !ids.includes(t.id));
      return json(200, { deleted: ids.length });
    }
  }

  if (pathname === "/customers") {
    if (method === "GET") return json(200, { customers: store.customers });
    if (method === "POST") {
      if (store.customers.some((c) => c.name.toLowerCase() === body.name.toLowerCase())) {
        return json(409, { error: "This customer name already exists!" });
      }
      const c = { name: body.name, dob: body.dob || "N/A", notes: body.notes || "" };
      store.customers.push(c);
      return json(201, c);
    }
    if (method === "PATCH") {
      const idx = store.customers.findIndex((c) => c.name === body.originalName);
      store.customers[idx] = { name: body.name, dob: body.dob, notes: body.notes };
      return json(200, store.customers[idx]);
    }
    if (method === "DELETE") {
      store.customers = store.customers.filter((c) => c.name !== body.name);
      return json(200, { deleted: body.name });
    }
  }

  if (pathname === "/lists") {
    const type = url.searchParams.get("type");
    if (method === "GET") {
      if (type === "addendums") return json(200, { items: store.addendums });
      return json(200, { items: store[type] });
    }
    if (method === "POST") {
      if (type === "addendums") {
        const a = { name: body.name, amount: Number(body.amount) };
        store.addendums.push(a);
        return json(201, a);
      }
      store[type].push(body.value);
      return json(201, { value: body.value });
    }
    if (method === "PATCH") {
      if (type === "addendums") {
        const idx = store.addendums.findIndex((a) => a.name === body.originalName);
        store.addendums[idx] = { name: body.name, amount: Number(body.amount) };
        return json(200, store.addendums[idx]);
      }
      const idx = store[type].findIndex((v) => v === body.oldValue);
      store[type][idx] = body.newValue;
      return json(200, { value: body.newValue });
    }
    if (method === "DELETE") {
      if (type === "addendums") {
        store.addendums = store.addendums.filter((a) => a.name !== body.name);
        return json(200, { deleted: body.name });
      }
      store[type] = store[type].filter((v) => v !== body.value);
      return json(200, { deleted: body.value });
    }
  }

  return json(404, { error: `unhandled ${method} ${pathname}` });
}

function fakeIdToken(email, name) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
  const payload = Buffer.from(JSON.stringify({ email, name, email_verified: true, hd: "thegajerpractice.com" })).toString("base64");
  return `${header}.${payload}.fakesig`;
}

(async () => {
  await new Promise((resolve) => server.listen(PORT, resolve));

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(String(err)));
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

  await page.route("**/api/**", (route, request) => fakeApi(route, request));
  // Block the real Google script (no network in this sandbox) — we'll drive
  // sign-in by calling handleCredentialResponse() directly, same as Google's
  // own callback would.
  await page.route("**://accounts.google.com/**", (route) => route.abort());

  await page.goto(`http://localhost:${PORT}/`);

  // Sign-in screen should show first, app hidden.
  const signinVisible = await page.isVisible("#signin-screen");
  const appHidden = await page.evaluate(() => getComputedStyle(document.getElementById('app-content')).display === 'none');
  console.log("Sign-in screen visible:", signinVisible, "| App hidden before sign-in:", appHidden);
  if (!signinVisible || !appHidden) throw new Error("Sign-in gate is not blocking the app initially");

  // Simulate Google's callback directly.
  await page.evaluate((token) => {
    handleCredentialResponse({ credential: token });
  }, fakeIdToken("sherry@thegajerpractice.com", "Sherry"));

  await page.waitForFunction(() => document.getElementById('app-content').style.display !== 'none');
  await page.waitForTimeout(300); // let loadAllData()'s promises settle

  const signedInLabel = await page.textContent('#signed-in-as');
  console.log("Signed-in label:", signedInLabel.trim());
  if (!signedInLabel.includes('Sherry')) throw new Error("Signed-in name not shown");

  // Inventory loaded from the fake backend should be in the product datalist.
  const productOptions = await page.evaluate(() => document.getElementById('product-options').innerHTML);
  if (!productOptions.includes('BPC-157')) throw new Error("Inventory did not load into product dropdown");
  console.log("Inventory loaded OK");

  // Customer loaded from the fake backend should be selectable.
  const customerOptions = await page.evaluate(() => document.getElementById('customer-options').innerHTML);
  if (!customerOptions.includes('Jane Doe')) throw new Error("Customers did not load");
  console.log("Customers loaded OK");

  // --- Log a real transaction through the actual form ---
  await page.click('#btn-transactions');
  await page.fill('#trans-customer-input', 'Jane Doe');
  await page.fill('#trans-product-input', 'BPC-157');
  await page.dispatchEvent('#trans-product-input', 'input');
  await page.waitForTimeout(100);
  await page.fill('#trans-qty', '2');
  await page.dispatchEvent('#trans-qty', 'input');
  await page.selectOption('#trans-payment', { label: 'Cash' });
  await page.click('#btn-add-transaction');
  await page.waitForTimeout(300);

  const rowCount = await page.$$eval('#transaction-table tbody tr', (rows) => rows.length);
  console.log("Transaction rows after logging a sale:", rowCount);
  if (rowCount !== 1) throw new Error(`Expected 1 transaction row, got ${rowCount}`);
  if (store.transactions.length !== 1) throw new Error("Transaction was not persisted to the (fake) backend");

  // --- Add a new inventory item ---
  await page.click('#btn-pricing');
  await page.fill('#inv-name', 'Test Peptide');
  await page.selectOption('#inv-category', { label: 'Peptides' });
  await page.fill('#inv-price', '9.99');
  await page.click('#btn-add-pricing');
  await page.waitForTimeout(300);
  if (!store.inventory.some((i) => i.name === 'Test Peptide')) throw new Error("New inventory item was not persisted");
  console.log("Inventory add OK");

  // --- Sign out returns to the gate ---
  await page.click('#signed-in-as button');
  await page.waitForTimeout(100);
  const signinVisibleAfter = await page.isVisible("#signin-screen");
  if (!signinVisibleAfter) throw new Error("Sign out did not return to the sign-in gate");
  console.log("Sign out OK");

  // The accounts.google.com script load is deliberately blocked above (no
  // real network in this sandbox) — that expected failure is not an app bug.
  const realErrors = consoleErrors.filter((e) => !e.includes("Failed to load resource"));
  if (realErrors.length) {
    console.error("Console errors encountered:", realErrors);
    throw new Error("Page threw console errors during the run");
  }

  console.log("ALL BROWSER SMOKE TESTS PASSED");
  await browser.close();
  server.close();
})().catch((err) => {
  console.error("BROWSER TEST FAILED:", err);
  server.close();
  process.exit(1);
});
