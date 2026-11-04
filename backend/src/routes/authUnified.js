const express = require("express");
const bcrypt = require("bcryptjs");
const { supabase } = require("../db");
const { logActivity } = require("../audit");
const { genOtp, studentDisplayName, maskEmail, asyncHandler } = require("../utils");
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
    const { data: otpRow, error: otpError } = await supabase
      .from("admin_otp_codes")
      .insert({ admin_id: admin.id, code, expires_at })
      .select("id")
      .single();
    if (otpError) return res.status(500).json({ error: "Couldn't start verification. Please try again." });

    const mail = adminOtpEmail({ name: admin.name, code });
    const mailResult = await sendMail({ to: admin.email, ...mail });
    if (!mailResult.delivered) {
      await supabase.from("admin_otp_codes").delete().eq("id", otpRow.id);
      console.error(`[auth] Admin OTP email failed for ${admin.email}: ${mailResult.error || "unknown"}`);
      
      // Generic error response without referencing Mailjet
      return res.status(502).json({
        error: "We couldn't send the verification code. Please click resend or contact support.",
      });
    }

    await logActivity(req, {
      actor: { role: "admin", id: admin.id, name: admin.name },
      action: "admin.login_otp_sent",
      summary: `Login verification code emailed to ${admin.name}.`,
      targetType: "admin",
      targetId: admin.id,
      details: { recipient: admin.email, delivery: "sent", credentialType: "login_otp" },
    });

    return res.json({
      role: "admin",
      status: "otp_sent",
      username: admin.username,
      maskedEmail: maskEmail(admin.email),
      emailed: true,
    });
  }

  const { data: student, error: studentError } = await supabase
    .from("students").select("*").ilike("username", username).maybeSingle();
  if (studentError) return res.status(500).json({ error: "Database error during login." });

  if (student && student.registered && student.password_hash && (await bcrypt.compare(password, student.password_hash))) {
    const { data: setting } = await supabase.from("settings").select("value").eq("key", "voting_open").maybeSingle();
    const votingOpen = setting?.value === "true";
    const token = signStudentToken(student);
    await logActivity(req, {
      actor: { role: "student", id_no: student.id_no, name: studentDisplayName(student) },
      action: "student.login_succeeded",
      summary: `${studentDisplayName(student)} signed in.`,
      targetType: "student",
      targetId: student.id_no,
    });
    return res.json({
      role: "student",
      token,
      student: { id_no: student.id_no, name: studentDisplayName(student), block: student.block, voted: student.voted, voted_at: student.voted_at },
      votingOpen,
    });
  }

  const { data: electionVoter, error: electionVoterError } = await supabase
    .from("election_voters")
    .select("id, election_id, voter_id, name, block, username, password_hash, voted, voted_at")
    .ilike("username", username)
    .maybeSingle();
  if (electionVoterError) return res.status(500).json({ error: "Database error during login." });
  if (electionVoter && electionVoter.password_hash && (await bcrypt.compare(password, electionVoter.password_hash))) {
    const { data: election, error: electionError } = await supabase
      .from("elections")
      .select("id, name, year, status, voting_open")
      .eq("id", electionVoter.election_id)
      .maybeSingle();
    if (electionError) return res.status(500).json({ error: "Database error during login." });
    if (!election || election.status === "Archived" || election.status === "Certified") {
      return res.status(403).json({ error: "This election is no longer accepting voter sign-ins." });
    }

    const token = signStudentToken({ id_no: electionVoter.voter_id, id: electionVoter.id }, election);
    await logActivity(req, {
      actor: { role: "student", id_no: electionVoter.voter_id, name: electionVoter.name },
      action: "student.login_succeeded",
      summary: `${electionVoter.name} signed in for the ${election.year} election.`,
      targetType: "election_voter",
      targetId: electionVoter.id,
      details: { electionId: election.id, year: election.year },
    });
    return res.json({
      role: "student",
      token,
      student: {
        id_no: electionVoter.voter_id,
        name: electionVoter.name,
        block: electionVoter.block,
        voted: electionVoter.voted,
        voted_at: electionVoter.voted_at,
      },
      votingOpen: election.voting_open,
      election: { id: election.id, name: election.name, year: election.year },
    });
  }

  return res.status(401).json({ error: "Incorrect username or password." });
}));

module.exports = router;