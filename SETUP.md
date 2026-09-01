# Setting up the Transaction Journal's Google Sheets backend

This turns Troy's Master Transaction Journal from a browser-only tool (each computer had its own separate, invisible-to-everyone-else copy of the data) into one shared tool: Burke and Vienna both read and write the same Google Sheet, and only signed-in `@thegajerpractice.com` Google accounts can get in.

It reuses the same Google Cloud project, OAuth client, and service account as the peptide quoting app — you are not creating any new Google Cloud credentials for this.

## What you're deploying

A new, separate Netlify site containing:
- `public/index.html` — the Transaction Journal itself (this is Troy's app, with a sign-in screen added and its data layer pointed at the API below instead of the browser's local storage)
- `netlify/functions/` — four small backend functions (`transactions`, `inventory`, `customers`, `lists`) that read and write a Google Sheet
- everything needed to deploy straight to Netlify

## Step 1 — Create the Google Sheet

1. Create a new Google Sheet. Name it something like **TJ Data**.
2. Create six tabs (bottom of the sheet), and type this exact header row as row 1 of each:

   | Tab name | Row 1 (header) |
   |---|---|
   | `Transactions` | `TxnID`, `Date`, `Location`, `Customer`, `Product`, `Price`, `Qty`, `Discount`, `Addendum`, `Total`, `Payment`, `Notes`, `IsRefund`, `LoggedBy`, `LoggedAt` |
   | `Inventory` | `Name`, `Category`, `Unit`, `Price` |
   | `Customers` | `Name`, `DOB`, `Notes` |
   | `Categories` | `Category` |
   | `Payments` | `Method` |
   | `Addendums` | `Name`, `Amount` |

   (Tab names and header text must match exactly — the backend looks them up by these names.)

3. Click **Share** on the sheet and add your existing service account's email address (the same one the quoting app already uses — look it up in that project's Netlify environment variables under `GOOGLE_SERVICE_ACCOUNT_EMAIL`) as an **Editor**. Without this step, every request will fail with a permissions error.
4. Copy the Sheet's ID out of its URL — the long string between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART_IS_THE_SHEET_ID`**`/edit`

## Step 2 — Create the new Netlify site

1. In Netlify, create a new site from this project's files (either connect it to a new Git repo containing this folder, or drag-and-drop deploy it — either works since there's no build step).
2. Once created, go to **Site configuration → Environment variables** and add:

   | Variable | Value |
   |---|---|
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | same value as the quoting app's site |
   | `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | same value as the quoting app's site (copy it exactly, quotes and all — the code strips wrapping quotes and fixes line breaks automatically) |
   | `GOOGLE_OAUTH_CLIENT_ID` | same value as the quoting app's site |
   | `ALLOWED_DOMAIN` | `thegajerpractice.com` (this is already the default if you skip it, but setting it explicitly is fine) |
   | `TJ_DATA_SHEET_ID` | the Sheet ID from Step 1 |

3. Deploy the site. Netlify will install `googleapis` and `google-auth-library` automatically from `package.json`.
4. Open the deployed URL — you should see the sign-in screen. Sign in with an `@thegajerpractice.com` account; anything else will be rejected (that's the domain lock working).

## Step 3 — Migrate your existing data (optional)

If you or Troy have real transactions, inventory, or customer data already sitting in a browser's local storage from the old version:

1. Open the **old** version of the app in that same browser (the one with the data).
2. Use its existing **Export to Excel** buttons: Transactions tab → "Export View to Excel", Pricing & Inventory tab → "Export to Excel (CSV)", TJ Internal tab → each list's "Export CSV" button.
3. Sign in to the **new** version, and use the matching **Import CSV** buttons on each tab to load that data in. Each import calls the new backend directly, so the data lands straight in the Google Sheet — no copy-pasting into the Sheet by hand.

## What actually changed in the app

- **Domain lock**: every request to `/api/...` now requires a valid Google-signed ID token for an `@thegajerpractice.com` account. This check happens on the server (`verifyRequest` in `netlify/functions/_lib/auth.js`), not in the page's JavaScript — so it can't be bypassed by viewing source, only by actually signing in with an authorized account. This is the exact same function your quoting app already uses.
- **Shared data**: `transactions`, `inventory`, and the internal dropdown lists (categories, payments, addendums, customers) are now loaded from and saved to the shared Google Sheet on every add/edit/delete, instead of the browser's local storage. Two people at two locations now see the same data.
- **Everything else is unchanged**: refunds, bulk delete, CSV import/export, the reports and calendar views, customer notes — all work exactly as before, just against shared data now.

## One thing worth fixing in the quoting app too

While building this, I found a small bug in the `auth.js` your existing app already uses: `class AuthError extends Error {}` doesn't actually set `.name` to `"AuthError"` (extending `Error` in JavaScript doesn't do that automatically). Since `errorResponse()` checks `err.name === "AuthError"` to decide whether to return a 401, an expired or invalid sign-in token currently comes back as a generic 500 error instead of a clean "please sign in again" — meaning the frontend's automatic re-sign-in prompt for expired sessions likely never triggers in the quoting app today. I fixed this in the copy used here (adding a constructor that sets `this.name = "AuthError"`); it'd be a one-line fix to carry over to the quoting app's `auth.js` too, whenever convenient.
