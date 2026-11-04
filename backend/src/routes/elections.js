const express = require("express");
const bcrypt = require("bcryptjs");
const { randomUUID } = require("crypto");
const { supabase } = require("../db");
const { requireAdmin } = require("../auth");
const { logActivity } = require("../audit");
const { genPassword, asyncHandler } = require("../utils");
const { sendMail, studentCredentialsEmail } = require("../mailer");
const { candidateRacePosition } = require("../election");

const router = express.Router();
router.use(requireAdmin);

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function electionSummary(election, voters = [], votes = []) {
  return {
    id: election.id,
    title: election.name,
    year: election.year,
    status: election.status,
    date: election.election_date,
    votingOpen: election.voting_open,
    ballotsCast: voters.filter((voter) => voter.voted).length,
    registered: voters.length,
    sample: Boolean(election.is_sample),
  };
}

function isElectionSchemaError(error) {
  return ["42P01", "42703", "PGRST204", "PGRST205"].includes(error?.code);
}

router.get("/", asyncHandler(async (_req, res) => {
  const { data: elections, error } = await supabase
    .from("elections")
    .select("id, name, year, election_date, status, voting_open, is_sample, created_at")
    .order("year", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[elections] Failed to load election list:", error.code, error.message);
    if (isElectionSchemaError(error)) {
      return res.status(503).json({
        error: "Election database tables are missing or out of date. Apply backend/sql/schema.sql in Supabase, then try again.",
      });
    }
    return res.status(500).json({ error: "Couldn't load elections." });
  }
  const ids = (elections || []).map((election) => election.id);
  const [{ data: voters, error: voterError }, { data: votes, error: voteError }] = ids.length
    ? await Promise.all([
        supabase.from("election_voters").select("election_id, voted").in("election_id", ids),
        supabase.from("election_votes").select("election_id").in("election_id", ids),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  if (voterError || voteError) return res.status(500).json({ error: "Couldn't load election summaries." });
  res.json({
    elections: (elections || []).map((election) => {
      const electionVoters = (voters || []).filter((voter) => voter.election_id === election.id);
      return electionSummary(election, electionVoters, votes || []);
    }),
  });
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const { data: election, error: electionError } = await supabase
    .from("elections")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();
  if (electionError) return res.status(500).json({ error: "Couldn't load this election." });
  if (!election) return res.status(404).json({ error: "Election not found." });

  const [{ data: voters, error: voterError }, { data: candidates, error: candidateError }, { data: votes, error: voteError }] = await Promise.all([
    supabase.from("election_voters")
      .select("id, voter_id, name, normalized_name, block, email, username, credential_delivery, voted, voted_at, created_at")
      .eq("election_id", election.id)
      .order("name", { ascending: true }),
    supabase.from("election_candidates")
      .select("id, voter_id, position, name, block, slate, ballot_number")
      .eq("election_id", election.id)
      .order("position", { ascending: true })
      .order("ballot_number", { ascending: true }),
    supabase.from("election_votes")
      .select("voter_id, candidate_id, position")
      .eq("election_id", election.id),
  ]);
  if (voterError || candidateError || voteError) return res.status(500).json({ error: "Couldn't load election details." });

  const voterRows = voters || [];
  const candidateRows = candidates || [];
  const voteRows = votes || [];
  const voterIdsByRowId = new Map(voterRows.map((voter) => [voter.id, voter.voter_id]));
  const candidatesByPosition = new Map();
  for (const candidate of candidateRows) {
    const position = candidateRacePosition(candidate);
    if (!position) continue;
    if (!candidatesByPosition.has(position)) candidatesByPosition.set(position, []);
    candidatesByPosition.get(position).push(candidate);
  }
  const positions = [...candidatesByPosition.entries()].map(([name, raceCandidates]) => {
    const positionCandidates = raceCandidates.map((candidate) => {
      const candidateVotes = voteRows.filter((vote) => vote.candidate_id === candidate.id).length;
      const blockVotes = {};
      voterRows.forEach((voter) => {
        blockVotes[voter.block] ||= 0;
        if (voteRows.some((vote) => vote.voter_id === voter.id && vote.candidate_id === candidate.id)) blockVotes[voter.block]++;
      });
      return {
        id: candidate.id,
        voterId: voterIdsByRowId.get(candidate.voter_id) || null,
        name: candidate.name,
        block: candidate.block,
        slate: candidate.slate,
        party: candidate.slate,
        ballotNumber: candidate.ballot_number,
        initials: candidate.name.split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase(),
        votes: candidateVotes,
        blockVotes,
      };
    });
    return { name, candidates: positionCandidates };
  });

  const blocks = [...new Set(voterRows.map((voter) => voter.block))].sort((a, b) => a.localeCompare(b)).map((name) => {
    const blockVoters = voterRows.filter((voter) => voter.block === name);
    const castVoters = blockVoters.filter((voter) => voter.voted);
    const blockVotes = {};
    positions.forEach((position) => {
      blockVotes[position.name] = {};
      position.candidates.forEach((candidate) => {
        blockVotes[position.name][candidate.id] = voteRows.filter((vote) =>
          vote.candidate_id === candidate.id && blockVoters.some((voter) => voter.id === vote.voter_id)
        ).length;
      });
    });
    return {
      name,
      registered: blockVoters.length,
      cast: castVoters.length,
      blank: Math.max(0, castVoters.length - new Set(voteRows.filter((vote) => blockVoters.some((voter) => voter.id === vote.voter_id)).map((vote) => vote.voter_id)).size),
      votes: blockVotes,
    };
  });
  const votersForClient = voterRows.map((voter) => ({
    id: voter.voter_id,
    name: voter.name,
    block: voter.block,
    email: voter.email,
    username: voter.username,
    hasCredentials: voter.credential_delivery === "sent",
    credentialDelivery: voter.credential_delivery,
    voted: voter.voted,
    voted_at: voter.voted_at,
  }));
  const result = {
    ...electionSummary(election, voterRows, voteRows),
    ballotsCast: voterRows.filter((voter) => voter.voted).length,
    blankBallots: blocks.reduce((sum, block) => sum + block.blank, 0),
    voters: votersForClient,
    blocks,
    positions,
  };
  res.json({ election: result });
}));

router.post("/:id/voters/:voterId/resend-credentials", asyncHandler(async (req, res) => {
  const [{ data: election, error: electionError }, { data: voter, error: voterError }] = await Promise.all([
    supabase.from("elections")
      .select("id, name, status, is_sample")
      .eq("id", req.params.id)
      .maybeSingle(),
    supabase.from("election_voters")
      .select("id, voter_id, name, email, username, password_hash, credential_delivery")
      .eq("election_id", req.params.id)
      .eq("voter_id", req.params.voterId)
      .maybeSingle(),
  ]);
  if (electionError || voterError) return res.status(500).json({ error: "Couldn't load the voter credentials." });
  if (!election || !voter) return res.status(404).json({ error: "Election voter not found." });
  if (election.status === "Certified" || election.status === "Archived") {
    return res.status(409).json({ error: "Credentials cannot be resent for a finalized election." });
  }
  if (election.is_sample) return res.status(409).json({ error: "Sample election credentials are not delivered." });

  const password = genPassword(12);
  const passwordHash = await bcrypt.hash(password, 10);
  const { data: preparedVoter, error: passwordError } = await supabase.from("election_voters")
    .update({ password_hash: passwordHash, credential_delivery: "pending" })
    .eq("election_id", election.id)
    .eq("id", voter.id)
    .eq("password_hash", voter.password_hash)
    .select("id")
    .maybeSingle();
  if (passwordError) return res.status(500).json({ error: "Couldn't prepare new voter credentials." });
  if (!preparedVoter) return res.status(409).json({ error: "These credentials were just updated. Refresh the voter list and try again." });

  const mailResult = await sendMail({
    to: voter.email,
    ...studentCredentialsEmail({ name: voter.name, username: voter.username, password }),
  });
  if (!mailResult.delivered) {
    const { data: restoredVoter, error: rollbackError } = await supabase.from("election_voters")
      .update({ password_hash: voter.password_hash, credential_delivery: voter.credential_delivery })
      .eq("election_id", election.id)
      .eq("id", voter.id)
      .eq("password_hash", passwordHash)
      .select("id")
      .maybeSingle();
    const rollbackFailed = Boolean(rollbackError || !restoredVoter);
    if (rollbackFailed) {
      console.error(`[elections] Failed to restore credentials for ${voter.voter_id}:`, rollbackError?.message || "credentials changed concurrently");
    }
    await logActivity(req, {
      action: "election.voter_credentials_email_failed",
      summary: `Credential resend failed for ${voter.name} in ${election.name}.`,
      targetType: "election_voter",
      targetId: voter.id,
      details: { electionId: election.id, recipient: voter.email, delivery: "failed" },
    });
    return res.status(502).json({
      error: rollbackFailed
        ? "Credential email failed and the previous password could not be restored. Contact support before retrying."
        : "Credential email failed. The voter's previous password was kept unchanged.",
    });
  }

  const { data: deliveredVoter, error: deliveryError } = await supabase.from("election_voters")
    .update({ credential_delivery: "sent" })
    .eq("election_id", election.id)
    .eq("id", voter.id)
    .eq("password_hash", passwordHash)
    .select("id")
    .maybeSingle();
  if (deliveryError || !deliveredVoter) {
    console.error(`[elections] Couldn't record credential delivery for ${voter.voter_id}:`, deliveryError?.message || "credentials changed concurrently");
    return res.status(500).json({ error: "The email was sent, but its delivery status could not be recorded." });
  }
  await logActivity(req, {
    action: "election.voter_credentials_resent",
    summary: `New credentials were emailed to ${voter.name} for ${election.name}.`,
    targetType: "election_voter",
    targetId: voter.id,
    details: { electionId: election.id, recipient: voter.email, delivery: "sent" },
  });
  return res.json({ status: "sent", message: `New credentials were sent to ${voter.email}.` });
}));

router.post("/", asyncHandler(async (req, res) => {
  const name = String(req.body.name || req.body.title || "").trim();
  const year = Number(req.body.year);
  const electionDate = String(req.body.date || "").trim();
  const sample = req.body.sample === true;
  const voters = req.body.voters;
  const positions = req.body.positions;

  if (!name) return res.status(400).json({ error: "Election name is required." });
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return res.status(400).json({ error: "Enter a valid four-digit election year." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(electionDate) || Number.isNaN(Date.parse(`${electionDate}T00:00:00Z`))) {
    return res.status(400).json({ error: "Choose a valid election day." });
  }
  if (!Array.isArray(voters) || !voters.length) return res.status(400).json({ error: "Upload a voter list before creating the election." });
  if (!Array.isArray(positions) || positions.length < 2 || positions.length > 6) {
    return res.status(400).json({ error: "Add between two and six election positions." });
  }

  const normalizedVoters = [];
  const emails = new Set();
  for (const [index, voter] of voters.entries()) {
    const voterName = String(voter.name || "").trim().replace(/\s+/g, " ");
    const block = String(voter.block || "").trim().replace(/\s+/g, " ");
    const email = String(voter.email || "").trim().toLowerCase();
    if (!voterName || !block) return res.status(400).json({ error: `Voter row ${index + 1} needs a name and block.` });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: `Voter row ${index + 1} needs a valid email address.` });
    if (emails.has(email)) return res.status(400).json({ error: `The voter list contains duplicate email ${email}.` });
    emails.add(email);
    normalizedVoters.push({
      id: randomUUID(),
      voter_id: `${year}-${String(index + 1).padStart(4, "0")}`,
      name: voterName,
      normalized_name: normalizeName(voterName),
      block,
      email,
      username: `vd${year}.${randomUUID().replace(/-/g, "").slice(0, 12)}`.toLowerCase(),
      password: sample ? "" : genPassword(12),
    });
  }

  const rosterByName = new Map();
  normalizedVoters.forEach((voter) => {
    const matches = rosterByName.get(voter.normalized_name) || [];
    matches.push(voter);
    rosterByName.set(voter.normalized_name, matches);
  });
  const candidateRows = [];
  const normalizedPositions = [];
  const seenPositions = new Set();
  for (const [positionIndex, position] of positions.entries()) {
    const positionName = String(position.name || "").trim();
    const positionKey = normalizeName(positionName);
    if (!positionName) return res.status(400).json({ error: `Position ${positionIndex + 1} needs a name.` });
    if (seenPositions.has(positionKey)) return res.status(400).json({ error: `Position "${positionName}" is duplicated.` });
    seenPositions.add(positionKey);
    if (!Array.isArray(position.candidates) || position.candidates.length < 2) {
      return res.status(400).json({ error: `${positionName} needs at least two candidates.` });
    }
    const seenCandidates = new Set();
    for (const [candidateIndex, candidate] of position.candidates.entries()) {
      const candidateName = String(candidate.name || "").trim().replace(/\s+/g, " ");
      const candidateKey = normalizeName(candidateName);
      const matchingVoters = rosterByName.get(candidateKey) || [];
      if (!candidateName || matchingVoters.length !== 1) {
        return res.status(400).json({
          error: matchingVoters.length > 1
            ? `"${candidateName}" matches more than one voter. Candidate names must uniquely match a voter.`
            : `"${candidateName}" must exactly match a name in the voter list.`,
        });
      }
      if (seenCandidates.has(candidateKey)) return res.status(400).json({ error: `${candidateName} is listed more than once for ${positionName}.` });
      seenCandidates.add(candidateKey);
      const linkedVoter = matchingVoters[0];
      candidateRows.push({
        voter_id: linkedVoter.id,
        position: positionName,
        name: linkedVoter.name,
        block: linkedVoter.block,
        slate: String(candidate.slate || "").trim() || "Independent",
        ballot_number: candidateIndex + 1,
      });
    }
    normalizedPositions.push({ name: positionName });
  }

  const { data: createdElection, error: electionError } = await supabase
    .from("elections")
    .insert({ name, year, election_date: electionDate, is_sample: sample })
    .select("*")
    .single();
  if (electionError) {
    if (electionError.code === "23505") return res.status(409).json({ error: "An election with this name and year already exists." });
    return res.status(500).json({ error: "Couldn't create the election." });
  }

  const voterRows = [];
  try {
    for (const voter of normalizedVoters) {
      voterRows.push({
        election_id: createdElection.id,
        voter_id: voter.voter_id,
        name: voter.name,
        normalized_name: voter.normalized_name,
        block: voter.block,
        email: voter.email,
        username: voter.username,
        password_hash: sample ? await bcrypt.hash(genPassword(24), 10) : await bcrypt.hash(voter.password, 10),
        credential_delivery: sample ? "sample" : "pending",
      });
    }
    const { error: voterInsertError } = await supabase.from("election_voters").insert(voterRows);
    if (voterInsertError) throw voterInsertError;
    const electionCandidates = candidateRows.map((candidate) => ({ ...candidate, election_id: createdElection.id }));
    const { error: candidateInsertError } = await supabase.from("election_candidates").insert(electionCandidates);
    if (candidateInsertError) throw candidateInsertError;
  } catch (error) {
    const { error: rollbackError } = await supabase.from("elections").delete().eq("id", createdElection.id);
    if (rollbackError) console.error("[elections] Failed to roll back incomplete election:", rollbackError.message);
    if (error.code === "23505") return res.status(409).json({ error: "A voter email or candidate is duplicated in this election." });
    return res.status(500).json({ error: "Couldn't save the voter list and candidates." });
  }

  let credentialsSent = 0;
  let credentialsFailed = 0;
  if (!sample) {
    for (const voter of normalizedVoters) {
      const mailResult = await sendMail({
        to: voter.email,
        ...studentCredentialsEmail({ name: voter.name, username: voter.username, password: voter.password }),
      });
      const delivery = mailResult.delivered ? "sent" : "failed";
      if (mailResult.delivered) credentialsSent++;
      else credentialsFailed++;
      const { error: deliveryError } = await supabase
        .from("election_voters")
        .update({ credential_delivery: delivery })
        .eq("election_id", createdElection.id)
        .eq("voter_id", voter.voter_id);
      if (deliveryError) console.error(`[elections] Couldn't record credential delivery for ${voter.voter_id}:`, deliveryError.message);
    }
  }

  await logActivity(req, {
    action: "election.created",
    summary: `Created ${name} (${year}) with ${normalizedVoters.length} voters.`,
    targetType: "election",
    targetId: createdElection.id,
    details: {
      year,
      voters: normalizedVoters.length,
      positions: normalizedPositions.length,
      credentialsSent,
      credentialsFailed,
      sample,
    },
  });
  res.status(201).json({
    election: electionSummary(createdElection, voterRows.map((voter) => ({ ...voter, voted: false }))),
    delivery: { sent: credentialsSent, failed: credentialsFailed, sample },
  });
}));

router.post("/:id/voting-open", asyncHandler(async (req, res) => {
  const open = req.body.open;
  if (typeof open !== "boolean") return res.status(400).json({ error: "Voting status must be true or false." });
  const { data: election, error: lookupError } = await supabase.from("elections").select("*").eq("id", req.params.id).maybeSingle();
  if (lookupError) return res.status(500).json({ error: "Couldn't load the election." });
  if (!election) return res.status(404).json({ error: "Election not found." });
  if (election.status === "Certified" || election.status === "Archived") return res.status(409).json({ error: "Certified or archived elections cannot be reopened." });
  const { data, error } = await supabase.from("elections")
    .update({ voting_open: open, status: open ? "Open" : "Archived", updated_at: new Date().toISOString() })
    .eq("id", election.id)
    .select("*")
    .single();
  if (error) return res.status(500).json({ error: "Couldn't update election voting status." });
  await logActivity(req, {
    action: open ? "election.voting_status_changed" : "election.archived",
    summary: open
      ? `Voting was opened for ${election.name}.`
      : `Voting was closed and ${election.name} was automatically archived.`,
    targetType: "election",
    targetId: election.id,
    details: { votingOpen: open, status: data.status, year: election.year },
  });
  res.json({ election: electionSummary(data), votingOpen: open });
}));

router.post("/:id/status", asyncHandler(async (req, res) => {
  const status = String(req.body.status || "");
  if (!["Certified", "Archived"].includes(status)) return res.status(400).json({ error: "Status must be Certified or Archived." });
  const { data: election, error: lookupError } = await supabase.from("elections").select("*").eq("id", req.params.id).maybeSingle();
  if (lookupError) return res.status(500).json({ error: "Couldn't load the election." });
  if (!election) return res.status(404).json({ error: "Election not found." });
  if (election.voting_open) return res.status(409).json({ error: "Close voting before certifying or archiving the election." });
  const { data, error } = await supabase.from("elections")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", election.id)
    .select("*")
    .single();
  if (error) return res.status(500).json({ error: "Couldn't update election status." });
  await logActivity(req, {
    action: status === "Archived" ? "election.archived" : "election.certified",
    summary: `${election.name} was marked ${status.toLowerCase()}.`,
    targetType: "election",
    targetId: election.id,
    details: { status, year: election.year },
  });
  res.json({ election: electionSummary(data) });
}));

module.exports = router;
