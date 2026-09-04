const express = require("express");
const { supabase } = require("../db");
const { requireStudent } = require("../auth");
const { asyncHandler } = require("../utils");

const router = express.Router();

async function isVotingOpen() {
  const { data } = await supabase.from("settings").select("value").eq("key", "voting_open").maybeSingle();
  return data?.value === "true";
}

/**
 * GET /api/me
 * Used right after login, and by the "waiting for voting to open" screen
 * to poll status without asking the student to log in again.
 */
router.get("/me", requireStudent, asyncHandler(async (req, res) => {
  const { data: student, error } = await supabase
    .from("students")
    .select("id_no, name, block, voted, voted_at")
    .eq("id_no", req.auth.id_no)
    .maybeSingle();
  if (error || !student) return res.status(404).json({ error: "Student record not found." });

  return res.json({ student, votingOpen: await isVotingOpen() });
}));

/**
 * GET /api/ballot
 * Returns candidates grouped by position. Requires voting to be open.
 */
router.get("/ballot", requireStudent, asyncHandler(async (req, res) => {
  if (!(await isVotingOpen())) {
    return res.status(403).json({ error: "Voting isn't open yet." });
  }
  const { data: candidates, error } = await supabase
    .from("candidates")
    .select("position, name, slogan")
    .order("position", { ascending: true });
  if (error) return res.status(500).json({ error: "Couldn't load the ballot." });

  const byPosition = {};
  for (const c of candidates) {
    if (!byPosition[c.position]) byPosition[c.position] = [];
    byPosition[c.position].push({ name: c.name, slogan: c.slogan });
  }
  const ballot = Object.entries(byPosition).map(([position, list]) => ({ position, candidates: list }));
  return res.json({ ballot });
}));

/**
 * POST /api/vote
 * body: { votes: { [position]: candidateName, ... } }
 */
router.post("/vote", requireStudent, asyncHandler(async (req, res) => {
  if (!(await isVotingOpen())) {
    return res.status(403).json({ error: "Voting isn't open yet." });
  }

  const { data: student, error: studentError } = await supabase
    .from("students")
    .select("id_no, name, voted")
    .eq("id_no", req.auth.id_no)
    .maybeSingle();
  if (studentError || !student) return res.status(404).json({ error: "Student record not found." });
  if (student.voted) return res.status(409).json({ error: "You've already voted." });

  const votes = req.body.votes || {};
  const { data: candidates, error: candError } = await supabase.from("candidates").select("position, name");
  if (candError) return res.status(500).json({ error: "Couldn't load the ballot to validate your vote." });

  const positions = [...new Set(candidates.map((c) => c.position))];
  if (!positions.length) return res.status(400).json({ error: "No positions are set up yet." });

  for (const position of positions) {
    const chosen = votes[position];
    if (!chosen) return res.status(400).json({ error: `Please select a candidate for ${position}.` });
    const valid = candidates.some((c) => c.position === position && c.name === chosen);
    if (!valid) return res.status(400).json({ error: `"${chosen}" isn't a valid candidate for ${position}.` });
  }

  const rows = positions.map((position) => ({ student_id_no: student.id_no, position, candidate_name: votes[position] }));
  const { error: insertError } = await supabase.from("votes").insert(rows);
  if (insertError) {
    // Unique constraint (student_id_no, position) blocks a double-submit race.
    return res.status(409).json({ error: "It looks like your vote was already recorded." });
  }

  const votedAt = new Date().toISOString();
  await supabase.from("students").update({ voted: true, voted_at: votedAt }).eq("id_no", student.id_no);

  return res.json({ status: "voted", votedAt });
}));

module.exports = router;
