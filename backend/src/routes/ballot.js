const express = require("express");
const { supabase } = require("../db");
const { requireStudent } = require("../auth");
const { logActivity } = require("../audit");
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
  if (req.auth.election_id && req.auth.voter_id) {
    const [{ data: voter, error: voterError }, { data: election, error: electionError }] = await Promise.all([
      supabase.from("election_voters")
        .select("id, voter_id, name, block, voted, voted_at")
        .eq("election_id", req.auth.election_id)
        .eq("id", req.auth.voter_id)
        .maybeSingle(),
      supabase.from("elections")
        .select("id, voting_open")
        .eq("id", req.auth.election_id)
        .maybeSingle(),
    ]);
    if (voterError || electionError) return res.status(500).json({ error: "Couldn't load your election status." });
    if (!voter || !election) return res.status(404).json({ error: "Election voter record not found." });
    return res.json({
      student: {
        id_no: voter.voter_id,
        name: voter.name,
        block: voter.block,
        voted: voter.voted,
        voted_at: voter.voted_at,
      },
      votingOpen: election.voting_open,
    });
  }

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
  if (req.auth.election_id && req.auth.voter_id) {
    const [{ data: election, error: electionError }, { data: voter, error: voterError }] = await Promise.all([
      supabase.from("elections").select("id, voting_open, status").eq("id", req.auth.election_id).maybeSingle(),
      supabase.from("election_voters").select("id, block").eq("election_id", req.auth.election_id).eq("id", req.auth.voter_id).maybeSingle(),
    ]);
    if (electionError || voterError) return res.status(500).json({ error: "Couldn't load the election ballot." });
    if (!election || !voter) return res.status(404).json({ error: "Election voter record not found." });
    if (!election.voting_open || election.status !== "Open") {
      return res.status(403).json({ error: "Voting isn't open yet." });
    }

    const { data: candidates, error } = await supabase.from("election_candidates")
      .select("id, position, name, block, slate, ballot_number")
      .eq("election_id", election.id)
      .order("position", { ascending: true })
      .order("ballot_number", { ascending: true });
    if (error) return res.status(500).json({ error: "Couldn't load the ballot." });

    const byPosition = {};
    for (const candidate of (candidates || []).filter((item) => candidateIsEligibleForStudent(item, voter.block))) {
      const position = candidateRacePosition(candidate);
      if (!position) continue;
      if (!byPosition[position]) byPosition[position] = [];
      byPosition[position].push({
        name: candidate.name,
        id_no: null,
        block: candidate.block,
        party: candidate.slate,
        photo: null,
        ballot_number: candidate.ballot_number,
      });
    }
    return res.json({ ballot: Object.entries(byPosition).map(([position, list]) => ({ position, candidates: list })) });
  }

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
  if (req.auth.election_id && req.auth.voter_id) {
    const [{ data: election, error: electionError }, { data: voter, error: voterError }] = await Promise.all([
      supabase.from("elections")
        .select("id, name, year, status, voting_open")
        .eq("id", req.auth.election_id)
        .maybeSingle(),
      supabase.from("election_voters")
        .select("id, voter_id, name, block, voted")
        .eq("election_id", req.auth.election_id)
        .eq("id", req.auth.voter_id)
        .maybeSingle(),
    ]);
    if (electionError || voterError) return res.status(500).json({ error: "Couldn't load your election ballot." });
    if (!election || !voter) return res.status(404).json({ error: "Election voter record not found." });
    if (!election.voting_open || election.status !== "Open") return res.status(403).json({ error: "Voting isn't open yet." });
    if (voter.voted) return res.status(409).json({ error: "You've already voted." });

    const choices = req.body.votes;
    if (!choices || typeof choices !== "object" || Array.isArray(choices) || !Object.keys(choices).length) {
      return res.status(400).json({ error: "Choose at least one candidate to vote for." });
    }
    const { data: candidates, error: candidateError } = await supabase.from("election_candidates")
      .select("id, position, name, block")
      .eq("election_id", election.id);
    if (candidateError) return res.status(500).json({ error: "Couldn't validate the election ballot." });

    const eligibleByPosition = new Map();
    for (const candidate of (candidates || []).filter((item) => candidateIsEligibleForStudent(item, voter.block))) {
      const position = candidateRacePosition(candidate);
      if (!position) continue;
      if (!eligibleByPosition.has(position)) eligibleByPosition.set(position, []);
      eligibleByPosition.get(position).push(candidate);
    }
    const voteRows = [];
    for (const [position, chosenName] of Object.entries(choices)) {
      const candidate = (eligibleByPosition.get(position) || []).find((item) => item.name === chosenName);
      if (!candidate) return res.status(400).json({ error: `"${chosenName}" isn't a valid candidate for ${position}.` });
      voteRows.push({
        election_id: election.id,
        voter_id: voter.id,
        candidate_id: candidate.id,
        position,
      });
    }

    const votedAt = new Date().toISOString();
    const { data: updatedVoter, error: updateError } = await supabase.from("election_voters")
      .update({ voted: true, voted_at: votedAt })
      .eq("election_id", election.id)
      .eq("id", voter.id)
      .eq("voted", false)
      .select("id")
      .maybeSingle();
    if (updateError) return res.status(500).json({ error: "Couldn't record your ballot status." });
    if (!updatedVoter) return res.status(409).json({ error: "You've already voted." });

    const { error: insertError } = await supabase.from("election_votes").insert(voteRows);
    if (insertError) {
      const { error: rollbackError } = await supabase.from("election_voters")
        .update({ voted: false, voted_at: null })
        .eq("election_id", election.id)
        .eq("id", voter.id)
        .eq("voted_at", votedAt);
      if (rollbackError) console.error(`[vote] Failed to roll back ballot status for ${voter.voter_id}:`, rollbackError.message);
      if (insertError.code === "23505") {
        return res.status(409).json({ error: "It looks like your vote was already recorded." });
      }
      return res.status(500).json({ error: "Couldn't save your ballot. Please try again." });
    }

    await logActivity(req, {
      actor: { role: "student", id_no: voter.voter_id, name: voter.name },
      action: "student.vote_cast",
      summary: `${voter.name} submitted a ballot for the ${election.year} election.`,
      targetType: "election_voter",
      targetId: voter.id,
      details: { electionId: election.id, year: election.year, positionsCount: voteRows.length },
    });
    return res.json({ status: "voted", votedAt });
  }

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
  await logActivity(req, {
    actor: { role: "student", id_no: student.id_no },
    action: "student.vote_cast",
    summary: `${studentDisplayName(student)} submitted a ballot.`,
    targetType: "student",
    targetId: student.id_no,
    details: { positionsCount: rows.length },
  });

  return res.json({ status: "voted", votedAt });
}));

module.exports = router;
