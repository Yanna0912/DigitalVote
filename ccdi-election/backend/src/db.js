const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  // eslint-disable-next-line no-console
  console.warn(
    "[db] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. " +
    "The server will start, but every database call will fail until " +
    "you add them to your environment (see .env.example)."
  );
}

const supabase = createClient(url || "https://placeholder.supabase.co", key || "placeholder", {
  auth: { persistSession: false },
});

module.exports = { supabase };
