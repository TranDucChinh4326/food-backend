const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function normalizeRating(value) {
  const rating = Number(value);
  return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
}

function normalizeComment(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function mapReview(row) {
  return {
    id: row.id,
    foodId: row.food_id,
    orderId: row.order_id,
    foodName: row.food_name,
    foodImage: row.food_image,
    categoryName: row.category_name,
    userId: row.user_id,
    customerName: row.customer_name,
    avatar: row.avatar,
    rating: Number(row.rating),
    comment: row.comment,
    createdAt: row.created_at
  };
}

router.get("/", async (req, res) => {
  try {
    const foodId = Number(req.query.foodId || 0);
    const rating = normalizeRating(req.query.rating);
    const limit = Math.max(1, Math.min(40, Number(req.query.limit || 12)));
    const conditions = ["food_reviews.is_visible = 1", "foods.is_active = 1"];
    const params = [];

    if (foodId > 0) {
      conditions.push("food_reviews.food_id = ?");
      params.push(foodId);
    }

    if (rating) {
      conditions.push("food_reviews.rating = ?");
      params.push(rating);
    }

    params.push(limit);

    const [reviews] = await db.query(
      `SELECT food_reviews.id,
              food_reviews.food_id,
              food_reviews.order_id,
              food_reviews.user_id,
              food_reviews.rating,
              food_reviews.comment,
              food_reviews.created_at,
              foods.name AS food_name,
              foods.image AS food_image,
              categories.name AS category_name,
              COALESCE(users.fullname, users.username, users.email, 'Khách hàng') AS customer_name,
              users.avatar
       FROM food_reviews
       JOIN foods ON foods.id = food_reviews.food_id
       LEFT JOIN categories ON categories.id = foods.category_id
       JOIN users ON users.id = food_reviews.user_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY food_reviews.created_at DESC, food_reviews.id DESC
       LIMIT ?`,
      params
    );

    res.json(reviews.map(mapReview));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tải đánh giá món ăn" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const foodId = Number(req.body.foodId);
    const orderId = Number(req.body.orderId);
    const rating = normalizeRating(req.body.rating);
    const comment = normalizeComment(req.body.comment);

    if (!Number.isInteger(foodId) || foodId <= 0 || !Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: "Thông tin đánh giá không hợp lệ" });
    }

    if (!rating) {
      return res.status(400).json({ message: "Số sao phải từ 1 đến 5" });
    }

    if (comment.length > 1000) {
      return res.status(400).json({ message: "Nội dung đánh giá không được quá 1000 ký tự" });
    }

    const [eligibleItems] = await db.query(
      `SELECT orders.id AS order_id, orders.status, order_details.food_id
       FROM orders
       JOIN order_details ON order_details.order_id = orders.id
       WHERE orders.id = ?
         AND orders.user_id = ?
         AND order_details.food_id = ?
       LIMIT 1`,
      [orderId, req.user.id, foodId]
    );

    if (eligibleItems.length === 0) {
      return res.status(403).json({ message: "Bạn chỉ có thể đánh giá món đã mua" });
    }

    if (eligibleItems[0].status !== "done") {
      return res.status(403).json({ message: "Chỉ có thể đánh giá sau khi đơn hàng hoàn tất" });
    }

    try {
      const [result] = await db.query(
        `INSERT INTO food_reviews (food_id, user_id, order_id, rating, comment)
         VALUES (?, ?, ?, ?, ?)`,
        [foodId, req.user.id, orderId, rating, comment]
      );

      const [reviews] = await db.query(
        `SELECT food_reviews.id,
                food_reviews.food_id,
                food_reviews.order_id,
                food_reviews.user_id,
                food_reviews.rating,
                food_reviews.comment,
                food_reviews.created_at,
                foods.name AS food_name,
                foods.image AS food_image,
                categories.name AS category_name,
                COALESCE(users.fullname, users.username, users.email, 'Khách hàng') AS customer_name,
                users.avatar
         FROM food_reviews
         JOIN foods ON foods.id = food_reviews.food_id
         LEFT JOIN categories ON categories.id = foods.category_id
         JOIN users ON users.id = food_reviews.user_id
         WHERE food_reviews.id = ?`,
        [result.insertId]
      );

      return res.status(201).json({
        message: "Đánh giá món ăn thành công",
        review: mapReview(reviews[0])
      });
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ message: "Bạn đã đánh giá món này trong đơn hàng này rồi" });
      }

      throw error;
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể lưu đánh giá món ăn" });
  }
});

module.exports = router;
