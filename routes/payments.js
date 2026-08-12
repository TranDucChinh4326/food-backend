const express = require("express");
const db = require("../db");

const router = express.Router();

function normalizeText(value) {
  return String(value || "").trim();
}

function parseAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount) : 0;
}

function extractOrderId(content) {
  const match = normalizeText(content).match(/FOODHUB\s*DH\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function getWebhookSecret(req) {
  return (
    req.headers["x-webhook-secret"] ||
    req.headers["x-sepay-signature"] ||
    req.headers["x-casso-signature"] ||
    req.query.secret ||
    ""
  );
}

function normalizeTransaction(body) {
  const data = body.data || body.transaction || body;
  const content = data.content || data.description || data.transfer_content || data.transactionContent || "";
  const amount = data.amount || data.transferAmount || data.creditAmount || data.money || data.value;
  const transactionId = data.transactionId || data.id || data.reference || data.refNo || data.code || "";

  return {
    transactionId: normalizeText(transactionId),
    content: normalizeText(content),
    amount: parseAmount(amount),
    rawPayload: body
  };
}

router.post("/bank-transfer/webhook", async (req, res) => {
  const configuredSecret = process.env.PAYMENT_WEBHOOK_SECRET || "";

  if (configuredSecret && getWebhookSecret(req) !== configuredSecret) {
    return res.status(401).json({ message: "Invalid webhook secret" });
  }

  const transaction = normalizeTransaction(req.body || {});
  const orderId = extractOrderId(transaction.content);

  if (!orderId || !transaction.amount) {
    return res.status(400).json({ message: "Missing order code or amount" });
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [sessions] = await connection.query(
      `SELECT payment_sessions.id, payment_sessions.order_id, payment_sessions.amount, payment_sessions.status,
              orders.payment_status, orders.status AS order_status
       FROM payment_sessions
       JOIN orders ON orders.id = payment_sessions.order_id
       WHERE payment_sessions.order_id = ?
       LIMIT 1
       FOR UPDATE`,
      [orderId]
    );

    if (sessions.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Payment session not found" });
    }

    const session = sessions[0];

    if (Number(session.amount) !== Number(transaction.amount)) {
      await connection.query(
        `INSERT INTO payment_transactions
          (order_id, payment_session_id, provider_transaction_id, amount, transfer_content, status, raw_payload)
         VALUES (?, ?, ?, ?, ?, 'amount_mismatch', ?)`,
        [
          orderId,
          session.id,
          transaction.transactionId || null,
          transaction.amount,
          transaction.content,
          JSON.stringify(transaction.rawPayload)
        ]
      );
      await connection.commit();
      return res.status(409).json({ message: "Payment amount mismatch" });
    }

    await connection.query(
      `INSERT INTO payment_transactions
        (order_id, payment_session_id, provider_transaction_id, amount, transfer_content, status, raw_payload)
       VALUES (?, ?, ?, ?, ?, 'matched', ?)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         raw_payload = VALUES(raw_payload)`,
      [
        orderId,
        session.id,
        transaction.transactionId || `order-${orderId}-${transaction.amount}`,
        transaction.amount,
        transaction.content,
        JSON.stringify(transaction.rawPayload)
      ]
    );

    await connection.query(
      "UPDATE orders SET payment_status = 'paid', status = 'pending' WHERE id = ?",
      [orderId]
    );
    await connection.query(
      "UPDATE payment_sessions SET status = 'paid', paid_at = NOW() WHERE id = ?",
      [session.id]
    );

    await connection.commit();
    res.json({ message: "Payment confirmed", orderId });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    res.status(500).json({ message: "Server error" });
  } finally {
    connection.release();
  }
});

module.exports = router;
