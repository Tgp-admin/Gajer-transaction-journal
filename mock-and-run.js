// Lightweight smoke test: stubs out googleapis + google-auth-library with an
// in-memory fake Sheets store, then exercises every handler's main code
// paths (GET/POST/PATCH/DELETE, upserts, dedupe, not-found, auth rejection)
// so logic bugs surface without needing real Google credentials.

const path = require("path");
const assert = require("assert");

// ---- In-memory fake "spreadsheet" ----
// Keyed by tab name -> array of arrays (row 0 = header row).
const store = {
  Transactions: [["TxnID", "Date", "Location", "Customer", "Product", "Price", "Qty", "Discount", "Addendum", "Total", "Payment", "Notes", "IsRefund", "LoggedBy", "LoggedAt"]],
  Inventory: [["Name", "Category", "Unit", "Price"]],
  Customers: [["Name", "DOB", "Notes"]],
  Categories: [["Category"]],
  Payments: [["Method"]],
  Addendums: [["Name", "Amount"]],
};

function parseRange(range) {
  // e.g. "Transactions!A5:O5" or just "Transactions"
  const [tab, cellRange] = range.split("!");
  if (!cellRange) return { tab, rowNumber: null };
  const m = cellRange.match(/^[A-Z]+(\d+):[A-Z]+(\d+)$/);
  return { tab, rowNumber: m ? parseInt(m[1], 10) : null };
}

const fakeSheetsClient = {
  spreadsheets: {
    values: {
      get: async ({ range }) => {
        const { tab } = parseRange(range);
        return { data: { values: store[tab] || [] } };
      },
      append: async ({ range, requestBody }) => {
        const { tab } = parseRange(range);
        store[tab] = store[tab] || [];
        requestBody.values.forEach((row) => store[tab].push(row));
        return {};
      },
      update: async ({ range, requestBody }) => {
        const { tab, rowNumber } = parseRange(range);
        const idx = rowNumber - 1; // 0-based, rowNumber already 1-based sheet row
        store[tab][idx] = requestBody.values[0];
        return {};
      },
      clear: async ({ range }) => {
        const { tab, rowNumber } = parseRange(range);
        const idx = rowNumber - 1;
        store[tab][idx] = [];
        return {};
      },
    },
  },
};

// ---- Inject fake modules before any app code requires them ----
const googleapisPath = require.resolve("googleapis");
require.cache[googleapisPath] = {
  id: googleapisPath,
  filename: googleapisPath,
  loaded: true,
  exports: {
    google: {
      auth: { JWT: class { async authorize() {} } },
      sheets: () => fakeSheetsClient,
    },
  },
};

const authLibPath = require.resolve("google-auth-library");
let nextTokenPayload = { email: "sherry@thegajerpractice.com", name: "Sherry", email_verified: true, hd: "thegajerpractice.com" };
require.cache[authLibPath] = {
  id: authLibPath,
  filename: authLibPath,
  loaded: true,
  exports: {
    OAuth2Client: class {
      async verifyIdToken() {
        return { getPayload: () => nextTokenPayload };
      }
    },
  },
};

process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "svc@example.iam.gserviceaccount.com";
process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nFAKE\\n-----END PRIVATE KEY-----\\n";
process.env.GOOGLE_OAUTH_CLIENT_ID = "fake-client-id";
process.env.TJ_DATA_SHEET_ID = "fake-sheet-id";

const transactions = require(path.join(__dirname, "../netlify/functions/transactions.js"));
const inventory = require(path.join(__dirname, "../netlify/functions/inventory.js"));
const customers = require(path.join(__dirname, "../netlify/functions/customers.js"));
const lists = require(path.join(__dirname, "../netlify/functions/lists.js"));

function evt(method, { body, qs } = {}) {
  return { httpMethod: method, headers: { authorization: "Bearer faketoken" }, body: body ? JSON.stringify(body) : undefined, queryStringParameters: qs || {} };
}

(async () => {
  // --- auth rejection ---
  let res = await transactions.handler({ httpMethod: "GET", headers: {}, queryStringParameters: {} });
  assert.strictEqual(res.statusCode, 401, "missing bearer token should 401");

  nextTokenPayload = { email: "someone@gmail.com", name: "Outsider", email_verified: true, hd: undefined };
  res = await transactions.handler(evt("GET"));
  assert.strictEqual(res.statusCode, 401, "wrong domain should 401");
  nextTokenPayload = { email: "sherry@thegajerpractice.com", name: "Sherry", email_verified: true, hd: "thegajerpractice.com" };

  // --- transactions: create, list, edit (upsert), delete ---
  res = await transactions.handler(evt("POST", { body: { date: "2026-09-01", customer: "Jane Doe", productName: "BPC-157", price: 50, qty: 2, total: 100, payment: "Card", location: "Vienna" } }));
  assert.strictEqual(res.statusCode, 201);
  const created = JSON.parse(res.body);
  assert.strictEqual(created.location, "Vienna");
  assert.ok(created.id.startsWith("TXN-"));
  assert.strictEqual(created.loggedBy, "sherry@thegajerpractice.com");

  res = await transactions.handler(evt("GET"));
  let list = JSON.parse(res.body).transactions;
  assert.strictEqual(list.length, 1);

  // edit (upsert with same id) should preserve loggedBy/loggedAt and not duplicate the row
  res = await transactions.handler(evt("POST", { body: { id: created.id, date: "2026-09-01", customer: "Jane Doe", productName: "BPC-157", price: 45, qty: 2, total: 90, payment: "Cash", location: "Vienna" } }));
  assert.strictEqual(res.statusCode, 200);
  res = await transactions.handler(evt("GET"));
  list = JSON.parse(res.body).transactions;
  assert.strictEqual(list.length, 1, "editing should overwrite, not duplicate");
  assert.strictEqual(list[0].total, 90);
  assert.strictEqual(list[0].loggedBy, "sherry@thegajerpractice.com");

  res = await transactions.handler(evt("DELETE", { body: { ids: [created.id] } }));
  assert.strictEqual(res.statusCode, 200);
  res = await transactions.handler(evt("GET"));
  list = JSON.parse(res.body).transactions;
  assert.strictEqual(list.length, 0, "deleted row should be filtered out");

  // --- inventory: add, dedupe, rename via edit, delete ---
  res = await inventory.handler(evt("POST", { body: { name: "BPC-157", category: "Peptides", unit: "/mg", price: 5 } }));
  assert.strictEqual(res.statusCode, 201);
  res = await inventory.handler(evt("POST", { body: { name: "BPC-157", category: "Peptides", unit: "/mg", price: 5 } }));
  assert.strictEqual(res.statusCode, 409, "duplicate name should be rejected");
  res = await inventory.handler(evt("POST", { body: { name: "BPC-157 Extra", category: "Peptides", unit: "/mg", price: 6, originalName: "BPC-157" } }));
  assert.strictEqual(res.statusCode, 200, "rename via originalName should succeed");
  res = await inventory.handler(evt("GET"));
  assert.strictEqual(JSON.parse(res.body).inventory[0].name, "BPC-157 Extra");
  res = await inventory.handler(evt("DELETE", { body: { name: "BPC-157 Extra" } }));
  assert.strictEqual(res.statusCode, 200);
  res = await inventory.handler(evt("DELETE", { body: { name: "Does Not Exist" } }));
  assert.strictEqual(res.statusCode, 404);

  // --- customers: add, dedupe, notes edit, delete ---
  res = await customers.handler(evt("POST", { body: { name: "Jane Doe", dob: "01/02/1990", notes: "" } }));
  assert.strictEqual(res.statusCode, 201);
  res = await customers.handler(evt("POST", { body: { name: "jane doe" } }));
  assert.strictEqual(res.statusCode, 409, "case-insensitive dedupe should trigger");
  res = await customers.handler(evt("PATCH", { body: { originalName: "Jane Doe", name: "Jane Doe", dob: "01/02/1990", notes: "Prefers Vienna location" } }));
  assert.strictEqual(res.statusCode, 200);
  res = await customers.handler(evt("GET"));
  assert.strictEqual(JSON.parse(res.body).customers[0].notes, "Prefers Vienna location");
  res = await customers.handler(evt("DELETE", { body: { name: "Jane Doe" } }));
  assert.strictEqual(res.statusCode, 200);

  // --- lists: categories/payments/addendums ---
  res = await lists.handler(evt("POST", { body: { value: "Peptides" }, qs: { type: "categories" } }));
  assert.strictEqual(res.statusCode, 201);
  res = await lists.handler(evt("GET", { qs: { type: "categories" } }));
  assert.deepStrictEqual(JSON.parse(res.body).items, ["Peptides"]);
  res = await lists.handler(evt("PATCH", { body: { oldValue: "Peptides", newValue: "Injectable Peptides" }, qs: { type: "categories" } }));
  assert.strictEqual(res.statusCode, 200);
  res = await lists.handler(evt("GET", { qs: { type: "categories" } }));
  assert.deepStrictEqual(JSON.parse(res.body).items, ["Injectable Peptides"]);

  res = await lists.handler(evt("POST", { body: { name: "Booking Fee", amount: 15 }, qs: { type: "addendums" } }));
  assert.strictEqual(res.statusCode, 201);
  res = await lists.handler(evt("GET", { qs: { type: "addendums" } }));
  assert.deepStrictEqual(JSON.parse(res.body).items, [{ name: "Booking Fee", amount: 15 }]);
  res = await lists.handler(evt("DELETE", { body: { name: "Booking Fee" }, qs: { type: "addendums" } }));
  assert.strictEqual(res.statusCode, 200);

  res = await lists.handler(evt("GET", { qs: { type: "bogus" } }));
  assert.strictEqual(res.statusCode, 400, "unknown type should 400");

  console.log("ALL SMOKE TESTS PASSED");
})().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
