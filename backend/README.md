# CCDI Election Backend

Express API backed by Supabase (Postgres) for the CCDI Supreme Student
Government Election. Handles student registration (ID + email →
generated login, emailed), unified login with role-based redirect, admin
OTP verification by email, voting (gated on an admin-controlled
open/closed switch), and CSV roster import.

## 1. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine).
2. Open **SQL Editor → New query**, paste the contents of `sql/schema.sql`,
   and run it. This creates all tables and locks them down with Row Level
   Security so only your backend (using the service role key) can touch them.
3. Go to **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role key** (not the `anon` key — the backend needs to
     bypass RLS) → `SUPABASE_SERVICE_ROLE_KEY`

## 2. Set up outgoing email

Any SMTP provider works. The simplest free option for a school project is
Gmail with an **App Password**:

1. Turn on 2-Step Verification on the sending Gmail account.
2. Google Account → Security → **App passwords** → create one for "Mail".
3. Use those in `.env`:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_SECURE=true
   SMTP_USER=your-address@gmail.com
   SMTP_PASS=the-16-character-app-password
   ```

If you skip this step, the server still runs — registration and admin
OTP emails just aren't actually delivered. The API responds with the
generated credentials/code directly instead (clearly labeled "dev
preview") so you can still test the whole flow before email is wired up.

## 3. Configure environment variables

```
cp .env.example .env
```
Fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET` (any
long random string), the SMTP block above, and `FRONTEND_ORIGIN` (the
deployed frontend URL, no trailing slash — use `*` while testing locally).

## 4. Run locally

```
npm install
npm start
```
Server listens on `PORT` (default `4000`). Check `http://localhost:4000/api/health`.

## 5. Import your student roster

Two ways — use either, or both:

**A. Command line (bulk, one-time or repeatable):**
```
node scripts/import-students.js path/to/students.csv
```
CSV needs headers `id_no, name, block` (a `sample-students.csv` is
included to try this with). Safe to re-run — existing IDs are updated
(name/block only, never touches email or voting credentials), new IDs
are inserted.

**B. Admin dashboard:** log in as an admin → **Students** tab → **Import
roster from CSV** → choose the same kind of file. Same rules apply.

## 6. Create your first admin account

There's no seeded admin account — sign up through the running frontend
(the "Sign up for admin access" link under the login card), or call the
API directly:
```
curl -X POST http://localhost:4000/api/auth/admin/signup \
  -H "Content-Type: application/json" \
  -d '{"name":"Election Officer","email":"you@gmail.com","username":"ssg.officer","password":"choose-a-strong-one"}'
```
(Must be a `@gmail.com` address — that's what the OTP gets sent to.)

## 7. Deploy to Render

1. Push this repo to GitHub.
2. Render dashboard → **New → Web Service** → connect the repo.
3. **Root Directory:** `backend`
4. **Build Command:** `npm install`
5. **Start Command:** `npm start`
6. Add all the environment variables from step 3 in Render's **Environment** tab.
7. Deploy. Render gives you a URL like `https://ccdi-election-backend.onrender.com`.
8. Set `FRONTEND_ORIGIN` to your deployed frontend's URL, and redeploy.
9. Put that backend URL (+ `/api`) into `frontend/config.js`.

A `render.yaml` is included at the repo root if you'd rather use Render's
Blueprints (New → Blueprint → point at this repo).

> **Free-tier note:** Render's free web services spin down after periods
> of inactivity and take a few seconds to wake up on the next request —
> normal, not a bug. Upgrade the plan if you need it always warm on
> election day.

## API overview

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/student/lookup` | — | Register/verify by ID + email, emails credentials |
| POST | `/api/auth/student/resend` | — | Re-send a fresh password to a matching ID + email |
| POST | `/api/auth/login` | — | Unified login; admins get an OTP step, students get a session |
| POST | `/api/auth/admin/signup` | — | Create a new admin account |
| POST | `/api/auth/admin/verify-otp` | — | Finish admin login with the emailed code |
| GET | `/api/me` | student | Current student status + whether voting is open |
| GET | `/api/ballot` | student | Candidates grouped by position (only while voting is open) |
| POST | `/api/vote` | student | Cast a vote (one row per position, server-enforced) |
| GET/POST/DELETE | `/api/admin/students` | admin | Roster CRUD |
| POST | `/api/admin/students/import` | admin | CSV bulk import |
| GET/POST/DELETE | `/api/admin/candidates` | admin | Candidate CRUD |
| GET | `/api/admin/results` | admin | Vote tally per position |
| GET/POST | `/api/admin/settings/voting-open` | admin | Read/flip the election on-off switch |
| GET/POST/DELETE | `/api/admin/admins` | admin | Manage other admin accounts |
| GET | `/api/admin/stats` | admin | Dashboard summary numbers |

"student"/"admin" auth means a `Authorization: Bearer <token>` header
with the JWT returned at login.

## Security notes for going further

- Passwords are hashed with bcrypt — never stored or logged in plain text
  (except the one-time "dev preview" shown only when SMTP isn't
  configured, meant for local testing).
- RLS is enabled with **no** public policies, so leaking the anon key
  can't expose data — only the service role key (server-side only) can
  read/write.
- The unique constraint on `votes (student_id_no, position)` is what
  actually stops a double vote, even under concurrent requests — not
  just the `voted` flag check.
- OTP codes expire after 5 minutes and are deleted once used.
- For real production use: add rate limiting on the login/OTP endpoints,
  and consider short-lived refresh tokens instead of a single 3–6 hour JWT.
