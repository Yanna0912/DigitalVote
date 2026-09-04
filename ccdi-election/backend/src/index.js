require("dotenv").config();
const express = require("express");
const cors = require("cors");

const studentAuthRoutes = require("./routes/studentAuth");
const adminAuthRoutes = require("./routes/adminAuth");
const unifiedAuthRoutes = require("./routes/authUnified");
const ballotRoutes = require("./routes/ballot");
const adminRoutes = require("./routes/admin");

const app = express();
app.use(express.json());

const origin = process.env.FRONTEND_ORIGIN || "*";
app.use(cors({ origin, credentials: false }));

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "ccdi-election-backend" });
});
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth/student", studentAuthRoutes);
app.use("/api/auth/admin", adminAuthRoutes);
app.use("/api/auth", unifiedAuthRoutes); // /api/auth/login
app.use("/api", ballotRoutes); // /api/me, /api/ballot, /api/vote
app.use("/api/admin", adminRoutes);

// centralized error fallback for anything that throws instead of
// returning its own response
app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`CCDI election backend listening on port ${port}`);
});
