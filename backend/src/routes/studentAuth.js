const express = require("express");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const { supabase } = require("../db");
const { genUsername, studentDisplayName, genPassword, asyncHandler } = require("../utils");
const { sendMail, studentCredentialsEmail } = require("../mailer");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
});

/**
 * POST /api/auth/student/register
 * multipart/form-data with applicant details and an ID image.
 * Credentials are intentionally not created until an admin approves it.
 */
router.post("/register", upload.single("id_photo"), asyncHandler(async (req, res) => {
  const first_name = String(req.body.first_name || "").trim();
  const last_name = String(req.body.last_name || "").trim();
  const suffix = String(req.body.suffix || "").trim();
  const id_no = String(req.body.id_no || "").trim();
  const block = String(req.body.block || "").trim();
  const email = String(req.body.email || "").trim();

  if (!first_name || !last_name || !id_no || !block || !email || !req.file) {
    return res.status(400).json({ error: "Complete all required fields and attach an ID photo." });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "That doesn't look like a valid email address." });
  }
  if (!/^image\/(jpeg|png|webp)$/.test(req.file.mimetype)) {
    return res.status(400).json({ error: "ID verification must be a JPG, PNG, or WebP image." });
  }

  const { data: student, error: lookupError } = await supabase
    .from("students").select("id_no, email, registered, approval_status").eq("id_no", id_no).maybeSingle();
  if (lookupError) return res.status(500).json({ error: "Database error checking your Student ID." });
  if (!student) return res.status(404).json({ error: "That Student ID isn't in the school roster. Contact the election officer." });
  if (student.registered || (student.approval_status === "approved" && student.email)) {
    return res.status(409).json({ error: "This Student ID is already approved. Use your voting login instead." });
  }
  if (student.approval_status === "pending") {
    return res.status(409).json({ error: "Your registration is already waiting for admin approval." });
  }
  if (student.email && student.email.toLowerCase() !== email.toLowerCase()) {
    return res.status(409).json({ error: "This Student ID is already linked to a different email." });
  }

  const { error: updateError } = await supabase.from("students").update({
    first_name, last_name, suffix: suffix || null, block, email,
    id_photo: `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`,
    approval_status: "pending", approval_note: null, registered: false,
  }).eq("id_no", id_no);
  if (updateError) return res.status(500).json({ error: "Couldn't submit your registration." });

  res.json({ status: "pending", message: "Registration submitted. An election officer will review your ID and email your login after approval." });
}));

/**
 * POST /api/auth/student/lookup
 * body: { id_no, email }
 *
 * First time: if the ID exists and has no email on file yet, this email
 * is saved against it, a username/password are generated, and the
 * credentials are emailed. Every time after that, the email must match
 * what's already on file for this ID.
 */
router.post("/lookup", asyncHandler(async (req, res) => {
  return res.status(410).json({ error: "This registration flow now requires the full application form and admin approval." });
  const id_no = String(req.body.id_no || "").trim();
  const email = String(req.body.email || "").trim();

  if (!id_no || !email) {
    return res.status(400).json({ error: "Please enter both your Student ID and email." });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "That doesn't look like a valid email address." });
  }

  const { data: student, error } = await supabase
    .from("students")
    .select("*")
    .eq("id_no", id_no)
    .maybeSingle();

  if (error) return res.status(500).json({ error: "Database error looking up your Student ID." });
  if (!student) {
    return res.status(404).json({ error: "That Student ID isn't in our records. Check with the election officer." });
  }

  if (student.email) {
    if (student.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(409).json({
        error: "This ID is already registered with a different email. Contact the election officer if this is a mistake.",
      });
    }
    if (student.approval_status === "pending") {
      return res.status(409).json({ error: "Your registration is still waiting for admin approval." });
    }
    if (student.registered) {
      return res.json({
        status: "already_registered",
        message: "You're already registered. Use the Log in tab with your username and password (check your email if you don't have them).",
      });
    }
  }

  const displayName = studentDisplayName(student);
  const username = genUsername(displayName, student.id_no);
  const plainPassword = genPassword();
  const password_hash = await bcrypt.hash(plainPassword, 10);

  const { error: updateError } = await supabase
    .from("students")
    .update({ email, username, password_hash, registered: true, registered_at: new Date().toISOString() })
    .eq("id_no", id_no);

  if (updateError) {
    return res.status(500).json({ error: "Couldn't save your registration. Please try again." });
  }

  const mail = studentCredentialsEmail({ name: displayName, username, password: plainPassword });
  const mailResult = await sendMail({ to: email, ...mail });

  return res.json({
    status: "registered",
    emailed: mailResult.delivered,
    message: mailResult.delivered
      ? `We've emailed your voting username and password to ${email}.`
      : "Registered! (Email delivery isn't configured on this server yet — showing your credentials here instead, for testing.)",
    // Only included when SMTP isn't configured, so local/dev testing still works
    // without an inbox to check.
    devCredentials: mailResult.delivered ? undefined : { username, password: plainPassword },
  });
}));

/**
 * POST /api/auth/student/resend
 * body: { id_no, email }
 * Generates a fresh password for a student who already registered but
 * lost their email, and re-sends it.
 */
router.post("/resend", asyncHandler(async (req, res) => {
  const id_no = String(req.body.id_no || "").trim();
  const email = String(req.body.email || "").trim();
  if (!id_no || !email) return res.status(400).json({ error: "Please enter both your Student ID and email." });

  const { data: student, error } = await supabase.from("students").select("*").eq("id_no", id_no).maybeSingle();
  if (error) return res.status(500).json({ error: "Database error looking up your Student ID." });
  if (!student || !student.email || student.email.toLowerCase() !== email.toLowerCase()) {
    return res.status(404).json({ error: "We couldn't match that Student ID and email. Check with the election officer." });
  }

  const plainPassword = genPassword();
  const password_hash = await bcrypt.hash(plainPassword, 10);
  const { error: updateError } = await supabase.from("students").update({ password_hash }).eq("id_no", id_no);
  if (updateError) return res.status(500).json({ error: "Couldn't reset your password. Please try again." });

  const mail = studentCredentialsEmail({ name: studentDisplayName(student), username: student.username, password: plainPassword });
  const mailResult = await sendMail({ to: email, ...mail });

  return res.json({
    status: "resent",
    emailed: mailResult.delivered,
    message: mailResult.delivered
      ? `A new password was emailed to ${email}.`
      : "Password reset! (Email delivery isn't configured on this server yet — showing your new password here instead, for testing.)",
    devCredentials: mailResult.delivered ? undefined : { username: student.username, password: plainPassword },
  });
}));

module.exports = router;