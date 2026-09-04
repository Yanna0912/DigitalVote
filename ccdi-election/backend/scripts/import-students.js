#!/usr/bin/env node
/**
 * Bulk-import students into Supabase from a CSV file.
 *
 * Usage:
 *   node scripts/import-students.js path/to/students.csv
 *
 * Expects a CSV with headers: id_no, name, block
 * (extra columns are ignored; header names are case-insensitive).
 *
 * Safe to re-run: existing id_no rows are updated (name/block only —
 * email, username, password, and voted status are never touched here),
 * new id_no rows are inserted.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your
 * environment or a .env file in this folder.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const Papa = require("papaparse");
const { createClient } = require("@supabase/supabase-js");

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scripts/import-students.js path/to/students.csv");
    process.exit(1);
  }
  const fullPath = path.resolve(file);
  if (!fs.existsSync(fullPath)) {
    console.error(`File not found: ${fullPath}`);
    process.exit(1);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (env or .env) before running this.");
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const csvText = fs.readFileSync(fullPath, "utf-8");
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  if (parsed.errors?.length) {
    console.error("CSV parse errors:", parsed.errors.slice(0, 5));
    process.exit(1);
  }

  const rows = parsed.data
    .map((r) => {
      const get = (obj, keys) => {
        for (const k of Object.keys(obj)) {
          if (keys.includes(k.trim().toLowerCase())) return obj[k];
        }
        return "";
      };
      return {
        id_no: String(get(r, ["id_no", "id no", "student id", "id"]) || "").trim(),
        name: String(get(r, ["name", "full name"]) || "").trim(),
        block: String(get(r, ["block", "section"]) || "").trim(),
      };
    })
    .filter((r) => r.id_no && r.name);

  if (!rows.length) {
    console.error("No valid rows found. Make sure the CSV has id_no and name columns.");
    process.exit(1);
  }

  console.log(`Importing ${rows.length} student(s)...`);

  // Supabase upsert has a payload size limit in practice; chunk to be safe.
  const chunkSize = 500;
  let imported = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from("students").upsert(chunk, { onConflict: "id_no" });
    if (error) {
      console.error(`Failed on rows ${i}-${i + chunk.length}:`, error.message);
      process.exit(1);
    }
    imported += chunk.length;
    console.log(`  ...${imported}/${rows.length}`);
  }

  console.log(`Done. Imported/updated ${imported} student(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
