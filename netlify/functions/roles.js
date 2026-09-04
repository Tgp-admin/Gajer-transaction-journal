const { readRange } = require("./sheets");

// A tab in the same "TJ Data" Sheet everything else already lives in —
// nothing new to connect, just one more tab. Columns: Email, Role.
const STAFF_ACCESS_TAB = process.env.STAFF_ACCESS_RANGE || "StaffAccess";

/**
 * Looks up a signed-in staff member's access level from the "StaffAccess"
 * tab. That tab only needs to list EXCEPTIONS — front-desk accounts that
 * should be limited to logging sales. Anyone not listed there (including
 * everyone already using the app before this feature existed) defaults to
 * "full" access, so adding this can't silently lock someone out.
 *
 * Dr. Gajer or Troy can add/remove/change a row on that tab at any time —
 * no code change or redeploy needed, same as every other list in this app.
 */
async function getRole(email) {
  if (!email) return "full";

  let rows;
  try {
    rows = await readRange(process.env.TJ_DATA_SHEET_ID, `${STAFF_ACCESS_TAB}!A2:B`);
  } catch (err) {
    // Tab doesn't exist yet, or some other read hiccup — fail open to
    // "full" rather than locking everyone out because of a missing tab.
    return "full";
  }

  const normalized = email.trim().toLowerCase();
  const match = (rows || []).find(
    (row) => (row[0] || "").trim().toLowerCase() === normalized
  );
  if (!match) return "full";

  const role = (match[1] || "").trim().toLowerCase();
  return role === "restricted" ? "restricted" : "full";
}

class ForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.name = "ForbiddenError";
    this.statusCode = 403;
  }
}

/**
 * Throws if a "restricted" (front-desk-only) staff member is attempting
 * anything beyond a read. Inventory, Customers, and the internal Lists all
 * call this unconditionally for every write (they still allow GET, since
 * the Log a Sale form needs to read those lists to populate its dropdowns).
 * Transactions has its own, slightly different rule (see transactions.js),
 * since a restricted account IS allowed to create — just not edit, refund,
 * or delete — a transaction.
 */
function requireFullAccess(staff, method) {
  if (staff.role === "restricted" && method !== "GET") {
    throw new ForbiddenError(
      "Your account is limited to logging sales. Ask an admin for full access if you need this."
    );
  }
}

module.exports = { getRole, requireFullAccess, ForbiddenError, STAFF_ACCESS_TAB };
