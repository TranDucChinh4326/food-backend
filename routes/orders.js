const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function isPositiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0;
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
      return res.status(400).json({ message: "Mot so mon an khong con kha dung" });
    }

    const foodMap = new Map(foods.map(food => [Number(food.id), food]));
    const outOfStockFood = uniqueFoodIds.find(foodId => {
      const food = foodMap.get(foodId);
      return Number(food.stock_quantity || 0) < Number(demandByFoodId[foodId] || 0);
    });

    if (outOfStockFood) {
      return res.status(400).json({ message: "Mot so mon an khong du so luong ton kho" });
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

    await connection.beginTransaction();

    const [orderResult] = await connection.query(
      `INSERT INTO orders
        (user_id, customer_name, phone, address, note, total_price, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [
        req.user.id,
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
    res.status(error.message === "Inventory update failed" ? 400 : 500).json({
      message: error.message === "Inventory update failed" ? "Mot so mon an khong du so luong ton kho" : "Loi server"
    });
  } finally {
    connection.release();
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
      `SELECT id, customer_name, phone, address, note, total_price, status, created_at
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
    res.status(500).json({ message: "Loi server" });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const orderId = Number(req.params.id);

    if (!isPositiveInteger(orderId)) {
      return res.status(400).json({ message: "Ma don hang khong hop le" });
    }

    const [orders] = await db.query(
      `SELECT id, customer_name, phone, address, note, total_price, status, created_at
       FROM orders
       WHERE id = ? AND user_id = ?`,
      [orderId, req.user.id]
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
