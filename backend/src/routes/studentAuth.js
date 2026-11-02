const express = require("express");
const bcrypt = require("bcryptjs");
const { supabase } = require("../db");
const { genUsername, studentDisplayName, genPassword, asyncHandler } = require("../utils");
const { sendMail, studentCredentialsEmail } = require("../mailer");

const router = express.Router();

function normalized(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/**
 * POST /api/auth/student/register
 * body: { id_no, first_name, last_name, suffix, email }
 */
router.post("/register", asyncHandler(async (req, res) => {
  const first_name = String(req.body.first_name || "").trim();
  const last_name = String(req.body.last_name || "").trim();
  const suffix = String(req.body.suffix || "").trim();
  const id_no = String(req.body.id_no || "").trim();
  const email = String(req.body.email || "").trim();

  if (!first_name || !last_name || !id_no || !email) {
    return res.status(400).json({ error: "Enter your Student ID, name, and email." });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "That doesn't look like a valid email address." });
  }

  const { data: student, error: lookupError } = await supabase
    .from("students")
    .select("id_no, first_name, last_name, suffix, block, email, registered")
    .eq("id_no", id_no)
    .maybeSingle();
  if (lookupError) return res.status(500).json({ error: "Database error checking your Student ID." });
  if (!student) return res.status(404).json({ error: "That Student ID isn't in the school roster. Contact the election officer." });
  if (
    normalized(student.first_name) !== normalized(first_name) ||
    normalized(student.last_name) !== normalized(last_name) ||
    (suffix && normalized(student.suffix) !== normalized(suffix))
  ) {
    return res.status(403).json({ error: "The name doesn't match the school roster. Check your details or contact the election officer." });
  }
  if (student.registered) {
    return res.status(409).json({ error: "This Student ID already has voting credentials. Please log in or contact the election officer." });
  }

  const displayName = studentDisplayName(student);
  const username = genUsername(displayName, student.id_no);
  const plainPassword = genPassword();
  const password_hash = await bcrypt.hash(plainPassword, 10);
  const registeredAt = new Date().toISOString();
  const { data: registeredStudent, error: updateError } = await supabase
    .from("students")
    .update({ email, username, password_hash, registered: true, registered_at: registeredAt })
    .eq("id_no", id_no)
    .eq("registered", false)
    .select("id_no")
    .maybeSingle();
  if (updateError) return res.status(500).json({ error: "Couldn't create your voting credentials." });
  if (!registeredStudent) return res.status(409).json({ error: "This Student ID already has voting credentials." });

  const mailResult = await sendMail({
    to: email,
    ...studentCredentialsEmail({ name: displayName, username, password: plainPassword }),
  });
  if (!mailResult.delivered) {
    const { error: rollbackError } = await supabase.from("students").update({
      email: student.email,
      username: null,
      password_hash: null,
      registered: false,
      registered_at: null,
    }).eq("id_no", id_no).eq("username", username);
    if (rollbackError) console.error(`[registration] Failed to roll back credentials for ${id_no}:`, rollbackError.message);
    return res.status(502).json({ error: "Credentials could not be emailed. Please try again later or contact the election officer." });
  }

  return res.json({
    status: "registered",
    emailed: true,
    message: `Your voting credentials were sent to ${email}.`,
  });
}));

/**
 * POST /api/auth/student/resend
 * body: { id_no, email }
 */
router.post("/resend", asyncHandler(async (req, res) => {
  const id_no = String(req.body.id_no || "").trim();
  const email = String(req.body.email || "").trim();
  if (!id_no || !email) return res.status(400).json({ error: "Please enter both your Student ID and email." });

  const { data: student, error } = await supabase.from("students").select("*").eq("id_no", id_no).maybeSingle();
  if (error) return res.status(500).json({ error: "Database error looking up your Student ID." });
  if (!student || !student.registered || !student.email || normalized(student.email) !== normalized(email)) {
    return res.status(404).json({ error: "We couldn't match that Student ID and email. Check with the election officer." });
  }

  const plainPassword = genPassword();
  const password_hash = await bcrypt.hash(plainPassword, 10);
  const previousPasswordHash = student.password_hash;
  const { error: updateError } = await supabase.from("students").update({ password_hash }).eq("id_no", id_no);
  if (updateError) return res.status(500).json({ error: "Couldn't reset your password. Please try again." });

  const mailResult = await sendMail({
    to: email,
    ...studentCredentialsEmail({ name: studentDisplayName(student), username: student.username, password: plainPassword }),
  });
  if (!mailResult.delivered) {
    const { error: rollbackError } = await supabase.from("students").update({ password_hash: previousPasswordHash }).eq("id_no", id_no);
    if (rollbackError) console.error(`[credentials] Failed to restore password hash for ${id_no}:`, rollbackError.message);
    return res.status(502).json({ error: "Credentials could not be emailed. Your existing password was kept unchanged." });
  }

  return res.json({ status: "resent", emailed: true, message: `A new password was emailed to ${email}.` });
}));

module.exports = router;
