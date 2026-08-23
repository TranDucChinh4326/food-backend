const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const FEEDBACK_CATEGORIES = ["general", "order", "food", "delivery", "payment", "account"];

function normalizeFeedbackPayload(body) {
  // Chuẩn hóa phản hồi từ frontend trước khi lưu.
  // Input là body form; output là dữ liệu hợp lệ hoặc error để tránh lưu rating/category/content sai.
  const rating = Number(body.rating);
  const category = String(body.category || "general").trim().toLowerCase();
  const title = String(body.title || "").trim();
  const content = String(body.content || "").trim();

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { error: "Vui lòng chọn mức độ hài lòng từ 1 đến 5" };
  }

  if (!FEEDBACK_CATEGORIES.includes(category)) {
    return { error: "Nhóm phản hồi không hợp lệ" };
  }

  if (title.length < 5 || title.length > 150) {
    return { error: "Tiêu đề phản hồi cần từ 5 đến 150 ký tự" };
  }

  if (content.length < 10 || content.length > 2000) {
    return { error: "Nội dung phản hồi cần từ 10 đến 2000 ký tự" };
  }

  return {
    value: {
      rating,
      category,
      title,
      content
    }
  };
}

router.get("/", requireAuth, async (req, res) => {
  // GET /api/feedback
  // Trả danh sách phản hồi của chính user đang đăng nhập, không đọc dữ liệu của tài khoản khác.
  try {
    const [feedback] = await db.query(
      `SELECT id, rating, category, title, content, status, admin_reply, replied_at, created_at, updated_at
       FROM customer_feedback
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json({ feedback });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  // POST /api/feedback
  // Lưu phản hồi khách hàng vào customer_feedback để admin xử lý và trả lời sau.
  try {
    const normalized = normalizeFeedbackPayload(req.body);
    if (normalized.error) {
      return res.status(400).json({ message: normalized.error });
    }

    const { rating, category, title, content } = normalized.value;
    const [result] = await db.query(
      `INSERT INTO customer_feedback (user_id, rating, category, title, content)
       VALUES (?, ?, ?, ?, ?)`,
      [req.user.id, rating, category, title, content]
    );

    res.status(201).json({
      message: "Đã gửi phản hồi. FoodHub sẽ xem xét và phản hồi sớm nhất.",
      feedback: {
        id: result.insertId,
        rating,
        category,
        title,
        content,
        status: "new"
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

module.exports = router;
