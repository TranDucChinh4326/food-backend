const express = require("express");
const crypto = require("crypto");
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

function sortObject(input) {
  return Object.keys(input).sort().reduce((result, key) => {
    result[key] = input[key];
    return result;
  }, {});
}

function verifyVnpayParams(query) {
  const secureHash = query.vnp_SecureHash;
  const hashSecret = process.env.VNPAY_HASH_SECRET || "";

  if (!secureHash || !hashSecret) return false;

  const params = { ...query };
  delete params.vnp_SecureHash;
  delete params.vnp_SecureHashType;

  const signData = new URLSearchParams(sortObject(params)).toString();
  const signed = crypto.createHmac("sha512", hashSecret).update(signData).digest("hex");
  return signed === secureHash;
}

async function applyVnpayResult(params) {
  if (!verifyVnpayParams(params)) {
    return { ok: false, code: "97", message: "Invalid signature" };
  }

  const orderId = Number(params.vnp_TxnRef);
  const amount = Math.round(Number(params.vnp_Amount || 0) / 100);
  const isPaid = params.vnp_ResponseCode === "00" && params.vnp_TransactionStatus === "00";

  if (!orderId || !amount) {
    return { ok: false, code: "01", message: "Order not found" };
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [sessions] = await connection.query(
      `SELECT payment_sessions.id, payment_sessions.amount, payment_sessions.status
       FROM payment_sessions
       JOIN orders ON orders.id = payment_sessions.order_id
       WHERE payment_sessions.order_id = ? AND payment_sessions.method = 'vnpay'
       LIMIT 1
       FOR UPDATE`,
      [orderId]
    );

    if (sessions.length === 0) {
      await connection.rollback();
      return { ok: false, code: "01", message: "Order not found" };
    }

    const session = sessions[0];

    if (Number(session.amount) !== amount) {
      await connection.rollback();
      return { ok: false, code: "04", message: "Invalid amount" };
    }

    if (session.status === "paid") {
      await connection.rollback();
      return { ok: true, code: "02", message: "Order already confirmed", orderId };
    }

    await connection.query(
      `INSERT INTO payment_transactions
        (order_id, payment_session_id, provider_transaction_id, amount, transfer_content, status, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         raw_payload = VALUES(raw_payload)`,
      [
        orderId,
        session.id,
        params.vnp_TransactionNo || `vnpay-${orderId}`,
        amount,
        params.vnp_OrderInfo || "",
        isPaid ? "matched" : "failed",
        JSON.stringify(params)
      ]
    );

    if (isPaid) {
      await connection.query(
        "UPDATE orders SET payment_status = 'paid', status = 'pending' WHERE id = ?",
        [orderId]
      );
      await connection.query(
        "UPDATE payment_sessions SET status = 'paid', paid_at = NOW() WHERE id = ?",
        [session.id]
      );
    } else {
      await connection.query(
        "UPDATE orders SET payment_status = 'failed' WHERE id = ?",
        [orderId]
      );
      await connection.query(
        "UPDATE payment_sessions SET status = 'failed' WHERE id = ?",
        [session.id]
      );
    }

    await connection.commit();
    return { ok: true, code: "00", message: "Confirm success", orderId };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
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

router.get("/vnpay/ipn", async (req, res) => {
  try {
    const result = await applyVnpayResult(req.query || {});
    return res.json({ RspCode: result.code, Message: result.message });
  } catch (error) {
    console.error(error);
    return res.json({ RspCode: "99", Message: "Unknown error" });
  }
});

router.get("/vnpay/return", async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5500";

  try {
    const result = await applyVnpayResult(req.query || {});
    const status = result.ok && ["00", "02"].includes(result.code) ? "paid" : "failed";
    const url = new URL("/track.html", frontendUrl);
    url.searchParams.set("payment", status);
    if (result.orderId) url.searchParams.set("orderId", String(result.orderId));
    return res.redirect(url.toString());
  } catch (error) {
    console.error(error);
    const url = new URL("/track.html", frontendUrl);
    url.searchParams.set("payment", "error");
    return res.redirect(url.toString());
  }
});

module.exports = router;
