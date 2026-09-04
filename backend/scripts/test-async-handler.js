const express = require("express");
const http = require("http");
const { asyncHandler } = require("../src/utils");

const app = express();

// simulates a route whose Supabase call fails (network/DNS error)
app.get("/boom", asyncHandler(async (_req, _res) => {
  throw new Error("simulated DB failure");
}));

// same centralized fallback used in src/index.js
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: "Something went wrong on the server." });
});

const server = app.listen(0, async () => {
  const port = server.address().port;
  const req = http.get(`http://localhost:${port}/boom`, (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      console.log("status:", res.statusCode);
      console.log("body:", body);
      const ok = res.statusCode === 500 && JSON.parse(body).error;
      console.log(ok ? "PASS: rejected promise became a JSON 500, process did not crash" : "FAIL");
      server.close(() => process.exit(ok ? 0 : 1));
    });
  });
  req.on("error", (e) => {
    console.log("FAIL: request error", e.message);
    server.close(() => process.exit(1));
  });
});
