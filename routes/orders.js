const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const QR_PAYMENT_TTL_MINUTES = Number(process.env.QR_PAYMENT_TTL_MINUTES || 10);

function isPositiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

function getBankConfig() {
  return {
    bankCode: process.env.BANK_CODE || "",
    accountNo: process.env.BANK_ACCOUNT_NO || "",
    accountName: process.env.BANK_ACCOUNT_NAME || ""
  };
}

function ensureQrBankConfig() {
  const config = getBankConfig();

  if (!config.bankCode || !config.accountNo || !config.accountName) {
    const error = new Error("Chưa cấu hình thong tin ngan hang nhan thanh toan QR");
    error.status = 500;
    throw error;
  }

  return config;
}

function buildTransferContent(orderId) {
  return `FOODHUB DH${orderId}`;
}

function buildVietQrUrl({ bankCode, accountNo, accountName, amount, transferContent }) {
  const query = new URLSearchParams({
    amount: String(amount),
    addInfo: transferContent,
    accountName
  });

  return `https://img.vietqr.io/image/${encodeURIComponent(bankCode)}-${encodeURIComponent(accountNo)}-compact2.png?${query.toString()}`;
}

async function getItemsByOrderIds(orderIds) {
  if (orderIds.length === 0) return {};

  const placeholders = orderIds.map(() => "?").join(",");
  const [items] = await db.query(
    `SELECT order_id, food_id, food_name, price, quantity, subtotal
     FROM order_details
     WHERE order_id IN (${placeholders})
     ORDER BY id ASC`,
    orderIds
  );

  return items.reduce((map, item) => {
    if (!map[item.order_id]) {
      map[item.order_id] = [];
    }

    map[item.order_id].push(item);
    return map;
  }, {});
}

router.post("/", requireAuth, async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      customerName,
      customerPhone,
      customerAddress,
      customerNote = "",
      paymentMethod = "cod",
      items
    } = req.body;
    const normalizedPaymentMethod = String(paymentMethod || "cod").toLowerCase();

    if (!customerName || !customerPhone || !customerAddress) {
      return res.status(400).json({ message: "Vui lòng nhập thong tin giao hàng" });
    }

    if (!["cod", "qr", "wallet"].includes(normalizedPaymentMethod)) {
      return res.status(400).json({ message: "Phuong thuc thanh toan không hợp lệ" });
    }

    if (normalizedPaymentMethod === "wallet") {
      return res.status(400).json({ message: "Thanh toan bang số dư tài khoản chưa được kích hoạt. Vui lòng chọn COD hoặc QR." });
    }

    const bankConfig = normalizedPaymentMethod === "qr" ? ensureQrBankConfig() : null;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Giỏ hàng đang trống" });
    }

    const normalizedItems = items.map(item => ({
      foodId: Number(item.foodId || item.id),
      quantity: Number(item.quantity)
    }));

    const hasInvalidItem = normalizedItems.some(
      item => !isPositiveInteger(item.foodId) || !isPositiveInteger(item.quantity)
    );

    if (hasInvalidItem) {
      return res.status(400).json({ message: "Giỏ hàng không hợp lệ" });
    }

    const demandByFoodId = normalizedItems.reduce((map, item) => {
      map[item.foodId] = (map[item.foodId] || 0) + item.quantity;
      return map;
    }, {});

    const uniqueFoodIds = Object.keys(demandByFoodId).map(Number);
    const placeholders = uniqueFoodIds.map(() => "?").join(",");
    const [foods] = await connection.query(
      `SELECT id, name, price, stock_quantity FROM foods WHERE is_active = 1 AND id IN (${placeholders})`,
      uniqueFoodIds
    );

    if (foods.length !== uniqueFoodIds.length) {
      return res.status(400).json({ message: "Mot so món ăn không cón kha dung" });
    }

    const foodMap = new Map(foods.map(food => [Number(food.id), food]));
    const outOfStockFood = uniqueFoodIds.find(foodId => {
      const food = foodMap.get(foodId);
      return Number(food.stock_quantity || 0) < Number(demandByFoodId[foodId] || 0);
    });

    if (outOfStockFood) {
      return res.status(400).json({ message: "Một số món ăn không đủ số lượng tồn kho" });
    }

    const orderItems = normalizedItems.map(item => {
      const food = foodMap.get(item.foodId);
      const price = Number(food.price);

      return {
        foodId: item.foodId,
        foodName: food.name,
        price,
        quantity: item.quantity,
        subtotal: price * item.quantity
      };
    });
    const totalPrice = orderItems.reduce((sum, item) => sum + item.subtotal, 0);
    const paymentStatus = normalizedPaymentMethod === "qr" ? "pending" : "unpaid";
    const orderStatus = normalizedPaymentMethod === "qr" ? "pending_payment" : "pending";

    await connection.beginTransaction();

    const [orderResult] = await connection.query(
      `INSERT INTO orders
        (user_id, customer_name, phone, address, note, total_price, payment_method, payment_status, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        customerName.trim(),
        customerPhone.trim(),
        customerAddress.trim(),
        customerNote.trim(),
        totalPrice,
        normalizedPaymentMethod,
        paymentStatus,
        orderStatus
      ]
    );

    const orderId = orderResult.insertId;
    let paymentSession = null;
    const detailValues = orderItems.map(item => [
      orderId,
      item.foodId,
      item.foodName,
      item.price,
      item.quantity,
      item.subtotal
    ]);

    await connection.query(
      `INSERT INTO order_details
        (order_id, food_id, food_name, price, quantity, subtotal)
       VALUES ?`,
      [detailValues]
    );

    for (const [foodId, quantity] of Object.entries(demandByFoodId)) {
      const [stockResult] = await connection.query(
        `UPDATE foods
         SET stock_quantity = stock_quantity - ?
         WHERE id = ? AND stock_quantity >= ?`,
        [quantity, Number(foodId), quantity]
      );

      if (stockResult.affectedRows === 0) {
        throw new Error("Inventory update failed");
      }
    }

    if (normalizedPaymentMethod === "qr") {
      const transferContent = buildTransferContent(orderId);
      const qrUrl = buildVietQrUrl({
        ...bankConfig,
        amount: totalPrice,
        transferContent
      });
      const [sessionResult] = await connection.query(
        `INSERT INTO payment_sessions
          (order_id, user_id, method, amount, bank_code, bank_account_no, bank_account_name, transfer_content, qr_url, status, expires_at)
         VALUES (?, ?, 'qr', ?, ?, ?, ?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
        [
          orderId,
          req.user.id,
          totalPrice,
          bankConfig.bankCode,
          bankConfig.accountNo,
          bankConfig.accountName,
          transferContent,
          qrUrl,
          QR_PAYMENT_TTL_MINUTES
        ]
      );

      paymentSession = {
        id: sessionResult.insertId,
        method: "qr",
        amount: totalPrice,
        bankCode: bankConfig.bankCode,
        bankAccountNo: bankConfig.accountNo,
        bankAccountName: bankConfig.accountName,
        transferContent,
        qrUrl,
        status: "pending",
        expiresInSeconds: QR_PAYMENT_TTL_MINUTES * 60
      };
    }

    await connection.commit();

    res.status(201).json({
      message: normalizedPaymentMethod === "qr" ? "Đã tạo giao dich thanh toan QR" : "Đặt hàng thành công",
      order: {
        id: orderId,
        status: orderStatus,
        paymentMethod: normalizedPaymentMethod,
        paymentStatus,
        totalPrice,
        items: orderItems,
        paymentSession
      }
    });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    const status = error.status || (error.message === "Inventory update failed" ? 400 : 500);
    res.status(status).json({
      message: error.message === "Inventory update failed"
        ? "Một số món ăn không đủ số lượng tồn kho"
        : error.message || "Lỗi server"
    });
  } finally {
    connection.release();
  }
});

router.post("/:id/payment/cancel", requireAuth, async (req, res) => {
  const connection = await db.getConnection();

  try {
    const orderId = Number(req.params.id);

    if (!isPositiveInteger(orderId)) {
      return res.status(400).json({ message: "Ma đơn hàng không hợp lệ" });
    }

    await connection.beginTransaction();

    const [orders] = await connection.query(
      `SELECT id, status, payment_status
       FROM orders
       WHERE id = ? AND user_id = ? AND payment_method = 'qr'
       LIMIT 1
       FOR UPDATE`,
      [orderId, req.user.id]
    );

    if (orders.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Không tìm thấy giao dich QR" });
    }

    const order = orders[0];

    if (order.payment_status === "paid") {
      await connection.rollback();
      return res.status(400).json({ message: "Đơn hàng da thanh toan, không thể huy" });
    }

    if (order.status === "cancelled") {
      await connection.rollback();
      return res.json({ message: "Giao dich đã được huy truoc do" });
    }

    const [items] = await connection.query(
      "SELECT food_id, quantity FROM order_details WHERE order_id = ?",
      [orderId]
    );

    for (const item of items) {
      await connection.query(
        "UPDATE foods SET stock_quantity = stock_quantity + ? WHERE id = ?",
        [item.quantity, item.food_id]
      );
    }

    await connection.query(
      "UPDATE orders SET status = 'cancelled', payment_status = 'cancelled' WHERE id = ?",
      [orderId]
    );
    await connection.query(
      "UPDATE payment_sessions SET status = 'cancelled', cancelled_at = NOW() WHERE order_id = ? AND status = 'pending'",
      [orderId]
    );

    await connection.commit();
    res.json({ message: "Đã hủy giao dich thanh toan QR" });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  } finally {
    connection.release();
  }
});

router.get("/:id/payment/status", requireAuth, async (req, res) => {
  try {
    const orderId = Number(req.params.id);

    if (!isPositiveInteger(orderId)) {
      return res.status(400).json({ message: "Ma don hang khong hop le" });
    }

    const [orders] = await db.query(
      `SELECT orders.id, orders.status, orders.payment_status,
              payment_sessions.status AS session_status, payment_sessions.paid_at
       FROM orders
       LEFT JOIN payment_sessions ON payment_sessions.order_id = orders.id
       WHERE orders.id = ? AND orders.user_id = ? AND orders.payment_method = 'qr'
       LIMIT 1`,
      [orderId, req.user.id]
    );

    if (orders.length === 0) {
      return res.status(404).json({ message: "Khong tim thay giao dich QR" });
    }

    const order = orders[0];

    res.json({
      orderId: order.id,
      orderStatus: order.status,
      paymentStatus: order.payment_status,
      sessionStatus: order.session_status,
      paidAt: order.paid_at
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const { q = "", date = "", month = "", year = "" } = req.query;
    const conditions = ["user_id = ?"];
    const params = [req.user.id];

    if (q) {
      conditions.push("(id = ? OR customer_name LIKE ? OR phone LIKE ? OR address LIKE ?)");
      params.push(Number(q) || 0, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    if (date) {
      conditions.push("DATE(created_at) = ?");
      params.push(date);
    }

    if (month) {
      conditions.push("MONTH(created_at) = ?");
      params.push(Number(month));
    }

    if (year) {
      conditions.push("YEAR(created_at) = ?");
      params.push(Number(year));
    }

    const [orders] = await db.query(
      `SELECT id, customer_name, phone, address, note, total_price, payment_method, payment_status, status, created_at
       FROM orders
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC`,
      params
    );

    const itemsByOrder = await getItemsByOrderIds(orders.map(order => order.id));

    res.json(orders.map(order => ({
      ...order,
      items: itemsByOrder[order.id] || []
    })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const orderId = Number(req.params.id);

    if (!isPositiveInteger(orderId)) {
      return res.status(400).json({ message: "Ma đơn hàng không hợp lệ" });
    }

    const [orders] = await db.query(
      `SELECT id, customer_name, phone, address, note, total_price, payment_method, payment_status, status, created_at
       FROM orders
       WHERE id = ? AND user_id = ?`,
      [orderId, req.user.id]
    );

    if (orders.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy đơn hàng" });
    }

    const [items] = await db.query(
      `SELECT id, food_id, food_name, price, quantity, subtotal
       FROM order_details
       WHERE order_id = ?
       ORDER BY id ASC`,
      [orderId]
    );

    res.json({
      ...orders[0],
      items
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

module.exports = router;
