const express = require("express");
const { supabase } = require("../db");
const { requireStudent } = require("../auth");
const { studentDisplayName, asyncHandler } = require("../utils");
const { candidateIsEligibleForStudent, candidateRacePosition } = require("../election");

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
    .select("id_no, first_name, last_name, suffix, block, voted, voted_at")
    .eq("id_no", req.auth.id_no)
    .maybeSingle();
  if (error || !student) return res.status(404).json({ error: "Student record not found." });

  return res.json({ student: { ...student, name: studentDisplayName(student) }, votingOpen: await isVotingOpen() });
}));

/**
 * GET /api/ballot
 * Returns candidates grouped by position. Requires voting to be open.
 */
router.get("/ballot", requireStudent, asyncHandler(async (req, res) => {
  if (!(await isVotingOpen())) {
    return res.status(403).json({ error: "Voting isn't open yet." });
  }
  const { data: student, error: studentError } = await supabase
    .from("students")
    .select("block")
    .eq("id_no", req.auth.id_no)
    .maybeSingle();
  if (studentError || !student) return res.status(404).json({ error: "Student record not found." });

  const { data: candidates, error } = await supabase
    .from("candidates")
    .select("*")
    .order("position", { ascending: true });
  if (error) return res.status(500).json({ error: "Couldn't load the ballot." });

  const byPosition = {};
  for (const c of candidates.filter((candidate) => candidateIsEligibleForStudent(candidate, student.block))) {
    const position = candidateRacePosition(c);
    if (!position) continue;
    if (!byPosition[position]) byPosition[position] = [];
    byPosition[position].push({
      name: c.name,
      id_no: c.id_no || null,
      block: c.block || null,
      party: c.party || c.slogan || null,
      photo: c.photo || null,
    });
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
    .select("id_no, block, voted")
    .eq("id_no", req.auth.id_no)
    .maybeSingle();
  if (studentError || !student) return res.status(404).json({ error: "Student record not found." });
  if (student.voted) return res.status(409).json({ error: "You've already voted." });

  const votes = req.body.votes;
  if (!votes || typeof votes !== "object" || Array.isArray(votes)) {
    return res.status(400).json({ error: "Choose at least one candidate to vote for." });
  }
  const { data: candidates, error: candError } = await supabase.from("candidates").select("position, name, block");
  if (candError) return res.status(500).json({ error: "Couldn't load the ballot to validate your vote." });

  const eligibleByPosition = new Map();
  for (const candidate of candidates.filter((item) => candidateIsEligibleForStudent(item, student.block))) {
    const position = candidateRacePosition(candidate);
    if (!position) continue;
    if (!eligibleByPosition.has(position)) eligibleByPosition.set(position, []);
    eligibleByPosition.get(position).push(candidate);
  }

  const rows = [];
  for (const [position, chosen] of Object.entries(votes)) {
    const choices = eligibleByPosition.get(position);
    if (!choices || !choices.some((candidate) => candidate.name === chosen)) {
      return res.status(400).json({ error: `"${chosen}" isn't a valid candidate for ${position}.` });
    }
    rows.push({ student_id_no: student.id_no, position, candidate_name: chosen });
  }
  if (!rows.length) return res.status(400).json({ error: "Choose at least one candidate to vote for." });
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
