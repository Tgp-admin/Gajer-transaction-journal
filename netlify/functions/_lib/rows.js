/** Convert raw sheet rows (array of arrays, first row = headers) into objects. */
function rowsToObjects(rows) {
  if (!rows || !rows.length) return [];
  const headers = rows[0].map((h) => (h || "").toString().trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = r[i];
    });
    return obj;
  });
}

function toNumber(v) {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return isFinite(n) ? n : 0;
}

const CORS_HEADERS = {
  "Content-Type": "application/json",
};

function corsHeaders() {
  return {
    ...CORS_HEADERS,
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  };
}

function json(statusCode, data) {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(data) };
}

function errorResponse(err) {
  const status = err.name === "AuthError" ? 401 : err.statusCode || 500;
  // eslint-disable-next-line no-console
  console.error(err);
  return json(status, { error: err.message || "Internal error" });
}

module.exports = { rowsToObjects, toNumber, json, errorResponse, corsHeaders };
