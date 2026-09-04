const { verifyRequest } = require("./_lib/auth");
const { json, errorResponse, corsHeaders } = require("./_lib/rows");

// Tells the frontend who's signed in and what they're allowed to do, so it
// can show a front-desk account only the "Log a Sale" screen instead of the
// whole app. This is a UI convenience only — the real enforcement is
// server-side in every other function's own role check (see _lib/roles.js),
// exactly like the domain lock itself.
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const staff = await verifyRequest(event);
    return json(200, { email: staff.email, name: staff.name, role: staff.role });
  } catch (err) {
    return errorResponse(err);
  }
};
