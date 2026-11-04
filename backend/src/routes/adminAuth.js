const express = require("express");
const bcrypt = require("bcryptjs");
const { supabase } = require("../db");
const { logActivity } = require("../audit");
const { genOtp, asyncHandler } = require("../utils");
const { signAdminToken } = require("../auth");
const { sendMail, adminPasswordResetEmail } = require("../mailer");

const router = express.Router();

/**
 * POST /api/auth/admin/verify-otp
 * body: { username, code }
 */
router.post("/verify-otp", asyncHandler(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const code = String(req.body.code || "").trim();
  if (!username || !code) return res.status(400).json({ error: "Enter the code we sent you." });

  const { data: admin, error } = await supabase.from("admins").select("*").ilike("username", username).maybeSingle();
  if (error || !admin) return res.status(401).json({ error: "Verification failed. Please log in again." });

  const { data: otpRow } = await supabase
    .from("admin_otp_codes")
    .select("*")
    .eq("admin_id", admin.id)
    .eq("code", code)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!otpRow) return res.status(401).json({ error: "Incorrect code." });
  if (new Date(otpRow.expires_at).getTime() < Date.now()) {
    return res.status(401).json({ error: "That code expired. Please log in again to get a new one." });
  }

  await supabase.from("admin_otp_codes").delete().eq("id", otpRow.id);

  const token = signAdminToken(admin);
  await logActivity(req, {
    actor: { role: "admin", id: admin.id, name: admin.name },
    action: "admin.login_succeeded",
    summary: `${admin.name} signed in after email verification.`,
    targetType: "admin",
    targetId: admin.id,
  });
  return res.json({ token, admin: { id: admin.id, name: admin.name, email: admin.email, username: admin.username, party_list: admin.party_list, role: admin.role || "admin" } });

  
}));

router.post("/forgot-password", asyncHandler(async (req, res) => {
  const email = String(req.body.email || "").trim();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid admin email address." });
  }

  const { data: admin, error: adminError } = await supabase
    .from("admins")
    .select("id, name, email")
    .ilike("email", email)
    .maybeSingle();
  if (adminError) return res.status(500).json({ error: "Couldn't check that admin email. Please try again." });
  if (!admin) {
    return res.json({ status: "sent", message: "If that email belongs to an admin account, a reset code has been sent." });
  }

  const { data: recentCode, error: recentCodeError } = await supabase
    .from("admin_password_reset_codes")
    .select("created_at")
    .eq("admin_id", admin.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recentCodeError) return res.status(500).json({ error: "Couldn't start password reset. Please try again." });
  if (recentCode && Date.now() - new Date(recentCode.created_at).getTime() < 60_000) {
    return res.status(429).json({ error: "Please wait a minute before requesting another reset code." });
  }

  const { error: clearError } = await supabase
    .from("admin_password_reset_codes")
    .delete()
    .eq("admin_id", admin.id);
  if (clearError) return res.status(500).json({ error: "Couldn't start password reset. Please try again." });

  const code = genOtp();
  const { data: resetRow, error: insertError } = await supabase
    .from("admin_password_reset_codes")
    .insert({ admin_id: admin.id, code, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() })
    .select("id")
    .single();
  if (insertError) return res.status(500).json({ error: "Couldn't start password reset. Please try again." });

  const mailResult = await sendMail({
    to: admin.email,
    ...adminPasswordResetEmail({ name: admin.name, code }),
  });
  if (!mailResult.delivered) {
    const { error: cleanupError } = await supabase.from("admin_password_reset_codes").delete().eq("id", resetRow.id);
    if (cleanupError) console.error("[auth] Failed to remove unsent admin password reset code:", cleanupError.message);
    console.error("[auth] Admin password reset email failed:", mailResult.error || "unknown");
    return res.status(502).json({ error: "We couldn't send the reset code. Please try again later." });
  }

  await logActivity(req, {
    actor: { role: "admin", id: admin.id, name: admin.name },
    action: "admin.password_reset_code_sent",
    summary: `Password reset code emailed to ${admin.name}.`,
    targetType: "admin",
    targetId: admin.id,
    details: { recipient: admin.email, delivery: "sent", credentialType: "password_reset_code" },
  });
  return res.json({ status: "sent", message: "If that email belongs to an admin account, a reset code has been sent." });
}));

router.post("/reset-password", asyncHandler(async (req, res) => {
  const email = String(req.body.email || "").trim();
  const code = String(req.body.code || "").trim();
  const password = String(req.body.password || "");
  if (!email || !/^\S+@\S+\.\S+$/.test(email) || !code || !password) {
    return res.status(400).json({ error: "Enter your email, reset code, and new password." });
  }
  if (password.length < 8) return res.status(400).json({ error: "Password should be at least 8 characters." });

  const { data: admin, error: adminError } = await supabase
    .from("admins")
    .select("id, name")
    .ilike("email", email)
    .maybeSingle();
  if (adminError) return res.status(500).json({ error: "Couldn't verify the reset request. Please try again." });
  if (!admin) return res.status(401).json({ error: "Invalid or expired reset code. Request a new code and try again." });

  const { data: resetRow, error: codeError } = await supabase
    .from("admin_password_reset_codes")
    .select("id, code, expires_at, attempts")
    .eq("admin_id", admin.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (codeError) return res.status(500).json({ error: "Couldn't verify the reset code. Please try again." });
  if (!resetRow || new Date(resetRow.expires_at).getTime() < Date.now() || resetRow.attempts >= 5) {
    return res.status(401).json({ error: "Invalid or expired reset code. Request a new code and try again." });
  }
  if (resetRow.code !== code) {
    const attempts = resetRow.attempts + 1;
    const { error: attemptError } = await supabase
      .from("admin_password_reset_codes")
      .update({ attempts })
      .eq("id", resetRow.id);
    if (attemptError) return res.status(500).json({ error: "Couldn't verify the reset code. Please try again." });
    if (attempts >= 5) {
      const { error: cleanupError } = await supabase.from("admin_password_reset_codes").delete().eq("id", resetRow.id);
      if (cleanupError) console.error("[auth] Failed to remove admin reset code after failed attempts:", cleanupError.message);
    }
    return res.status(401).json({ error: "Invalid or expired reset code. Request a new code and try again." });
  }

  const { data: consumedCode, error: consumeError } = await supabase
    .from("admin_password_reset_codes")
    .delete()
    .eq("id", resetRow.id)
    .select("id")
    .maybeSingle();
  if (consumeError) return res.status(500).json({ error: "Couldn't use the reset code. Please try again." });
  if (!consumedCode) return res.status(401).json({ error: "Invalid or expired reset code. Request a new code and try again." });

  const password_hash = await bcrypt.hash(password, 10);
  const { error: updateError } = await supabase.from("admins").update({ password_hash }).eq("id", admin.id);
  if (updateError) return res.status(500).json({ error: "Couldn't update the password. Request a new reset code and try again." });

  await logActivity(req, {
    actor: { role: "admin", id: admin.id, name: admin.name },
    action: "admin.password_reset",
    summary: "An admin password was reset.",
    targetType: "admin",
    targetId: admin.id,
  });
  return res.json({ status: "reset", message: "Your password was changed. You can now log in." });
}));

module.exports = router;
