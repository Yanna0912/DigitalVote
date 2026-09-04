const express = require("express");
const bcrypt = require("bcryptjs");
const { supabase } = require("../db");
const { genOtp, maskEmail, asyncHandler } = require("../utils");
const { sendMail, adminOtpEmail } = require("../mailer");
const { signStudentToken } = require("../auth");

const router = express.Router();

/**
 * POST /api/auth/login
 * body: { username, password }
 *
 * One login form for everyone. Admin accounts are checked first: a
 * correct admin password triggers an emailed OTP instead of a session.
 * Otherwise falls back to the student roster.
 */
router.post("/login", asyncHandler(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!username || !password) return res.status(400).json({ error: "Enter both your username and password." });

  const { data: admin, error: adminError } = await supabase
    .from("admins").select("*").ilike("username", username).maybeSingle();
  if (adminError) return res.status(500).json({ error: "Database error during login." });

  if (admin && (await bcrypt.compare(password, admin.password_hash))) {
    const code = genOtp();
    const expires_at = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { error: otpError } = await supabase.from("admin_otp_codes").insert({ admin_id: admin.id, code, expires_at });
    if (otpError) return res.status(500).json({ error: "Couldn't start verification. Please try again." });

    const mail = adminOtpEmail({ name: admin.name, code });
    const mailResult = await sendMail({ to: admin.email, ...mail });

    return res.json({
      role: "admin",
      status: "otp_sent",
      username: admin.username,
      maskedEmail: maskEmail(admin.email),
      emailed: mailResult.delivered,
      devCode: mailResult.delivered ? undefined : code,
    });
  }

  const { data: student, error: studentError } = await supabase
    .from("students").select("*").ilike("username", username).maybeSingle();
  if (studentError) return res.status(500).json({ error: "Database error during login." });

  if (student && student.password_hash && (await bcrypt.compare(password, student.password_hash))) {
    const { data: setting } = await supabase.from("settings").select("value").eq("key", "voting_open").maybeSingle();
    const votingOpen = setting?.value === "true";
    const token = signStudentToken(student);
    return res.json({
      role: "student",
      token,
      student: { id_no: student.id_no, name: student.name, block: student.block, voted: student.voted, voted_at: student.voted_at },
      votingOpen,
    });
  }

  return res.status(401).json({ error: "Incorrect username or password." });
}));

module.exports = router;
