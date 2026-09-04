# CCDI Supreme Student Government Election

A full voting system for CCDI Sorsogon City: a dark, futuristic frontend
and an Express + Supabase backend, deployable to Render.

```
frontend/    static site — the voting portal students and admins use
backend/     Express API — Supabase database, email, auth, votes
render.yaml  one-click backend deploy blueprint for Render
```

## How the pieces fit together

- **Supabase** is the database: students, admins, candidates, votes, and
  the global voting on/off switch.
- **Backend** (`backend/`) is the only thing allowed to talk to Supabase
  directly (using the service role key). It handles registration, login,
  OTP email for admins, voting, and every admin action.
- **Frontend** (`frontend/`) is a static site that only talks to the
  backend's API — no database credentials, no localStorage data, nothing
  sensitive lives in the browser.

## Quick start (local)

1. **Supabase** — create a project, run `backend/sql/schema.sql` in the
   SQL editor, grab your Project URL and service role key.
2. **Backend:**
   ```
   cd backend
   cp .env.example .env      # fill in Supabase keys, JWT_SECRET, SMTP (optional)
   npm install
   npm start
   ```
3. **Import a roster** (either works):
   ```
   node backend/scripts/import-students.js backend/sample-students.csv
   ```
   or upload the same CSV from the admin dashboard's Students tab later.
4. **Frontend:**
   ```
   cd frontend
   npx serve .
   ```
   `config.js` already points at `http://localhost:4000/api` by default.
5. Open the frontend, click **"Sign up for admin access"** to create your
   first admin account, log in (check your email for the OTP, or read it
   from the "dev preview" note if SMTP isn't configured yet), open
   **Election status → Voting OPEN**, then test registering as a student
   using an ID from the sample CSV.

Full details, including SMTP setup and every environment variable, are in
`backend/README.md`. Frontend-specific notes are in `frontend/README.md`.

## Deploying for real

1. Push this whole folder to a GitHub repo.
2. **Backend → Render:** New Web Service (or use `render.yaml` via
   Render's Blueprints), root directory `backend`, add the environment
   variables from `.env.example`. See `backend/README.md` for the full
   walkthrough.
3. **Frontend → any static host** (Netlify, Vercel, GitHub Pages, or
   Render's static site type): deploy the `frontend/` folder, then edit
   `frontend/config.js` to point at your Render backend URL and
   redeploy.
4. Set the backend's `FRONTEND_ORIGIN` env var to the frontend's real
   URL and redeploy the backend (CORS needs both sides to agree).

## What's enforced where

- **One vote per student:** a unique database constraint on
  `(student_id_no, position)`, not just a flag the frontend checks — so
  it holds even under concurrent requests from different devices.
- **Voting only when open:** checked server-side on both `GET /api/ballot`
  and `POST /api/vote`, not just hidden in the UI.
- **Email must match the ID on file:** enforced in
  `POST /api/auth/student/lookup` before any credentials are generated.
- **Passwords:** hashed with bcrypt everywhere, never logged or stored
  in plain text (the one exception is the clearly-labeled "dev preview"
  shown only when no SMTP is configured, for local testing).
