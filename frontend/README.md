# CCDI Election Frontend

Static site (no build step) for the CCDI Supreme Student Government
Election. Live voting and saved-election data come from the backend in
`../backend` over HTTP. The dashboard also includes clearly labeled demo
elections. `sessionStorage` holds short-lived auth tokens and dashboard
selection, not voter or ballot records.

## Point it at your backend

When the frontend is served from `localhost`, `127.0.0.1`, or `::1`,
`config.js` automatically uses the local backend at
`http://localhost:4000/api`. For another development hostname, edit
`config.js`:
```js
window.CCDI_API_BASE = "http://localhost:4000/api";
```
For production, update the non-local URL in `config.js` to your deployed
backend URL, such as `https://your-backend.onrender.com/api`.

## Run locally

Any static file server works, e.g.:
```
npx serve .
```
Then open the printed URL. Make sure the backend (see `../backend/README.md`)
is running and `config.js` points at it.

## How it works — students

1. **Register** — Enter Student ID, first/last name, suffix if listed,
   and email. The identity must match the roster; credentials are
   generated and emailed immediately when they do.
2. **Log in** — username + password (from the email). Same form is also
   used by admins — the backend tells the frontend which dashboard to show.
3. If voting isn't open yet, a waiting screen appears and moves on by
   itself once the election officer opens it.
4. Vote, get a confirmation. Logging in again afterward shows "already voted."

## How it works — admins

Same login form. A correct admin password triggers an **emailed OTP**
step before the dashboard opens — the code goes to the admin's Gmail via
the configured email provider. New officers can self-register via the "Sign
up for admin access" link, or an existing admin can add one from the
**Admins** tab.

The admin console includes Dashboard, Live Result, Students, Candidates,
QR Code, Activity, and Admin tabs. Use Dashboard to create a saved election
from a CSV voter list (`name, block, email`) and candidate lists; each
candidate name must uniquely match a voter. Open and close voting from the
selected election dashboard. Do not use the sample list for a live election:
sample credentials are not delivered.

Students are grouped into block cards; select a block to search, filter by
voting/credential status, and page through its roster. Election-scoped voter
lists use the same view. Passwords are never displayed. Credential resend is
available for both the general roster and active saved elections. CSV import
for the general roster is available from the Students dialog when no saved
election is selected.

Candidates are selected from the student roster, which assigns their
name and block. Add candidates under the position **Representative** to
create course-scoped races: students see only representatives whose
block has the same course prefix (for example, BSCS-1 and BSCS-3 share
the BSCS representative race).

## Deploying

This is a static site — any static host works (Netlify, Vercel, GitHub
Pages, Render static site, etc.). Just make sure:
- `config.js` points at your deployed backend URL.
- The backend's `FRONTEND_ORIGIN` environment variable matches this
  site's deployed URL (for CORS).

## Files

```
index.html   structure (letterhead, hero, card, admin dashboard, modals)
style.css    futuristic dark theme, layout, responsive rules
config.js    the one line you edit after deploying the backend
script.js    API client + all app logic
assets/      CCDI logo
```
