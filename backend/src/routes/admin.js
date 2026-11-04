const express = require("express");
const multer = require("multer");
const Papa = require("papaparse");
const bcrypt = require("bcryptjs");
const { supabase } = require("../db");
const { requireAdmin } = require("../auth");
const { logActivity } = require("../audit");
const { studentDisplayName, studentNameParts, genPassword, isGmail, asyncHandler } = require("../utils");
const { sendMail, studentCredentialsEmail } = require("../mailer");
const { candidateRacePosition } = require("../election");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

router.use(requireAdmin);

async function electionIdFromRequest(req, res) {
  const electionId = String(req.query.electionId || "").trim();
  if (!electionId) return null;
  const { data: election, error } = await supabase.from("elections")
    .select("id, name, year, status, voting_open, election_date")
    .eq("id", electionId)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: "Couldn't load the selected election." });
    return undefined;
  }
  if (!election) {
    res.status(404).json({ error: "Selected election not found." });
    return undefined;
  }
  return election;
}

router.get("/me", asyncHandler(async (req, res) => {
  const { data: admin, error } = await supabase
    .from("admins")
    .select("id, name, email, username, role")
    .eq("id", req.auth.id)
    .maybeSingle();
  if (error || !admin) return res.status(404).json({ error: "Admin account not found." });
  res.json({ admin });
}));

router.get("/activity", asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 50));
  const start = (page - 1) * pageSize;
  const { data, error } = await supabase
    .from("activity_logs")
    .select("id, actor_role, actor_id, actor_name, action, summary, target_type, target_id, details, created_at")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(start, start + pageSize);
  if (error) return res.status(500).json({ error: "Couldn't load activity." });
  const events = data || [];
  res.json({ events: events.slice(0, pageSize), page, pageSize, hasMore: events.length > pageSize });
}));

/* ---------------------------- dashboard stats ---------------------------- */
router.get("/stats", asyncHandler(async (req, res) => {
  const election = await electionIdFromRequest(req, res);
  if (election === undefined) return;
  if (election) {
    const [
      { count: total, error: voterError },
      { count: voted, error: votedError },
      { count: credentialsGenerated, error: credentialError },
    ] = await Promise.all([
      supabase.from("election_voters").select("*", { count: "exact", head: true }).eq("election_id", election.id),
      supabase.from("election_voters").select("*", { count: "exact", head: true }).eq("election_id", election.id).eq("voted", true),
      supabase.from("election_voters").select("*", { count: "exact", head: true }).eq("election_id", election.id).eq("credential_delivery", "sent"),
    ]);
    if (voterError || votedError || credentialError) return res.status(500).json({ error: "Couldn't load election stats." });
    return res.json({
      total: total || 0,
      registeredNotVoted: Math.max(0, (total || 0) - (voted || 0)),
      credentialsGenerated: credentialsGenerated || 0,
      voted: voted || 0,
      votingOpen: election.voting_open,
    });
  }

  const { count: total } = await supabase.from("students").select("*", { count: "exact", head: true });
  const { count: registeredNotVoted } = await supabase
    .from("students").select("*", { count: "exact", head: true }).eq("registered", true).eq("voted", false);
  const { count: voted } = await supabase.from("students").select("*", { count: "exact", head: true }).eq("voted", true);
  const { data: setting } = await supabase.from("settings").select("value").eq("key", "voting_open").maybeSingle();

  res.json({
    total: total || 0,
    registeredNotVoted: registeredNotVoted || 0,
    voted: voted || 0,
    votingOpen: setting?.value === "true",
  });
}));

/* ---------------------------- election status ---------------------------- */
router.post("/settings/voting-open", asyncHandler(async (req, res) => {
  const open = !!req.body.open;
  const { data: currentSetting } = await supabase.from("settings").select("value").eq("key", "voting_open").maybeSingle();
  const { error } = await supabase.from("settings").upsert({ key: "voting_open", value: open ? "true" : "false" });
  if (error) return res.status(500).json({ error: "Couldn't update election status." });
  if ((currentSetting?.value === "true") !== open) {
    await logActivity(req, {
      action: "election.voting_status_changed",
      summary: `Voting was ${open ? "opened" : "closed"}.`,
      targetType: "election",
      targetId: "voting_status",
      details: { votingOpen: open },
    });
  }
  res.json({ votingOpen: open });
}));

/* ---------------------------- students / roster ---------------------------- */
router.get("/students", asyncHandler(async (req, res) => {
  const election = await electionIdFromRequest(req, res);
  if (election === undefined) return;
  if (election) {
    const { data, error } = await supabase.from("election_voters")
      .select("voter_id, name, block, email, username, credential_delivery, voted, voted_at, created_at")
      .eq("election_id", election.id)
      .order("name", { ascending: true });
    if (error) return res.status(500).json({ error: "Couldn't load the election voter list." });
    return res.json({
      students: (data || []).map((voter) => ({
        id_no: voter.voter_id,
        name: voter.name,
        block: voter.block,
        email: voter.email,
        username: voter.username,
        registered: true,
        voted: voter.voted,
        voted_at: voter.voted_at,
        created_at: voter.created_at,
        credentials_delivery: voter.credential_delivery,
      })),
    });
  }

  const { data, error } = await supabase
    .from("students")
    .select("id_no, first_name, last_name, suffix, block, email, username, registered, registered_at, voted, voted_at, created_at")
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: "Couldn't load the roster." });
  res.json({ students: data.map((student) => ({ ...student, name: studentDisplayName(student) })) });
}));

router.post("/students/:id_no/resend-credentials", asyncHandler(async (req, res) => {
  const { data: student, error: lookupError } = await supabase.from("students").select("*").eq("id_no", req.params.id_no).maybeSingle();
  if (lookupError) return res.status(500).json({ error: "Couldn't load that student." });
  if (!student || !student.registered) {
    return res.status(409).json({ error: "Credentials can only be resent for a registered student." });
  }
  if (!student.email) return res.status(400).json({ error: "The student has no saved email address." });

  const displayName = studentDisplayName(student);
  const plainPassword = genPassword();
  const password_hash = await bcrypt.hash(plainPassword, 10);
  const previousPasswordHash = student.password_hash;
  const { error: updateError } = await supabase.from("students").update({ password_hash }).eq("id_no", student.id_no);
  if (updateError) return res.status(500).json({ error: "Couldn't refresh the student's password." });

  const mailResult = await sendMail({
    to: student.email,
    ...studentCredentialsEmail({ name: displayName, username: student.username, password: plainPassword }),
  });
  if (!mailResult.delivered) {
    const { error: rollbackError } = await supabase.from("students").update({ password_hash: previousPasswordHash }).eq("id_no", student.id_no);
    if (rollbackError) console.error(`[credentials] Failed to restore password hash for ${student.id_no}:`, rollbackError.message);
    await logActivity(req, {
      action: "student.credentials_email_failed",
      summary: `Credential resend failed for ${displayName}.`,
      targetType: "student",
      targetId: student.id_no,
      details: { recipient: student.email, delivery: "failed", credentialType: "password_reset" },
    });
    return res.status(502).json({ error: "Credentials could not be emailed. The existing password was kept unchanged." });
  }
  await logActivity(req, {
    action: "student.credentials_resent",
    summary: `New voting credentials were emailed to ${displayName}.`,
    targetType: "student",
    targetId: student.id_no,
    details: { recipient: student.email, delivery: "sent", credentialType: "username_and_password" },
  });
  res.json({
    status: "sent",
    emailed: true,
    message: `New credentials were sent to ${student.email}.`,
  });
}));

router.post("/students", asyncHandler(async (req, res) => {
  const id_no = String(req.body.id_no || "").trim();
  const name = String(req.body.name || "").trim();
  const block = String(req.body.block || "").trim();
  if (!id_no || !name) return res.status(400).json({ error: "Student ID and name are required." });

  const { first_name, last_name, suffix } = studentNameParts(name);
  const { error } = await supabase.from("students").insert({ id_no, first_name, last_name, suffix, block });
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That Student ID already exists." });
    return res.status(500).json({ error: "Couldn't add that student." });
  }
  await logActivity(req, {
    action: "student.roster_added",
    summary: `Added ${studentDisplayName({ first_name, last_name, suffix })} to the roster.`,
    targetType: "student",
    targetId: id_no,
    details: { block: block || null },
  });
  res.json({ status: "added" });
}));

/**
 * POST /api/admin/students/import
 * multipart/form-data, field name "file" — a CSV with headers
 * id_no, name, block (extra columns are ignored). Existing IDs are
 * updated in place (name/block only — never touches email or
 * credentials for students who already registered).
 */
router.post("/students/import", upload.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Attach a CSV file under the field name 'file'." });

  const text = req.file.buffer.toString("utf-8");
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (parsed.errors?.length) {
    return res.status(400).json({ error: "Couldn't parse that CSV.", details: parsed.errors.slice(0, 3) });
  }

  const rows = parsed.data
    .map((r) => ({
      id_no: String(r.id_no ?? r.ID_NO ?? r["Student ID"] ?? "").trim(),
      name: String(r.name ?? r.Name ?? "").trim(),
      block: String(r.block ?? r.Block ?? "").trim(),
    }))
    .filter((r) => r.id_no && r.name);

  if (!rows.length) return res.status(400).json({ error: "No valid rows found. Expected columns: id_no, name, block." });

  // Upsert on id_no. Supabase upsert only touches the columns listed, so
  // email/username/password_hash/voted are left alone for existing rows.
  const normalizedRows = rows.map((row) => ({ ...studentNameParts(row.name), id_no: row.id_no, block: row.block }));
  const { error } = await supabase.from("students").upsert(normalizedRows, { onConflict: "id_no" });
  if (error) return res.status(500).json({ error: "Import failed while writing to the database." });

  await logActivity(req, {
    action: "student.roster_imported",
    summary: `Imported ${rows.length} student roster ${rows.length === 1 ? "record" : "records"}.`,
    targetType: "student_roster",
    details: { count: rows.length },
  });
  res.json({ status: "imported", count: rows.length });
}));

router.delete("/students/:id_no", asyncHandler(async (req, res) => {
  return res.status(403).json({ error: "Student records cannot be deleted." });
}));

/* ---------------------------- candidates ---------------------------- */
router.get("/candidates", asyncHandler(async (req, res) => {
  const election = await electionIdFromRequest(req, res);
  if (election === undefined) return;
  if (election) {
    const { data: candidates, error } = await supabase.from("election_candidates")
      .select("id, voter_id, position, name, block, slate, ballot_number")
      .eq("election_id", election.id)
      .order("position", { ascending: true })
      .order("ballot_number", { ascending: true });
    if (error) return res.status(500).json({ error: "Couldn't load election candidates." });
    const [{ data: votes, error: voteError }, { data: voters, error: voterError }] = await Promise.all([
      supabase.from("election_votes")
        .select("candidate_id, position")
        .eq("election_id", election.id),
      supabase.from("election_voters")
        .select("id, voter_id")
        .eq("election_id", election.id),
    ]);
    if (voteError || voterError) return res.status(500).json({ error: "Couldn't load election candidate totals." });
    const voterIdsByRowId = new Map((voters || []).map((voter) => [voter.id, voter.voter_id]));
    return res.json({
      candidates: (candidates || []).map((candidate) => ({
        id: candidate.id,
        id_no: voterIdsByRowId.get(candidate.voter_id) || null,
        name: candidate.name,
        position: candidate.position,
        race_position: candidateRacePosition(candidate),
        block: candidate.block,
        party: candidate.slate,
        photo: null,
        ballot_number: candidate.ballot_number,
        result: { votes: (votes || []).filter((vote) => vote.candidate_id === candidate.id).length },
      })),
    });
  }

  const { data, error } = await supabase.from("candidates").select("*").order("position", { ascending: true });
  if (error) return res.status(500).json({ error: "Couldn't load candidates." });
  res.json({ candidates: data.map((candidate) => ({
    ...candidate,
    race_position: candidateRacePosition(candidate),
    party: candidate.party || candidate.slogan || null,
    id_no: candidate.id_no || null,
    block: candidate.block || null,
    photo: candidate.photo || null,
  })) });
}));

router.post("/candidates", asyncHandler(async (req, res) => {
  const position = String(req.body.position || "").trim();
  const id_no = String(req.body.id_no || "").trim();
  const party = String(req.body.party || "").trim();
  const photo = String(req.body.photo || "").trim();
  if (!position || !id_no) return res.status(400).json({ error: "Position and a roster student are required." });
  if (photo && (!/^data:image\/(jpeg|png|webp);base64,/.test(photo) || photo.length > 5_500_000)) {
    return res.status(400).json({ error: "Candidate photo must be a JPG, PNG, or WebP image smaller than 4 MB." });
  }

  const { data: student, error: studentError } = await supabase
    .from("students")
    .select("id_no, first_name, last_name, suffix, block")
    .eq("id_no", id_no)
    .maybeSingle();
  if (studentError) return res.status(500).json({ error: "Couldn't look up the candidate in the roster." });
  if (!student) return res.status(404).json({ error: "Select a candidate from the student roster." });
  const name = studentDisplayName(student);
  if (position.toLowerCase() === "representative" && !student.block) {
    return res.status(400).json({ error: "A representative candidate must have a block in the roster." });
  }

  const { error } = await supabase.from("candidates").insert({
    position, name, id_no: student.id_no, block: student.block || null, party: party || null, photo: photo || null,
  });
  if (error) return res.status(500).json({ error: "Couldn't add that candidate." });
  await logActivity(req, {
    action: "candidate.added",
    summary: `Added ${name} as a candidate for ${position}.`,
    targetType: "candidate",
    targetId: student.id_no,
    details: { name, position, studentId: student.id_no, party: party || null },
  });
  res.json({ status: "added" });
}));

router.delete("/candidates/:id", asyncHandler(async (req, res) => {
  return res.status(403).json({ error: "Candidates cannot be deleted." });
}));

/* ---------------------------- results ---------------------------- */
router.get("/results", asyncHandler(async (req, res) => {
  const election = await electionIdFromRequest(req, res);
  if (election === undefined) return;
  if (election) {
    const [{ data: candidates, error: candidateError }, { data: votes, error: voteError }] = await Promise.all([
      supabase.from("election_candidates")
        .select("id, position, name, block, slate, ballot_number")
        .eq("election_id", election.id)
        .order("position", { ascending: true })
        .order("ballot_number", { ascending: true }),
      supabase.from("election_votes").select("candidate_id, position").eq("election_id", election.id),
    ]);
    if (candidateError || voteError) return res.status(500).json({ error: "Couldn't load election results." });
    const byPosition = {};
    for (const candidate of candidates || []) {
      const position = candidateRacePosition(candidate);
      if (!position) continue;
      if (!byPosition[position]) byPosition[position] = [];
      byPosition[position].push({
        id: candidate.id,
        id_no: null,
        name: candidate.name,
        position,
        race_position: position,
        block: candidate.block,
        party: candidate.slate,
        photo: null,
        ballot_number: candidate.ballot_number,
        votes: (votes || []).filter((vote) => vote.candidate_id === candidate.id).length,
      });
    }
    return res.json({ results: Object.entries(byPosition).map(([position, list]) => ({ position, candidates: list })) });
  }

  const { data: candidates, error: candError } = await supabase.from("candidates").select("*");
  if (candError) return res.status(500).json({ error: "Couldn't load candidates." });

  const { data: votes, error: voteError } = await supabase.from("votes").select("position, candidate_name");
  if (voteError) return res.status(500).json({ error: "Couldn't load votes." });

  const tally = {};
  for (const v of votes) {
    const key = `${v.position}::${v.candidate_name}`;
    tally[key] = (tally[key] || 0) + 1;
  }

  const byPosition = {};
  for (const c of candidates) {
    const position = candidateRacePosition(c);
    if (!position) continue;
    if (!byPosition[position]) byPosition[position] = [];
    byPosition[position].push({
      ...c,
      race_position: position,
      party: c.party || c.slogan || null,
      id_no: c.id_no || null,
      block: c.block || null,
      photo: c.photo || null,
      votes: tally[`${position}::${c.name}`] || 0,
    });
  }
  const results = Object.entries(byPosition).map(([position, list]) => ({ position, candidates: list }));
  res.json({ results });
}));

/* ---------------------------- admin accounts ---------------------------- */
router.get("/admins", asyncHandler(async (_req, res) => {
  const { data, error } = await supabase.from("admins").select("id, name, email, username, party_list, role, created_at").order("created_at");
  if (error) {
    console.error("[admin] Failed to load admin accounts:", error.code, error.message);
    if (["42P01", "42703", "PGRST204", "PGRST205"].includes(error.code)) {
      return res.status(503).json({
        error: "The admin account database is out of date. Apply backend/sql/schema.sql in Supabase, then try again.",
      });
    }
    return res.status(500).json({ error: "Couldn't load admin accounts." });
  }
  res.json({ admins: data });
}));

router.post("/admins", asyncHandler(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim();
  const party_list = String(req.body.party_list || "").trim();
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const requestedRole = String(req.body.role || "staff").trim().toLowerCase();
  const role = "staff";
  if (!name || !email || !username || !password) return res.status(400).json({ error: "Please fill in every field." });
  if (requestedRole !== "staff") return res.status(400).json({ error: "Only Staff accounts can be created here." });
  if (!isGmail(email)) return res.status(400).json({ error: "Please use a Gmail address." });
  if (password.length < 8) return res.status(400).json({ error: "Password should be at least 8 characters." });

  const { data: existing, error: lookupError } = await supabase.from("admins").select("id").ilike("username", username).maybeSingle();
  if (lookupError) return res.status(500).json({ error: "Couldn't check the account details." });
  if (existing) return res.status(409).json({ error: "That username is already taken." });

  const password_hash = await bcrypt.hash(password, 10);
  const { data: createdAdmin, error } = await supabase.from("admins")
    .insert({ name, email, party_list: party_list || null, username, password_hash, role })
    .select("id")
    .single();
  if (error?.code === "23505") return res.status(409).json({ error: "That username or email is already in use." });
  if (error) return res.status(500).json({ error: "Couldn't add that admin." });
  await logActivity(req, {
    action: "admin.account_added",
    summary: `Added ${role} account for ${name}.`,
    targetType: role,
    targetId: createdAdmin.id,
    details: { username, email, role },
  });
  res.json({ status: "added" });
}));

router.delete("/admins/:id", asyncHandler(async (req, res) => {
  return res.status(403).json({ error: "Admin accounts cannot be deleted." });
}));


module.exports = router;
