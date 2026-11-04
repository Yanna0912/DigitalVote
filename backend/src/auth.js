const jwt = require("jsonwebtoken");

function secret() {
  return process.env.JWT_SECRET || "dev-secret-change-me";
}

function signStudentToken(student, election = null) {
  const payload = { role: "student", id_no: student.id_no };
  if (election) {
    payload.election_id = election.id;
    payload.voter_id = student.id;
  }
  return jwt.sign(payload, secret(), { expiresIn: "3h" });
}
function signAdminToken(admin) {
  return jwt.sign({ role: admin.role || "admin", id: admin.id, username: admin.username }, secret(), { expiresIn: "6h" });
}

function staffCanAccess(req) {
  const path = req.originalUrl.split("?")[0].replace(/\/+$/, "") || "/";
  const staffGetRoutes = new Set([
    "/api/admin/me",
    "/api/admin/activity",
    "/api/admin/stats",
    "/api/admin/students",
    "/api/admin/candidates",
    "/api/admin/results",
    "/api/admin/elections",
  ]);
  if (req.method === "GET" && staffGetRoutes.has(path)) return true;
  if (req.method === "GET" && /^\/api\/admin\/elections\/[^/]+$/.test(path)) return true;
  if (req.method === "POST" && [
    "/api/admin/students",
    "/api/admin/students/import",
    "/api/admin/candidates",
  ].includes(path)) return true;
  if (req.method === "POST" && /^\/api\/admin\/students\/[^/]+\/resend-credentials$/.test(path)) return true;
  if (req.method === "POST" && /^\/api\/admin\/elections\/[^/]+\/voters\/[^/]+\/resend-credentials$/.test(path)) return true;
  return false;
}

function requireAuth(role) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing or invalid authorization header." });
    try {
      const payload = jwt.verify(token, secret());
      const allowed = payload.role === role || (
        role === "admin" &&
        payload.role === "staff" &&
        staffCanAccess(req)
      );
      if (!allowed) return res.status(403).json({ error: "You don't have access to this." });
      req.auth = payload;
      next();
    } catch (_err) {
      return res.status(401).json({ error: "Your session has expired. Please log in again." });
    }
  };
}

module.exports = {
  signStudentToken,
  signAdminToken,
  requireStudent: requireAuth("student"),
  requireAdmin: requireAuth("admin"),
};
