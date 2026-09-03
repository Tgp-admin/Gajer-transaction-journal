const { OAuth2Client } = require("google-auth-library");

class AuthError extends Error {
  constructor(message) {
    super(message);
    // Without this, `err.name` stays "Error" (extending Error does not
    // rename it automatically), so errorResponse()'s `err.name === "AuthError"`
    // check would never match and every auth failure would come back as a
    // generic 500 instead of a 401 — which breaks the frontend's "session
    // expired, sign in again" flow that specifically watches for 401.
    this.name = "AuthError";
  }
}

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
      throw new Error("Missing GOOGLE_OAUTH_CLIENT_ID env var");
    }
    client = new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID);
  }
  return client;
}

/**
 * Verifies the Google Sign-In ID token sent by the frontend in the
 * Authorization header ("Bearer <token>"), and checks the signed-in
 * account belongs to the practice's Workspace domain.
 *
 * This is the actual domain lock: it runs on every request, server-side,
 * before any Sheets read/write happens. A hostname check in the frontend
 * JS would not do this — anyone can view-source a static page, but they
 * can't forge a Google-signed ID token for a domain they don't control.
 *
 * Returns { email, name } for the verified staff member — this is what the
 * backend trusts for "who did this," NOT any name typed in the UI.
 *
 * Reused as-is from the Gajer Practice quoting app's netlify/functions/_lib/auth.js
 * so both apps share one Workspace domain restriction and one OAuth client.
 */
async function verifyRequest(event) {
  const header = event.headers.authorization || event.headers.Authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new AuthError("Missing bearer token — sign in with Google first");
  }
  const idToken = header.slice(7);

  let ticket;
  try {
    ticket = await getClient().verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
    });
  } catch (err) {
    // verifyIdToken() throws its own plain Error for anything wrong with the
    // token itself — expired ("Token used too late"), malformed, wrong
    // audience, bad signature, etc. Left as a plain Error it comes back as a
    // 500, so the frontend's apiFetch() never sees the 401 it watches for —
    // instead of a clean "please sign in again" prompt, the user sees a raw
    // error alert (which, worse, echoes the decoded token payload back at
    // them, as happened when a stale token from an earlier sign-in was
    // reused after it expired). Normalizing it to AuthError makes it a 401,
    // so the frontend's existing signOut()-on-401 handling takes over and
    // sends them back to a plain sign-in screen instead.
    throw new AuthError("Your sign-in has expired. Please sign in again.");
  }
  const payload = ticket.getPayload();
  const email = payload.email;
  const domain = payload.hd || (email || "").split("@")[1];
  const allowedDomain = process.env.ALLOWED_DOMAIN || "thegajerpractice.com";

  if (!payload.email_verified) throw new AuthError("Email not verified with Google");
  if (domain !== allowedDomain) throw new AuthError(`Account domain "${domain}" is not authorized`);

  return { email, name: payload.name || email };
}

module.exports = { verifyRequest, AuthError };
