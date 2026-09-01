const { readRange, appendRow, updateRange, clearRange, colLetter } = require("./_lib/sheets");
const { verifyRequest } = require("./_lib/auth");
const { rowsToObjects, toNumber, json, errorResponse, corsHeaders } = require("./_lib/rows");

// Three simple dropdown-management lists share this one function, keyed by
// a ?type= query param — same idea as the app's own internalData object,
// which already treats these three the same way client-side.
//
// Categories tab header row: Category
// Payments tab header row:   Method
// Addendums tab header row:  Name | Amount
const TYPES = {
  categories: { range: () => process.env.CATEGORIES_RANGE || "Categories", headerKey: "Category", lastCol: colLetter(1) },
  payments: { range: () => process.env.PAYMENTS_RANGE || "Payments", headerKey: "Method", lastCol: colLetter(1) },
  addendums: { range: () => process.env.ADDENDUMS_RANGE || "Addendums", headerKey: null, lastCol: colLetter(2) },
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    await verifyRequest(event);

    const type = (event.queryStringParameters || {}).type;
    const config = TYPES[type];
    if (!config) return json(400, { error: 'type must be one of "categories", "payments", or "addendums"' });
    const range = config.range();
    const isAddendums = type === "addendums";

    if (event.httpMethod === "GET") {
      const rows = await readRange(process.env.TJ_DATA_SHEET_ID, range);
      if (isAddendums) {
        const items = rowsToObjects(rows)
          .filter((r) => r.Name)
          .map((r) => ({ name: r.Name, amount: toNumber(r.Amount) }));
        return json(200, { items });
      }
      const items = rowsToObjects(rows)
        .map((r) => r[config.headerKey])
        .filter((v) => v && String(v).trim());
      return json(200, { items });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const rawRows = await readRange(process.env.TJ_DATA_SHEET_ID, range);
      const objects = rowsToObjects(rawRows);

      if (isAddendums) {
        const name = (body.name || "").trim();
        if (!name) return json(400, { error: "name is required" });
        const exists = objects.some((r) => (r.Name || "").toLowerCase() === name.toLowerCase());
        if (exists) return json(409, { error: "An addendum with this name already exists!" });
        const amount = Number(body.amount) || 0;
        await appendRow(process.env.TJ_DATA_SHEET_ID, range, [name, amount]);
        return json(201, { name, amount });
      }

      const value = (body.value || "").trim();
      if (!value) return json(400, { error: "value is required" });
      const exists = objects.some((r) => (r[config.headerKey] || "").toLowerCase() === value.toLowerCase());
      if (exists) return json(409, { error: "This item already exists." });
      await appendRow(process.env.TJ_DATA_SHEET_ID, range, [value]);
      return json(201, { value });
    }

    if (event.httpMethod === "PATCH") {
      const body = JSON.parse(event.body || "{}");
      const rawRows = await readRange(process.env.TJ_DATA_SHEET_ID, range);
      const objects = rowsToObjects(rawRows);

      if (isAddendums) {
        const originalName = (body.originalName || "").trim();
        const name = (body.name || "").trim();
        if (!originalName || !name) return json(400, { error: "originalName and name are required" });
        const rowIndex = objects.findIndex((r) => (r.Name || "").toLowerCase() === originalName.toLowerCase());
        if (rowIndex === -1) return json(404, { error: `No addendum named "${originalName}" found` });
        const amount = Number(body.amount) || 0;
        const sheetRowNumber = rowIndex + 2;
        await updateRange(process.env.TJ_DATA_SHEET_ID, `${range}!A${sheetRowNumber}:${config.lastCol}${sheetRowNumber}`, [name, amount]);
        return json(200, { name, amount });
      }

      const oldValue = (body.oldValue || "").trim();
      const newValue = (body.newValue || "").trim();
      if (!oldValue || !newValue) return json(400, { error: "oldValue and newValue are required" });
      const rowIndex = objects.findIndex((r) => (r[config.headerKey] || "").toLowerCase() === oldValue.toLowerCase());
      if (rowIndex === -1) return json(404, { error: `"${oldValue}" not found` });
      const sheetRowNumber = rowIndex + 2;
      await updateRange(process.env.TJ_DATA_SHEET_ID, `${range}!A${sheetRowNumber}:${config.lastCol}${sheetRowNumber}`, [newValue]);
      return json(200, { value: newValue });
    }

    if (event.httpMethod === "DELETE") {
      const body = JSON.parse(event.body || "{}");
      const rawRows = await readRange(process.env.TJ_DATA_SHEET_ID, range);
      const objects = rowsToObjects(rawRows);

      const key = isAddendums ? (body.name || "").trim() : (body.value || "").trim();
      if (!key) return json(400, { error: isAddendums ? "name is required" : "value is required" });

      const rowIndex = objects.findIndex((r) =>
        (isAddendums ? r.Name || "" : r[config.headerKey] || "").toLowerCase() === key.toLowerCase()
      );
      if (rowIndex === -1) return json(404, { error: `"${key}" not found` });

      const sheetRowNumber = rowIndex + 2;
      await clearRange(process.env.TJ_DATA_SHEET_ID, `${range}!A${sheetRowNumber}:${config.lastCol}${sheetRowNumber}`);
      return json(200, { deleted: key });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return errorResponse(err);
  }
};
