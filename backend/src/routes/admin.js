const express = require("express");
const multer = require("multer");
const Papa = require("papaparse");
const bcrypt = require("bcryptjs");
const { supabase } = require("../db");
const { requireAdmin } = require("../auth");
const { isGmail, asyncHandler } = require("../utils");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

router.use(requireAdmin);

/* ---------------------------- dashboard stats ---------------------------- */
router.get("/stats", asyncHandler(async (_req, res) => {
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
  const { error } = await supabase.from("settings").upsert({ key: "voting_open", value: open ? "true" : "false" });
  if (error) return res.status(500).json({ error: "Couldn't update election status." });
  res.json({ votingOpen: open });
}));

/* ---------------------------- students / roster ---------------------------- */
router.get("/students", asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from("students")
    .select("id_no, name, block, email, registered, registered_at, voted, voted_at, created_at")
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: "Couldn't load the roster." });
  res.json({ students: data });
}));

router.post("/students", asyncHandler(async (req, res) => {
  const id_no = String(req.body.id_no || "").trim();
  const name = String(req.body.name || "").trim();
  const block = String(req.body.block || "").trim();
  if (!id_no || !name) return res.status(400).json({ error: "Student ID and name are required." });

  const { error } = await supabase.from("students").insert({ id_no, name, block });
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That Student ID already exists." });
    return res.status(500).json({ error: "Couldn't add that student." });
  }
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
  const { error } = await supabase.from("students").upsert(rows, { onConflict: "id_no" });
  if (error) return res.status(500).json({ error: "Import failed while writing to the database." });

  res.json({ status: "imported", count: rows.length });
}));

router.delete("/students/:id_no", asyncHandler(async (req, res) => {
  const { error } = await supabase.from("students").delete().eq("id_no", req.params.id_no);
  if (error) return res.status(500).json({ error: "Couldn't remove that student." });
  res.json({ status: "removed" });
}));

/* ---------------------------- candidates ---------------------------- */
router.get("/candidates", asyncHandler(async (_req, res) => {
  const { data, error } = await supabase.from("candidates").select("*").order("position", { ascending: true });
  if (error) return res.status(500).json({ error: "Couldn't load candidates." });
  res.json({ candidates: data });
}));

router.post("/candidates", asyncHandler(async (req, res) => {
  const position = String(req.body.position || "").trim();
  const name = String(req.body.name || "").trim();
  const slogan = String(req.body.slogan || "").trim();
  if (!position || !name) return res.status(400).json({ error: "Position and candidate name are required." });

  const { error } = await supabase.from("candidates").insert({ position, name, slogan: slogan || null });
  if (error) return res.status(500).json({ error: "Couldn't add that candidate." });
  res.json({ status: "added" });
}));

router.delete("/candidates/:id", asyncHandler(async (req, res) => {
  const { error } = await supabase.from("candidates").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: "Couldn't remove that candidate." });
  res.json({ status: "removed" });
}));

/* ---------------------------- results ---------------------------- */
router.get("/results", asyncHandler(async (_req, res) => {
  const { data: candidates, error: candError } = await supabase.from("candidates").select("position, name");
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
    if (!byPosition[c.position]) byPosition[c.position] = [];
    byPosition[c.position].push({ name: c.name, votes: tally[`${c.position}::${c.name}`] || 0 });
  }
  const results = Object.entries(byPosition).map(([position, list]) => ({ position, candidates: list }));
  res.json({ results });
}));

/* ---------------------------- admin accounts ---------------------------- */
router.get("/admins", asyncHandler(async (_req, res) => {
  const { data, error } = await supabase.from("admins").select("id, name, email, username, created_at").order("created_at");
  if (error) return res.status(500).json({ error: "Couldn't load admin accounts." });
  res.json({ admins: data });
}));

router.post("/admins", asyncHandler(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim();
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!name || !email || !username || !password) return res.status(400).json({ error: "Please fill in every field." });
  if (!isGmail(email)) return res.status(400).json({ error: "Please use a Gmail address." });
  if (password.length < 8) return res.status(400).json({ error: "Password should be at least 8 characters." });

  const { data: existing } = await supabase.from("admins").select("id").ilike("username", username).maybeSingle();
  if (existing) return res.status(409).json({ error: "That username is already taken." });

  const password_hash = await bcrypt.hash(password, 10);
  const { error } = await supabase.from("admins").insert({ name, email, username, password_hash });
  if (error) return res.status(500).json({ error: "Couldn't add that admin." });
  res.json({ status: "added" });
}));

router.delete("/admins/:id", asyncHandler(async (req, res) => {
  const { count } = await supabase.from("admins").select("*", { count: "exact", head: true });
  if ((count || 0) <= 1) return res.status(400).json({ error: "You can't remove the last remaining admin account." });
  if (req.params.id === req.auth.id) return res.status(400).json({ error: "You can't remove your own account while logged in." });

  const { error } = await supabase.from("admins").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: "Couldn't remove that admin." });
  res.json({ status: "removed" });
}));

module.exports = router;
