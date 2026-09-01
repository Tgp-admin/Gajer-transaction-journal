const { readRange, appendRow, updateRange, clearRange, colLetter } = require("./_lib/sheets");
const { verifyRequest } = require("./_lib/auth");
const { rowsToObjects, toNumber, json, errorResponse, corsHeaders } = require("./_lib/rows");

const RANGE = process.env.INVENTORY_RANGE || "Inventory";

// Inventory tab header row: Name | Category | Unit | Price
const COLUMNS = ["Name", "Category", "Unit", "Price"];
const LAST_COL = colLetter(COLUMNS.length);

function rowFromFields(f) {
  return [f.name, f.category, f.unit, Number(f.price) || 0];
}

function fieldsFromRow(r) {
  return { name: r.Name, category: r.Category, unit: r.Unit, price: toNumber(r.Price) };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    await verifyRequest(event);

    if (event.httpMethod === "GET") {
      const rows = await readRange(process.env.TJ_DATA_SHEET_ID, RANGE);
      const inventory = rowsToObjects(rows).filter((r) => r.Name).map(fieldsFromRow);
      return json(200, { inventory });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const { name, category, unit, price, originalName } = body;
      if (!name || !category || price === undefined || price === null || isNaN(Number(price))) {
        return json(400, { error: "name, category, and a valid price are required" });
      }

      const rawRows = await readRange(process.env.TJ_DATA_SHEET_ID, RANGE);
      const objects = rowsToObjects(rawRows);

      if (originalName) {
        // Editing an existing item — find it by its previous name (which may
        // equal the new name, or may be a rename) and overwrite that row.
        const rowIndex = objects.findIndex((r) => (r.Name || "").toLowerCase() === originalName.toLowerCase());
        if (rowIndex === -1) return json(404, { error: `No inventory item named "${originalName}" found` });
        const sheetRowNumber = rowIndex + 2;
        await updateRange(process.env.TJ_DATA_SHEET_ID, `${RANGE}!A${sheetRowNumber}:${LAST_COL}${sheetRowNumber}`, rowFromFields({ name, category, unit, price }));
        return json(200, { name, category, unit, price: Number(price) });
      }

      const exists = objects.some((r) => (r.Name || "").toLowerCase() === name.toLowerCase());
      if (exists) return json(409, { error: "An item with this exact name already exists." });

      await appendRow(process.env.TJ_DATA_SHEET_ID, RANGE, rowFromFields({ name, category, unit, price }));
      return json(201, { name, category, unit, price: Number(price) });
    }

    if (event.httpMethod === "DELETE") {
      const body = JSON.parse(event.body || "{}");
      if (!body.name) return json(400, { error: "name is required" });

      const rawRows = await readRange(process.env.TJ_DATA_SHEET_ID, RANGE);
      const objects = rowsToObjects(rawRows);
      const rowIndex = objects.findIndex((r) => (r.Name || "").toLowerCase() === body.name.toLowerCase());
      if (rowIndex === -1) return json(404, { error: `No inventory item named "${body.name}" found` });

      const sheetRowNumber = rowIndex + 2;
      await clearRange(process.env.TJ_DATA_SHEET_ID, `${RANGE}!A${sheetRowNumber}:${LAST_COL}${sheetRowNumber}`);
      return json(200, { deleted: body.name });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return errorResponse(err);
  }
};
