const express = require("express");
const db = require("../db");
const { optionalAuth } = require("../middleware/auth");

const router = express.Router();
const MAX_MESSAGE_LENGTH = 500;

function formatMoney(value) {
  return `${Number(value || 0).toLocaleString("vi-VN")}đ`;
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeLike(value) {
  return String(value || "").replace(/[\\%_]/g, match => `\\${match}`);
}

function hasIntent(normalized, patterns) {
  return patterns.some(pattern => pattern.test(normalized));
}

function normalizeSessionId(value) {
  const sessionId = String(value || "").trim().slice(0, 120);
  if (/^[a-zA-Z0-9:_-]{8,120}$/.test(sessionId)) return sessionId;
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function ensureChatSession(sessionId, userId) {
  await db.query(
    `INSERT INTO chat_sessions (session_id, user_id)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE
       user_id = COALESCE(user_id, VALUES(user_id)),
       updated_at = CURRENT_TIMESTAMP`,
    [sessionId, userId || null]
  );

  const [sessions] = await db.query(
    "SELECT user_id FROM chat_sessions WHERE session_id = ? LIMIT 1",
    [sessionId]
  );
  const ownerId = sessions[0]?.user_id;
  if (ownerId && Number(ownerId) !== Number(userId || 0)) {
    const error = new Error("Ban khong co quyen su dung phien chat nay.");
    error.status = 403;
    throw error;
  }
}

async function saveChatMessage(sessionId, sender, message) {
  await db.query(
    "INSERT INTO chat_messages (session_id, sender, message) VALUES (?, ?, ?)",
    [sessionId, sender, String(message || "").slice(0, 4000)]
  );
}

function getOrderStatusLabel(status) {
  const labels = {
    pending: "chờ xác nhận",
    confirmed: "đã xác nhận",
    delivering: "đang giao",
    done: "hoàn tất",
    cancelled: "đã hủy",
    pending_payment: "chờ thanh toán"
  };

  return labels[status] || status || "chưa xác định";
}

function getPaymentStatusLabel(status) {
  const labels = {
    unpaid: "chưa thanh toán",
    pending: "chờ thanh toán",
    paid: "đã thanh toán",
    failed: "thanh toán thất bại",
    refunded: "đã hoàn tiền",
    cancelled: "đã hủy"
  };

  return labels[status] || status || "chưa xác định";
}

function formatFoodLine(food, index) {
  const stockText = Number(food.stock_quantity || 0) > 0 ? `còn ${Number(food.stock_quantity || 0)} phần` : "tạm hết hàng";
  const soldText = Number(food.sold_count || 0) > 0 ? `, đã bán ${Number(food.sold_count || 0)}` : "";
  const categoryText = food.category_name ? ` - ${food.category_name}` : "";
  return `${index + 1}. ${food.name}${categoryText}: ${formatMoney(food.price)} (${stockText}${soldText})`;
}

function getKeywords(message) {
  const stopWords = new Set([
    "mon", "an", "do", "gia", "bao", "nhieu", "tien", "co", "khong", "hom", "nay",
    "toi", "tui", "minh", "muon", "can", "hoi", "cho", "xin", "hay", "nao", "nhe",
    "foodhub", "cua", "la", "mot", "cai", "phan", "giup", "lua", "nha"
  ]);

  return slugify(message)
    .split("-")
    .filter(word => word.length >= 2 && !stopWords.has(word));
}

function getTokens(message) {
  return slugify(message).split("-").filter(Boolean);
}

function hasAnyToken(tokens, values) {
  return values.some(value => tokens.includes(value));
}

function getTasteKeywords(tokens) {
  const tasteMap = {
    cay: ["cay"],
    ngot: ["ngot"],
    chua: ["chua"],
    man: ["man"],
    nuoc: ["nuoc", "sup", "canh", "pho", "bun", "mi"]
  };

  const excluded = new Set();
  if (tokens.includes("dung") || tokens.includes("khong")) {
    Object.entries(tasteMap).forEach(([taste, words]) => {
      if (words.some(word => tokens.includes(word))) excluded.add(taste);
    });
  }

  return Object.entries(tasteMap)
    .filter(([taste, words]) => !excluded.has(taste) && words.some(word => tokens.includes(word)))
    .flatMap(([, words]) => words);
}

function getBudget(message) {
  const normalized = slugify(message);
  const rawNumbers = String(message || "").match(/\d+([\.,]\d+)?/g) || [];
  const numbers = rawNumbers
    .map(value => Number(value.replace(",", ".")))
    .filter(value => Number.isFinite(value) && value > 0)
    .map(value => value < 1000 ? value * 1000 : value);

  if (!numbers.length && /re|gia-re|binh-dan|duoi|tam|khoang/.test(normalized)) return 50000;
  return numbers.length ? Math.max(...numbers) : 0;
}

async function findFoods(message, options = {}) {
  const keywords = options.keywords || getKeywords(message);
  const where = ["foods.is_active = 1"];
  const params = [];

  if (options.inStock) {
    where.push("foods.stock_quantity > 0");
  }

  if (options.category) {
    where.push("(categories.slug LIKE ? OR categories.name LIKE ? OR parent_categories.slug LIKE ? OR parent_categories.name LIKE ?)");
    const value = `%${escapeLike(options.category)}%`;
    params.push(value, value, value, value);
  }

  if (options.foodOnly) {
    where.push("COALESCE(parent_categories.type, categories.type, '') <> 'drink'");
  }

  if (keywords.length) {
    if (options.matchTaste) {
      const keywordClauses = keywords.map(() => (
        "(LOWER(foods.name) COLLATE utf8mb4_bin REGEXP ? OR LOWER(COALESCE(foods.description, '')) COLLATE utf8mb4_bin REGEXP ?)"
      ));
      where.push(`(${keywordClauses.join(" OR ")})`);
      keywords.forEach(keyword => {
        const pattern = `(^|[^a-z0-9])${escapeLike(keyword)}([^a-z0-9]|$)`;
        params.push(pattern, pattern);
      });

      if (keywords.includes("cay")) {
        where.push("LOWER(COALESCE(foods.description, '')) COLLATE utf8mb4_bin NOT REGEXP ?");
        params.push("trai[[:space:]-]*cay");
      }
    } else {
      const keywordClauses = keywords.map(() => (
        "(foods.name LIKE ? OR foods.description LIKE ? OR categories.name LIKE ? OR parent_categories.name LIKE ?)"
      ));
      where.push(`(${keywordClauses.join(" OR ")})`);
      keywords.forEach(keyword => {
        const value = `%${escapeLike(keyword)}%`;
        params.push(value, value, value, value);
      });
    }
  }

  if (options.maxPrice) {
    where.push("foods.price <= ?");
    params.push(options.maxPrice);
  }

  if (options.minPrice) {
    where.push("foods.price >= ?");
    params.push(options.minPrice);
  }

  const orderBy = options.orderBy === "new"
    ? "foods.created_at DESC, foods.id DESC"
    : options.orderBy === "sold"
      ? "sold_count DESC, foods.id DESC"
      : "foods.name ASC";

  const [foods] = await db.query(
    `SELECT foods.id, foods.name, foods.price, foods.description, foods.image, foods.stock_quantity,
            categories.name AS category_name,
            parent_categories.name AS parent_category_name,
            COALESCE(sales.sold_count, 0) AS sold_count
     FROM foods
     LEFT JOIN categories ON categories.id = foods.category_id
     LEFT JOIN categories parent_categories ON parent_categories.id = categories.parent_id
     LEFT JOIN (
       SELECT food_id, COALESCE(SUM(quantity), 0) AS sold_count
       FROM order_details
       GROUP BY food_id
     ) sales ON sales.food_id = foods.id
     WHERE ${where.join(" AND ")}
     ORDER BY ${orderBy}
     LIMIT ?`,
    [...params, Number(options.limit || 5)]
  );

  return foods;
}

async function getActiveDiscounts(limit = 5) {
  const [discounts] = await db.query(
    `SELECT code, name, discount_type, discount_value, apply_to, min_order, max_discount, expires_at
     FROM discounts
     WHERE is_active = 1
       AND (starts_at IS NULL OR starts_at <= NOW())
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (usage_limit IS NULL OR used_count < usage_limit)
     ORDER BY created_at DESC
     LIMIT ?`,
    [limit]
  );

  return discounts;
}

function formatDiscountLine(discount, index) {
  const value = discount.discount_type === "percent"
    ? `${Number(discount.discount_value || 0)}%`
    : discount.discount_type === "free_shipping"
      ? "miễn phí giao hàng"
      : formatMoney(discount.discount_value);
  const minOrder = Number(discount.min_order || 0) > 0 ? ` cho đơn từ ${formatMoney(discount.min_order)}` : "";
  const maxDiscount = discount.max_discount ? `, tối đa ${formatMoney(discount.max_discount)}` : "";
  return `${index + 1}. ${discount.code} - ${discount.name}: ${value}${minOrder}${maxDiscount}`;
}

async function getOrderReply(userId, message) {
  if (!userId) {
    return "Bạn cần đăng nhập để mình kiểm tra trạng thái đơn hàng cá nhân.";
  }

  const orderId = (String(message || "").match(/\b\d{1,10}\b/) || [])[0];
  const params = [userId];
  let condition = "orders.user_id = ?";

  if (orderId) {
    condition += " AND orders.id = ?";
    params.push(Number(orderId));
  }

  const [orders] = await db.query(
    `SELECT id, total_price, status, payment_method, payment_status, created_at
     FROM orders
     WHERE ${condition}
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    params
  );

  if (!orders.length) {
    return orderId
      ? `Mình không tìm thấy đơn #${orderId} trong tài khoản của bạn.`
      : "Tài khoản của bạn chưa có đơn hàng nào để kiểm tra.";
  }

  const order = orders[0];
  return `Đơn #${order.id} hiện ${getOrderStatusLabel(order.status)}, thanh toán ${getPaymentStatusLabel(order.payment_status)}, tổng tiền ${formatMoney(order.total_price)}.`;
}

async function buildReply(message, userId) {
  const normalized = slugify(message);
  const tokens = getTokens(message);
  const tasteKeywords = getTasteKeywords(tokens);

  if (hasIntent(normalized, [/^xin-chao|^chao|hello|hi|alo|tu-van|ho-tro/])) {
    return "Chào bạn, mình có thể hỗ trợ tìm món, hỏi giá, danh mục, món bán chạy, khuyến mãi, giao hàng, phí ship, trạng thái đơn và giỏ hàng.";
  }

  if (hasIntent(normalized, [/trang-thai-don|don-hang|lich-su|theo-doi|kiem-tra-don|track/])) {
    return getOrderReply(userId, message);
  }

  if (hasIntent(normalized, [/cua-hang|dia-chi-shop|hotline|lien-he|mo-cua|dong-cua|gio-lam/])) {
    return "Bạn có thể xem thông tin cửa hàng, hotline và email ở trang Liên hệ của FoodHub.";
  }

  if (hasIntent(normalized, [/thoi-gian-giao|bao-lau|may-phut|khi-nao-giao/])) {
    return "Thời gian giao hàng phụ thuộc địa chỉ và tình trạng đơn. Sau khi đặt, bạn có thể xem tiến trình ở Lịch sử đơn.";
  }

  if (hasIntent(normalized, [/phi-ship|phi-giao|giao-hang|ship|van-chuyen/])) {
    return "Phí giao hàng được tính theo địa chỉ trong giỏ hàng. Voucher freeship hoặc mã giảm giá sẽ được trừ trực tiếp nếu đủ điều kiện.";
  }

  if (hasIntent(normalized, [/gio-hang|them-vao-gio|xoa-mon|so-luong|dat-hang|dat-mon|checkout/])) {
    return "Bạn chọn món trong Thực đơn, bấm thêm vào giỏ, rồi vào Giỏ hàng để đổi số lượng, áp voucher, chọn thanh toán và xác nhận đặt món.";
  }

  if (hasIntent(normalized, [/khuyen-mai|voucher|ma-giam|giam-gia|uu-dai|sale/])) {
    const discounts = await getActiveDiscounts();
    return discounts.length
      ? `Hiện FoodHub đang có các ưu đãi:\n${discounts.map(formatDiscountLine).join("\n")}`
      : "Hiện chưa có khuyến mãi đang hoạt động trong hệ thống.";
  }

  if (tasteKeywords.length) {
    const foods = await findFoods(message, { inStock: true, keywords: tasteKeywords, matchTaste: true, limit: 5 });
    return foods.length
      ? `Mình gợi ý các món hợp khẩu vị bạn hỏi:\n${foods.map(formatFoodLine).join("\n")}`
      : "Mình chưa tìm thấy món phù hợp với khẩu vị đó trong dữ liệu hiện tại.";
  }

  if (hasIntent(normalized, [/ban-chay|best|hot|nhieu-nguoi|pho-bien|mon-ngon|goi-y|an-gi/])) {
    const foodOnly = hasIntent(normalized, [/mon-an|do-an/]) || (tokens.includes("mon") && tokens.includes("an"));
    const topOnly = hasAnyToken(tokens, ["nhat", "top1"]) || normalized.includes("top-1");
    const foods = await findFoods(message, { inStock: true, orderBy: "sold", foodOnly, limit: topOnly ? 1 : 5 });
    return foods.length
      ? `Các món đang bán chạy:\n${foods.map(formatFoodLine).join("\n")}`
      : "Hiện chưa có dữ liệu món bán chạy phù hợp.";
  }

  if (hasIntent(normalized, [/mon-moi|moi|new|vua-them/])) {
    const foods = await findFoods(message, { inStock: true, orderBy: "new", limit: 5 });
    return foods.length
      ? `Các món mới/cập nhật gần đây:\n${foods.map(formatFoodLine).join("\n")}`
      : "Hiện chưa có món mới phù hợp.";
  }

  const budget = getBudget(message);
  if (hasIntent(normalized, [/gia|bao-nhieu|re|duoi|tren|tam|khoang|binh-dan|cao-cap/]) || budget) {
    const foods = await findFoods(message, {
      inStock: true,
      maxPrice: hasIntent(normalized, [/tren|cao-cap/]) ? null : budget || null,
      minPrice: hasIntent(normalized, [/tren|cao-cap/]) ? budget || 50000 : null,
      limit: 5
    });

    if (foods.length === 1 && hasIntent(normalized, [/gia|bao-nhieu|tien/])) {
      return `${foods[0].name} hiện có giá ${formatMoney(foods[0].price)}.`;
    }

    return foods.length
      ? `Mình tìm thấy món phù hợp với mức giá bạn hỏi:\n${foods.map(formatFoodLine).join("\n")}`
      : "Mình chưa tìm thấy món phù hợp với mức giá đó trong dữ liệu hiện tại.";
  }

  if (
    hasIntent(normalized, [/danh-muc|loai-mon|nhom-mon|do-uong|nuoc-ep|do-an/]) ||
    hasAnyToken(tokens, ["nuoc", "tra", "ca", "phe", "sinh", "to", "com", "pho", "bun", "mi", "pizza", "burger", "ga"])
  ) {
    const foods = await findFoods(message, { inStock: true, limit: 5 });
    return foods.length
      ? `Mình tìm thấy các món thuộc nhóm bạn hỏi:\n${foods.map(formatFoodLine).join("\n")}`
      : "Mình chưa tìm thấy món thuộc nhóm đó trong dữ liệu hiện tại.";
  }

  const matchedFoods = await findFoods(message, { inStock: false, limit: 5 });
  if (matchedFoods.length === 1 && hasIntent(normalized, [/gia|bao-nhieu|tien/])) {
    return `${matchedFoods[0].name} hiện có giá ${formatMoney(matchedFoods[0].price)}.`;
  }

  if (matchedFoods.length) {
    return `Mình tìm thấy món phù hợp:\n${matchedFoods.map(formatFoodLine).join("\n")}`;
  }

  return "Xin lỗi, mình chưa hiểu yêu cầu của bạn. Bạn có thể hỏi về món ăn, giá, khuyến mãi hoặc đơn hàng nhé.";
}

router.post("/", optionalAuth, async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    const sessionId = normalizeSessionId(req.body?.sessionId);

    if (!message) {
      return res.status(400).json({ success: false, message: "Vui lòng nhập nội dung cần hỏi." });
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ success: false, message: "Tin nhắn quá dài. Vui lòng nhập ngắn hơn." });
    }

    await ensureChatSession(sessionId, req.user?.id || null);
    await saveChatMessage(sessionId, "user", message);

    const reply = await buildReply(message, req.user?.id || null);
    await saveChatMessage(sessionId, "bot", reply);

    res.json({
      success: true,
      sessionId,
      message: reply
    });
  } catch (error) {
    console.error("Chat API error:", error);
    res.status(500).json({
      success: false,
      message: "Xin lỗi, hệ thống chat đang gặp lỗi. Bạn thử lại sau nhé."
    });
  }
});

router.get("/:sessionId/messages", optionalAuth, async (req, res) => {
  try {
    const sessionId = normalizeSessionId(req.params.sessionId);
    const [sessions] = await db.query(
      "SELECT session_id, user_id FROM chat_sessions WHERE session_id = ? LIMIT 1",
      [sessionId]
    );

    if (!sessions.length) {
      return res.json({ success: true, sessionId, messages: [] });
    }

    const session = sessions[0];
    if (session.user_id && (!req.user?.id || Number(session.user_id) !== Number(req.user.id))) {
      return res.status(403).json({ success: false, message: "Ban khong co quyen xem lich su chat nay." });
    }

    const [messages] = await db.query(
      `SELECT message_id AS id, sender, message, created_at AS createdAt
       FROM chat_messages
       WHERE session_id = ?
       ORDER BY created_at ASC, message_id ASC
       LIMIT 50`,
      [sessionId]
    );

    res.json({ success: true, sessionId, messages });
  } catch (error) {
    console.error("Chat history API error:", error);
    res.status(500).json({
      success: false,
      message: "Khong the tai lich su chat."
    });
  }
});

module.exports = router;
