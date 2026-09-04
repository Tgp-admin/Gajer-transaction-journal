const { readRange, appendRow, updateRange, clearRange, colLetter } = require("./_lib/sheets");
const { verifyRequest } = require("./_lib/auth");
const { rowsToObjects, toNumber, json, errorResponse, corsHeaders } = require("./_lib/rows");

const RANGE = process.env.TRANSACTIONS_RANGE || "Transactions";

// Transactions tab header row (one row per line item, shared across both locations):
//   TxnID | Date | Location | Customer | Product | Price | Qty | Discount | Addendum |
//   Total | Payment | Notes | IsRefund | LoggedBy | LoggedAt
const COLUMNS = [
  "TxnID", "Date", "Location", "Customer", "Product", "Price", "Qty", "Discount", "Addendum",
  "Total", "Payment", "Notes", "IsRefund", "LoggedBy", "LoggedAt",
];
const LAST_COL = colLetter(COLUMNS.length);

function rowFromFields(f) {
  return [
    f.id, f.date, f.location || "Burke", f.customer, f.productName,
    Number(f.price) || 0, Number(f.qty) || 0, f.discount || "None", f.addendum || "None",
    Number(f.total) || 0, f.payment, f.notes || "",
    f.isRefund ? "TRUE" : "FALSE", f.loggedBy || "", f.loggedAt || "",
  ];
}

function fieldsFromRow(r) {
  return {
    id: r.TxnID,
    date: r.Date,
    location: r.Location || "Burke",
    customer: r.Customer,
    productName: r.Product,
    price: toNumber(r.Price),
    qty: toNumber(r.Qty),
    discount: r.Discount || "None",
    addendum: r.Addendum || "None",
    total: toNumber(r.Total),
    payment: r.Payment,
    notes: r.Notes || "",
    isRefund: String(r.IsRefund).toUpperCase() === "TRUE",
    loggedBy: r.LoggedBy || "",
    loggedAt: r.LoggedAt || "",
  };
}

function generateId() {
  return "TXN-" + Math.random().toString(36).substring(2, 8).toUpperCase();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    // Transactions has no role restriction: a "restricted" (front-desk-only)
    // account gets full use of this tab — logging sales plus the copy,
    // edit, refund, and delete tools — per Troy's call. The only tabs a
    // restricted account can't touch are Pricing & Inventory and TJ
    // Internal (see inventory.js, customers.js, lists.js).
    const staff = await verifyRequest(event);

    if (event.httpMethod === "GET") {
      const rows = await readRange(process.env.TJ_DATA_SHEET_ID, RANGE);
      const transactions = rowsToObjects(rows).filter((r) => r.TxnID).map(fieldsFromRow);
      return json(200, { transactions });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const { date, customer, productName, payment } = body;
      if (!date || !customer || !productName || !payment) {
        return json(400, { error: "date, customer, productName, and payment are required" });
      }

      // Upsert by id: lets a single endpoint cover "log a new sale" (no id
      // sent, one gets generated below), "edit an existing line" and "CSV
      // import" (id sent — update in place if it already exists) without
      // three separate code paths, mirroring how the app already treats
      // these as the same underlying action client-side.
      const rawRows = await readRange(process.env.TJ_DATA_SHEET_ID, RANGE);
      const objects = rowsToObjects(rawRows);
      const id = body.id || generateId();
      const rowIndex = objects.findIndex((r) => r.TxnID === id);

      const record = {
        id,
        date: body.date,
        location: body.location === "Vienna" ? "Vienna" : "Burke",
        customer: body.customer,
        productName: body.productName,
        price: body.price,
        qty: body.qty,
        discount: body.discount,
        addendum: body.addendum,
        total: body.total,
        payment: body.payment,
        notes: body.notes,
        isRefund: !!body.isRefund,
        loggedBy: staff.email,
        loggedAt: new Date().toISOString(),
      };

      if (rowIndex >= 0) {
        // Preserve the original LoggedBy/LoggedAt — an edit shouldn't erase
        // who originally logged the sale, only record has changed.
        record.loggedBy = objects[rowIndex].LoggedBy || record.loggedBy;
        record.loggedAt = objects[rowIndex].LoggedAt || record.loggedAt;
        const sheetRowNumber = rowIndex + 2;
        await updateRange(process.env.TJ_DATA_SHEET_ID, `${RANGE}!A${sheetRowNumber}:${LAST_COL}${sheetRowNumber}`, rowFromFields(record));
      } else {
        await appendRow(process.env.TJ_DATA_SHEET_ID, RANGE, rowFromFields(record));
      }

      return json(rowIndex >= 0 ? 200 : 201, fieldsFromRow({
        TxnID: record.id, Date: record.date, Location: record.location, Customer: record.customer,
        Product: record.productName, Price: record.price, Qty: record.qty, Discount: record.discount,
        Addendum: record.addendum, Total: record.total, Payment: record.payment, Notes: record.notes,
        IsRefund: record.isRefund ? "TRUE" : "FALSE", LoggedBy: record.loggedBy, LoggedAt: record.loggedAt,
      }));
    }

    if (event.httpMethod === "DELETE") {
      const body = JSON.parse(event.body || "{}");
      const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
      if (!ids.length) return json(400, { error: "ids[] (or id) is required" });

      const rawRows = await readRange(process.env.TJ_DATA_SHEET_ID, RANGE);
      const objects = rowsToObjects(rawRows);
      const idSet = new Set(ids);
      const matchingRowNumbers = objects
        .map((r, i) => (idSet.has(r.TxnID) ? i + 2 : null))
        .filter((n) => n !== null);

      await Promise.all(
        matchingRowNumbers.map((n) => clearRange(process.env.TJ_DATA_SHEET_ID, `${RANGE}!A${n}:${LAST_COL}${n}`))
      );

      return json(200, { deleted: matchingRowNumbers.length });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return errorResponse(err);
  }
};
