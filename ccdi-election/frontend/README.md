# CCDI Election Frontend

Static site (no build step) for the CCDI Supreme Student Government
Election. Talks to the backend in `../backend` over HTTP — there's no
local storage or fake data left in this version; everything comes from
Supabase through the API.

## Point it at your backend

Edit `config.js`:
```js
window.CCDI_API_BASE = "https://your-backend.onrender.com/api";
```
Defaults to `http://localhost:4000/api` for local development against a
locally-running backend.

## Run locally

Any static file server works, e.g.:
```
npx serve .
```
Then open the printed URL. Make sure the backend (see `../backend/README.md`)
is running and `config.js` points at it.

## How it works — students

1. **Register** — Student ID + email. First time, this saves the email
   against that ID, generates a username/password, and emails them.
   After that, the same ID + email just tells you to log in instead.
2. **Log in** — username + password (from the email). Same form is also
   used by admins — the backend tells the frontend which dashboard to show.
3. If voting isn't open yet, a waiting screen appears and moves on by
   itself once the election officer opens it.
4. Vote, get a confirmation. Logging in again afterward shows "already voted."

## How it works — admins

Same login form. A correct admin password triggers an **emailed OTP**
step before the dashboard opens — the code goes to the admin's Gmail via
the backend's SMTP config. New officers can self-register via the "Sign
up for admin access" link, or an existing admin can add one from the
**Admins** tab.

The dashboard (**Election Portal**) has tabs for Candidates, Students
(with CSV import), QR Codes (a single QR linking back to this site —
not tied to any student), Monitoring, Results, and Admins. The
**Election status** card controls whether students can reach the ballot
at all.

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
