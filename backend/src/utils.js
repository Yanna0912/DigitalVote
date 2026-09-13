function genUsername(name, idNo) {
  const first = (name.split(",")[1] || "").trim().split(" ")[0] || "voter";
  const last = (name.split(",")[0] || "").trim().split(" ")[0] || "ccdi";
  const tail = String(idNo).replace(/[^a-zA-Z0-9]/g, "").slice(-4);
  return `${first}.${last}${tail}`.toLowerCase().replace(/[^a-z0-9.]/g, "");
}

function studentDisplayName(student) {
  const first = String(student?.first_name || "").trim();
  const last = String(student?.last_name || "").trim();
  const suffix = String(student?.suffix || "").trim();
  if (first || last) return `${last}, ${first}${suffix ? ` ${suffix}` : ""}`.trim();
  return String(student?.name || student?.id_no || "voter").trim();
}

function studentNameParts(name) {
  const value = String(name || "").trim();
  if (!value) return { first_name: "", last_name: "", suffix: null };
  const commaParts = value.includes(",") ? value.split(/,(.+)/).map((part) => part.trim()) : null;
  const lastPart = commaParts ? commaParts[0] : "";
  const words = (commaParts ? commaParts[1] : value).split(/\s+/).filter(Boolean);
  const suffixes = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);
  const suffix = suffixes.has((words.at(-1) || "").toLowerCase()) ? words.pop() : null;
  if (!commaParts) {
    return { first_name: words.shift() || "", last_name: words.join(" "), suffix };
  }
  return {
    first_name: words.join(" ") || lastPart,
    last_name: lastPart,
    suffix,
  };
}

function genPassword(length = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function maskEmail(email) {
  const [user, domain] = String(email).split("@");
  if (!domain) return email;
  const visible = user.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(user.length - 1, 3))}@${domain}`;
}

function isGmail(email) {
  return /^[^\s@]+@gmail\.com$/i.test(String(email).trim());
}

/**
 * Wraps an async Express route handler so a rejected promise (e.g. a
 * network error talking to Supabase) is forwarded to next(err) instead
 * of becoming an unhandled rejection that crashes the whole process.
 * Express 4 does not do this automatically for async handlers.
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { genUsername, studentDisplayName, studentNameParts, genPassword, genOtp, maskEmail, isGmail, asyncHandler };
