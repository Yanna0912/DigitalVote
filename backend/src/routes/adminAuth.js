const express = require("express");
const bcrypt = require("bcryptjs");
const { supabase } = require("../db");
const { isGmail, asyncHandler } = require("../utils");
const { signAdminToken } = require("../auth");

const router = express.Router();

/**
 * POST /api/auth/admin/signup
 * body: { name, email, username, password }
 * Self sign-up for new election officers. Also reachable from an
 * existing admin's dashboard (same underlying table).
 */
router.post("/signup", asyncHandler(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim();
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!name || !email || !username || !password) {
    return res.status(400).json({ error: "Please fill in every field." });
  }
  if (!isGmail(email)) {
    return res.status(400).json({ error: "Please use a Gmail address so verification codes can reach you." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password should be at least 8 characters." });
  }

  const { data: existing } = await supabase.from("admins").select("id").ilike("username", username).maybeSingle();
  if (existing) return res.status(409).json({ error: "That username is already taken." });

  const password_hash = await bcrypt.hash(password, 10);
  const { error } = await supabase.from("admins").insert({ name, email, username, password_hash });
  if (error) return res.status(500).json({ error: "Couldn't create the admin account. Please try again." });

  return res.json({ status: "created", message: "Admin account created. You can now log in." });
}));

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
  return res.json({ token, admin: { id: admin.id, name: admin.name, email: admin.email, username: admin.username } });
}));

module.exports = router;
