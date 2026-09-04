const jwt = require("jsonwebtoken");

function secret() {
  return process.env.JWT_SECRET || "dev-secret-change-me";
}

function signStudentToken(student) {
  return jwt.sign({ role: "student", id_no: student.id_no }, secret(), { expiresIn: "3h" });
}
function signAdminToken(admin) {
  return jwt.sign({ role: "admin", id: admin.id, username: admin.username }, secret(), { expiresIn: "6h" });
}

function requireAuth(role) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing or invalid authorization header." });
    try {
      const payload = jwt.verify(token, secret());
      if (payload.role !== role) return res.status(403).json({ error: "You don't have access to this." });
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
