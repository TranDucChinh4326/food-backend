const express = require("express");
const db = require("../db");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

router.use(requireAdmin);

router.get("/orders", async (req, res) => {
  try {
    const [orders] = await db.query(
      `SELECT id, customer_name, phone, address, note, total_price, status, created_at
       FROM orders
       ORDER BY created_at DESC`
    );

    if (orders.length === 0) {
      return res.json([]);
    }

    const orderIds = orders.map(order => order.id);
    const placeholders = orderIds.map(() => "?").join(",");
    const [items] = await db.query(
      `SELECT order_id, food_id, food_name, price, quantity, subtotal
       FROM order_details
       WHERE order_id IN (${placeholders})
       ORDER BY id ASC`,
      orderIds
    );

    const itemsByOrder = items.reduce((map, item) => {
      if (!map[item.order_id]) {
        map[item.order_id] = [];
      }

      map[item.order_id].push(item);
      return map;
    }, {});

    res.json(orders.map(order => ({
      ...order,
      items: itemsByOrder[order.id] || []
    })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.patch("/orders/:id/status", async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const { status } = req.body;
    const allowedStatuses = ["pending", "confirmed", "delivering", "done", "cancelled"];

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: "Ma don hang khong hop le" });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: "Trang thai khong hop le" });
    }

    const [result] = await db.query(
      "UPDATE orders SET status = ? WHERE id = ?",
      [status, orderId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Khong tim thay don hang" });
    }

    res.json({ message: "Cap nhat trang thai thanh cong" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.get("/foods", async (req, res) => {
  try {
    const [foods] = await db.query(
      `SELECT foods.*, categories.name AS category_name
       FROM foods
       LEFT JOIN categories ON categories.id = foods.category_id
       ORDER BY foods.created_at DESC, foods.id DESC`
    );

    res.json(foods);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.post("/foods", async (req, res) => {
  try {
    const { name, categoryId, price, description = "", image = "", isActive = 1 } = req.body;

    if (!name || !categoryId || !price) {
      return res.status(400).json({ message: "Vui long nhap ten mon, danh muc va gia" });
    }

    const [result] = await db.query(
      `INSERT INTO foods (name, category_id, price, description, image, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name.trim(), Number(categoryId), Number(price), description.trim(), image.trim(), Number(isActive)]
    );

    res.status(201).json({ message: "Them mon thanh cong", id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.put("/foods/:id", async (req, res) => {
  try {
    const foodId = Number(req.params.id);
    const { name, categoryId, price, description = "", image = "", isActive = 1 } = req.body;

    if (!Number.isInteger(foodId) || foodId <= 0) {
      return res.status(400).json({ message: "Ma mon khong hop le" });
    }

    if (!name || !categoryId || !price) {
      return res.status(400).json({ message: "Vui long nhap ten mon, danh muc va gia" });
    }

    const [result] = await db.query(
      `UPDATE foods
       SET name = ?, category_id = ?, price = ?, description = ?, image = ?, is_active = ?
       WHERE id = ?`,
      [
        name.trim(),
        Number(categoryId),
        Number(price),
        description.trim(),
        image.trim(),
        Number(isActive),
        foodId
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Khong tim thay mon an" });
    }

    res.json({ message: "Cap nhat mon thanh cong" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.delete("/foods/:id", async (req, res) => {
  try {
    const foodId = Number(req.params.id);

    if (!Number.isInteger(foodId) || foodId <= 0) {
      return res.status(400).json({ message: "Ma mon khong hop le" });
    }

    const [result] = await db.query(
      "UPDATE foods SET is_active = 0 WHERE id = ?",
      [foodId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Khong tim thay mon an" });
    }

    res.json({ message: "Da an mon khoi menu" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

module.exports = router;
