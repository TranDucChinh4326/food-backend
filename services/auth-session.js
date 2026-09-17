const crypto = require("crypto");
const db = require("../db");

const CLIENT_TYPES = new Set(["web", "app"]);

function normalizeClientType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return CLIENT_TYPES.has(normalized) ? normalized : "web";
}

function getRequestClientType(req) {
  return normalizeClientType(
    req.get("x-client-type") || req.body?.clientType || req.query?.clientType
  );
}

async function createLoginSession(userId, clientType) {
  const normalizedClientType = normalizeClientType(clientType);
  const sessionId = crypto.randomBytes(32).toString("hex");

  await db.query(
    `INSERT INTO user_login_sessions (user_id, client_type, session_id, created_at, last_used_at)
     VALUES (?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       session_id = VALUES(session_id),
       created_at = NOW(),
       last_used_at = NOW()`,
    [userId, normalizedClientType, sessionId]
  );

  return { clientType: normalizedClientType, sessionId };
}

async function isLoginSessionActive(userId, clientType, sessionId) {
  if (!userId || !CLIENT_TYPES.has(clientType) || !sessionId) return false;

  const [rows] = await db.query(
    `SELECT session_id
     FROM user_login_sessions
     WHERE user_id = ? AND client_type = ?
     LIMIT 1`,
    [userId, clientType]
  );

  const activeSessionId = rows[0]?.session_id;
  if (!activeSessionId) return false;

  const matches = activeSessionId.length === sessionId.length
    && crypto.timingSafeEqual(Buffer.from(activeSessionId), Buffer.from(sessionId));

  if (matches) {
    db.query(
      `UPDATE user_login_sessions
       SET last_used_at = NOW()
       WHERE user_id = ? AND client_type = ?
         AND last_used_at < NOW() - INTERVAL 1 MINUTE`,
      [userId, clientType]
    ).catch(error => console.error("Login session touch failed:", error.message));
  }

  return matches;
}

module.exports = {
  createLoginSession,
  getRequestClientType,
  isLoginSessionActive,
  normalizeClientType
};
