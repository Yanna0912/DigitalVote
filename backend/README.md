# CCDI Election Backend

Express API backed by Supabase (Postgres) for the CCDI Supreme Student
Government Election. Handles roster-matched student registration (ID,
name, and email → generated login, emailed), unified login with
role-based redirect, admin
OTP verification by email, voting (gated on an admin-controlled
open/closed switch), and CSV roster import.

## 1. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine).
2. Open **SQL Editor → New query**, paste the contents of `sql/schema.sql`,
   and run it. This creates all tables and locks them down with Row Level
   Security so only your backend (using the service role key) can touch them.
   For an existing project, run the updated schema too; it adds a
   case-insensitive unique index so each student email can be used once.
   Resolve any duplicate student emails before rerunning if the index creation
   reports existing duplicates. The schema also adds the separate admin
  password-reset OTP table, the Admin/Staff account role, and the admin activity log. Admins can view
  credential delivery, account changes, sign-ins, voting status changes,
  and ballot-submission timestamps from the Activity tab. The log never
  stores passwords, OTP values, or vote choices. The latest schema also
  creates election-scoped tables used by VoteDesk; rerun it before creating
  elections from the Dashboard.
3. Go to **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role key** (not the `anon` key — the backend needs to
     bypass RLS) → `SUPABASE_SERVICE_ROLE_KEY`

## 2. Set up outgoing email

Resend is used when `EMAIL_PROVIDER=resend` or when no SMTP credentials are
configured and `RESEND_API_KEY` is present. Add these variables to Render (and
local `.env` when testing locally):

```
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_...
RESEND_FROM=CCDI Election Portal <no-reply@your-verified-domain.com>
```

Verify the sender domain in Resend. For a temporary test, you can use
`onboarding@resend.dev`, but Resend may restrict that sender to the email
address associated with your Resend account. Student credentials are sent after the submitted identity matches the
roster, and admin OTP codes are sent during admin login.

Mailjet SMTP is also available as an optional provider. Select it explicitly
with `EMAIL_PROVIDER=mailjet` and configure:

```
MAILJET_API_KEY=your-mailjet-api-key
MAILJET_SECRET_KEY=your-mailjet-secret-key
MAILJET_SMTP_HOST=in-v3.mailjet.com
MAILJET_SMTP_PORT=587
MAILJET_SMTP_SECURE=false
MAIL_FROM=CCDI Election Portal <verified-sender@your-domain.com>
```

The sender address/domain must be verified in Mailjet. Mailjet uses its API
key as the SMTP username and its secret key as the SMTP password.

SMTP is also supported as a fallback. The simplest SMTP option for a school
project is Gmail with an **App Password**:

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

When both SMTP credentials and a Resend API key are configured, SMTP is used
unless `EMAIL_PROVIDER` explicitly selects another provider.

If email delivery is not configured, registration, admin login, and admin
password recovery return an error instead of exposing credentials or
verification codes in the API.
Admin password recovery also sends a one-time email code; it expires after
10 minutes and allows up to five code attempts. Apply the latest
`sql/schema.sql` in Supabase to create its separate reset-code table.

## 3. Configure environment variables

```
cp .env.example .env
```
Fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET` (any
long random string), the email-provider variables from section 2, and `FRONTEND_ORIGIN` (the
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

## 6. Create and manage elections in VoteDesk

After applying the latest `sql/schema.sql`, sign in as an admin and open
**Dashboard → Create new election**. Upload a CSV with `name,block,email`
columns (a header row is optional). Each real voter needs a valid, unique
email address because generated credentials are delivered by email. The
sample-list option creates a clearly marked sample election and does not send
email. Candidate names must uniquely match a voter name in that election's
roster; add a slate after a comma or omit it for Independent.

Created elections and their voter, candidate, and ballot records are stored in
the separate `elections`, `election_voters`, `election_candidates`, and
`election_votes` tables. The Dashboard year selector loads those saved records;
the existing Students, Candidates, and Live Result views use the selected
election without changing the legacy roster or results. The Dashboard can open
or close voting, certify results, and archive certified elections.

For sample elections, voter data is demonstration-only. Passwords are never
returned by the API; only bcrypt hashes are stored, so a real participant
password cannot be shown again after credential delivery.

## 7. Create your first admin account

There's no seeded admin account — sign up through the running frontend
(the "Election officer? Create an admin account" link under the login card), or call the
API directly:
```
curl -X POST http://localhost:4000/api/auth/admin/signup \
  -H "Content-Type: application/json" \
  -d '{"name":"Election Officer","email":"you@gmail.com","username":"ssg.officer","password":"choose-a-strong-one"}'
```
(Must be a `@gmail.com` address — that's what the OTP gets sent to.)

Admin/Election Officer accounts keep full access. From **Admin → Admin &
Staff accounts**, an Admin can create a Staff account. Staff can view Live
Result, Students, Candidates, and Activity, and can manage Students and
Candidates where the election workflow allows it. Staff cannot manage
accounts, elections, QR codes, or voting status. Rerun `sql/schema.sql` on an
existing database to add the `role` column before using Staff accounts.

## 8. Deploy to Render

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
| POST | `/api/auth/student/register` | — | Verify ID and name against the roster; email credentials |
| POST | `/api/auth/student/resend` | — | Re-send a fresh password to a matching ID + email |
| POST | `/api/auth/login` | — | Unified login; admins get an OTP step, students get a session |
| POST | `/api/auth/admin/signup` | — | Create a new admin account |
| POST | `/api/auth/admin/verify-otp` | — | Finish admin login with the emailed code |
| GET | `/api/me` | student | Current student status + whether voting is open |
| GET | `/api/ballot` | student | Candidates grouped by position; representative candidates are limited to the student's course |
| POST | `/api/vote` | student | Cast a vote; candidate eligibility is validated against the student's block |
| GET/POST/DELETE | `/api/admin/students` | admin; staff (scoped) | Roster access |
| POST | `/api/admin/students/import` | admin; staff | CSV bulk import |
| GET/POST/DELETE | `/api/admin/candidates` | admin; staff (scoped) | Candidate access |
| GET | `/api/admin/results` | admin; staff | Vote tally per position |
| GET | `/api/admin/activity` | admin; staff | Activity log |
| GET/POST | `/api/admin/settings/voting-open` | admin | Read/flip the election on-off switch |
| GET/POST/DELETE | `/api/admin/admins` | admin | Manage Admin and Staff accounts |
| GET | `/api/admin/stats` | admin; staff | Dashboard summary numbers |
| GET/POST | `/api/admin/elections` | admin; staff (GET only) | List saved elections / create a voter- and candidate-scoped election |
| GET | `/api/admin/elections/:id` | admin; staff | Load election, participants, candidates, and block totals |
| POST | `/api/admin/elections/:id/voting-open` | admin | Open or close voting for one election |
| POST | `/api/admin/elections/:id/status` | admin | Certify or archive an election |
| POST | `/api/admin/elections/:id/voters/:voterId/resend-credentials` | admin | Issue and email a replacement password for an active election voter |

"student"/"admin" auth means a `Authorization: Bearer <token>` header
with the JWT returned at login.

## Security notes for going further

- Passwords are hashed with bcrypt and are never returned by the API.
- RLS is enabled with **no** public policies, so leaking the anon key
  can't expose data — only the service role key (server-side only) can
  read/write.
- The unique constraint on `votes (student_id_no, position)` is what
  actually stops a double vote, even under concurrent requests — not
  just the `voted` flag check.
- OTP codes expire after 5 minutes and are deleted once used.
- For real production use: add rate limiting on the login/OTP endpoints,
  and consider short-lived refresh tokens instead of a single 3–6 hour JWT.
