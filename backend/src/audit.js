const { supabase } = require("./db");

async function logActivity(req, event) {
  const actor = event.actor || req?.auth || {};
  const actorId = actor.id || actor.id_no || null;
  const actorName = actor.name || actor.username || actor.id_no || "System";
  try {
    const { error } = await supabase.from("activity_logs").insert({
      actor_role: actor.role || "system",
      actor_id: actorId ? String(actorId) : null,
      actor_name: actorName,
      action: event.action,
      summary: event.summary,
      target_type: event.targetType || null,
      target_id: event.targetId ? String(event.targetId) : null,
      details: event.details || {},
    });
    if (error) console.error("[audit] Couldn't record activity:", error.message);
  } catch (error) {
    console.error("[audit] Couldn't record activity:", error.message);
  }
}

module.exports = { logActivity };