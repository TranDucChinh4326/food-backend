const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function isPositiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

router.post("/", requireAuth, async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      customerName,
      customerPhone,
      customerAddress,
      customerNote = "",
      items
    } = req.body;

    if (!customerName || !customerPhone || !customerAddress) {
      return res.status(400).json({ message: "Vui long nhap thong tin giao hang" });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Gio hang dang trong" });
    }

    const normalizedItems = items.map(item => ({
      foodId: Number(item.foodId || item.id),
      quantity: Number(item.quantity)
    }));

    const hasInvalidItem = normalizedItems.some(
      item => !isPositiveInteger(item.foodId) || !isPositiveInteger(item.quantity)
    );

    if (hasInvalidItem) {
      return res.status(400).json({ message: "Gio hang khong hop le" });
    }

    const foodIds = normalizedItems.map(item => item.foodId);
    const uniqueFoodIds = [...new Set(foodIds)];
    const placeholders = uniqueFoodIds.map(() => "?").join(",");
    const [foods] = await connection.query(
      `SELECT id, name, price FROM foods WHERE is_active = 1 AND id IN (${placeholders})`,
      uniqueFoodIds
    );

    if (foods.length !== uniqueFoodIds.length) {
      return res.status(400).json({ message: "Mot so mon an khong con kha dung" });
    }

    const foodMap = new Map(foods.map(food => [Number(food.id), food]));
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

    await connection.beginTransaction();

    const [orderResult] = await connection.query(
      `INSERT INTO orders
        (customer_name, phone, address, note, total_price, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [
        customerName.trim(),
        customerPhone.trim(),
        customerAddress.trim(),
        customerNote.trim(),
        totalPrice
      ]
    );

    const orderId = orderResult.insertId;
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

    await connection.commit();

    res.status(201).json({
      message: "Dat hang thanh cong",
      order: {
        id: orderId,
        status: "pending",
        totalPrice,
        items: orderItems
      }
    });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  } finally {
    connection.release();
  }
});

router.get("/:id", async (req, res) => {
  try {
    const orderId = Number(req.params.id);

    if (!isPositiveInteger(orderId)) {
      return res.status(400).json({ message: "Ma don hang khong hop le" });
    }

    const [orders] = await db.query(
      `SELECT id, customer_name, phone, address, note, total_price, status, created_at
       FROM orders
       WHERE id = ?`,
      [orderId]
    );

    if (orders.length === 0) {
      return res.status(404).json({ message: "Khong tim thay don hang" });
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
    res.status(500).json({ message: "Loi server" });
  }
});

module.exports = router;
