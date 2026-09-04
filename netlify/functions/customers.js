const { readRange, appendRow, updateRange, clearRange, colLetter } = require("./_lib/sheets");
const { verifyRequest } = require("./_lib/auth");
const { ForbiddenError } = require("./_lib/roles");
const { rowsToObjects, json, errorResponse, corsHeaders } = require("./_lib/rows");

const RANGE = process.env.CUSTOMERS_RANGE || "Customers";

// Customers tab header row: Name | DOB | Notes
const COLUMNS = ["Name", "DOB", "Notes"];
const LAST_COL = colLetter(COLUMNS.length);

function rowFromFields(f) {
  return [f.name, f.dob || "N/A", f.notes || ""];
}

function fieldsFromRow(r) {
  return { name: r.Name, dob: r.DOB || "N/A", notes: r.Notes || "" };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const staff = await verifyRequest(event);

    // Adding or removing a customer only happens from the TJ Internal tab,
    // which a "restricted" (front-desk-only) account can't see — so block
    // it here too. PATCH stays open for everyone: it's also how the "Save
    // Notes" panel on the Transactions tab works, which Troy wants
    // restricted accounts to keep using; GET stays open too, since the Log
    // a Sale form's customer dropdown needs it regardless of role.
    if (staff.role === "restricted" && (event.httpMethod === "POST" || event.httpMethod === "DELETE")) {
      throw new ForbiddenError("Your account can't add or remove customers — that's managed on the TJ Internal tab.");
    }

    if (event.httpMethod === "GET") {
      const rows = await readRange(process.env.TJ_DATA_SHEET_ID, RANGE);
      const customers = rowsToObjects(rows).filter((r) => r.Name).map(fieldsFromRow);
      return json(200, { customers });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const name = (body.name || "").trim();
      if (!name) return json(400, { error: "name is required" });

      const rawRows = await readRange(process.env.TJ_DATA_SHEET_ID, RANGE);
      const objects = rowsToObjects(rawRows);
      const exists = objects.some((r) => (r.Name || "").toLowerCase() === name.toLowerCase());
      if (exists) return json(409, { error: "This customer name already exists!" });

      await appendRow(process.env.TJ_DATA_SHEET_ID, RANGE, rowFromFields({ name, dob: body.dob, notes: body.notes }));
      return json(201, { name, dob: body.dob || "N/A", notes: body.notes || "" });
    }

    if (event.httpMethod === "PATCH") {
      // Handles both a full edit (name/dob/notes) and the standalone
      // "Save Notes" panel (same shape, only notes actually changed) —
      // the frontend always sends the complete record either way.
      const body = JSON.parse(event.body || "{}");
      const originalName = (body.originalName || body.name || "").trim();
      const name = (body.name || "").trim();
      if (!originalName || !name) return json(400, { error: "originalName and name are required" });

      const rawRows = await readRange(process.env.TJ_DATA_SHEET_ID, RANGE);
      const objects = rowsToObjects(rawRows);
      const rowIndex = objects.findIndex((r) => (r.Name || "").toLowerCase() === originalName.toLowerCase());
      if (rowIndex === -1) return json(404, { error: `No customer named "${originalName}" found` });

      const sheetRowNumber = rowIndex + 2;
      await updateRange(process.env.TJ_DATA_SHEET_ID, `${RANGE}!A${sheetRowNumber}:${LAST_COL}${sheetRowNumber}`, rowFromFields({ name, dob: body.dob, notes: body.notes }));
      return json(200, { name, dob: body.dob || "N/A", notes: body.notes || "" });
    }

    if (event.httpMethod === "DELETE") {
      const body = JSON.parse(event.body || "{}");
      if (!body.name) return json(400, { error: "name is required" });

      const rawRows = await readRange(process.env.TJ_DATA_SHEET_ID, RANGE);
      const objects = rowsToObjects(rawRows);
      const rowIndex = objects.findIndex((r) => (r.Name || "").toLowerCase() === body.name.toLowerCase());
      if (rowIndex === -1) return json(404, { error: `No customer named "${body.name}" found` });

      const sheetRowNumber = rowIndex + 2;
      await clearRange(process.env.TJ_DATA_SHEET_ID, `${RANGE}!A${sheetRowNumber}:${LAST_COL}${sheetRowNumber}`);
      return json(200, { deleted: body.name });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return errorResponse(err);
  }
};
