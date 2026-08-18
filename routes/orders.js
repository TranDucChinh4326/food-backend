const express = require("express");
const crypto = require("crypto");
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

function normalizeLocation(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

function calculateShippingFee(subtotal, address) {
  // Tính phí giao hàng từ tổng tiền món và tỉnh/thành trong địa chỉ.
  // Output được cộng vào đơn hàng và truyền tiếp sang logic voucher freeship.
  const amount = Math.max(0, Number(subtotal) || 0);
  if (amount === 0) return 0;

  const city = normalizeLocation(String(address || "").split("|")[0] || address);

  if (city.includes("vinh long")) return 15000;

  const nearProvinces = [
    "can tho",
    "dong thap",
    "tien giang",
    "ben tre",
    "tra vinh",
    "hau giang"
  ];

  if (nearProvinces.some(province => city.includes(province))) return 25000;

  return 35000;
}

async function getActiveShippingMethods(connection = db) {
  const [methods] = await connection.query(
    `SELECT id, name, description, fee, estimated_time, sort_order, is_active
     FROM shipping_methods
     WHERE is_active = 1
     ORDER BY sort_order ASC, fee ASC, id ASC`
  );

  return methods;
}

async function resolveShippingMethod(shippingMethodId, itemsSubtotal, customerAddress, connection = db) {
  const methods = await getActiveShippingMethods(connection);
  const selectedId = Number(shippingMethodId || 0);
  const selected = methods.find(method => Number(method.id) === selectedId) || methods[0] || null;

  if (selected) {
    return {
      id: Number(selected.id),
      name: selected.name,
      fee: Math.max(0, Number(selected.fee || 0)),
      estimatedTime: selected.estimated_time || ""
    };
  }

  return {
    id: null,
    name: "Giao hàng",
    fee: calculateShippingFee(itemsSubtotal, customerAddress),
    estimatedTime: ""
  };
}

function normalizeDiscountCode(value) {
  return String(value || "").trim().toUpperCase();
}

function calculateDiscountAmount(discount, itemsSubtotal, shippingFee) {
  // Tính số tiền giảm từ cấu hình voucher trong Database.
  // Hàm tách giảm trên đơn và giảm phí ship để frontend/backend hiển thị đúng từng phần.
  if (!discount) return { orderDiscount: 0, shippingDiscount: 0 };

  const applyTo = discount.apply_to || "order";
  const type = discount.discount_type;
  const value = Number(discount.discount_value || 0);
  const maxDiscount = discount.max_discount === null || discount.max_discount === undefined
    ? null
    : Number(discount.max_discount);
  const baseAmount = applyTo === "shipping" ? shippingFee : itemsSubtotal;
  let amount = 0;

  if (type === "free_shipping") {
    amount = shippingFee;
  } else if (type === "fixed") {
    amount = value;
  } else if (type === "percent") {
    amount = Math.floor(baseAmount * value / 100);
  }

  if (maxDiscount !== null) amount = Math.min(amount, maxDiscount);
  amount = Math.max(0, Math.min(amount, baseAmount));

  return applyTo === "shipping"
    ? { orderDiscount: 0, shippingDiscount: amount }
    : { orderDiscount: amount, shippingDiscount: 0 };
}

async function findUsableDiscount(code, itemsSubtotal, userId = null) {
  // Kiểm tra mã giảm giá nhập tay còn hiệu lực, còn lượt dùng và đạt giá trị đơn tối thiểu.
  // Nếu userId có giá trị, hàm còn kiểm tra người dùng đã dùng mã này chưa để tránh dùng lặp.
  const normalizedCode = normalizeDiscountCode(code);
  if (!normalizedCode) return null;

  const [discounts] = await db.query(
    `SELECT id, code, name, discount_type, discount_value, apply_to, min_order, max_discount, usage_limit, used_count
     FROM discounts
     WHERE code = ?
       AND is_active = 1
       AND (starts_at IS NULL OR starts_at <= NOW())
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (usage_limit IS NULL OR used_count < usage_limit)
     LIMIT 1`,
    [normalizedCode]
  );

  if (discounts.length === 0) {
    const error = new Error("Ma giam gia khong hop le hoac da het han");
    error.status = 400;
    throw error;
  }

  const discount = discounts[0];
  if (itemsSubtotal < Number(discount.min_order || 0)) {
    const error = new Error(`Don hang can toi thieu ${Number(discount.min_order || 0).toLocaleString("vi-VN")}d de dung ma nay`);
    error.status = 400;
    throw error;
  }

  if (userId) {
    const [usedRows] = await db.query(
      `SELECT id
       FROM orders
       WHERE user_id = ?
         AND discount_code = ?
         AND status <> 'cancelled'
         AND payment_status NOT IN ('failed', 'cancelled')
       LIMIT 1`,
      [userId, discount.code]
    );

    if (usedRows.length > 0) {
      const error = new Error("Tai khoan nay da su dung ma giam gia nay");
      error.status = 400;
      throw error;
    }
  }

  return discount;
}

function mapDiscountRow(row) {
  const claimedCount = Number(row.claimed_count || 0);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    discountType: row.discount_type,
    discountValue: Number(row.discount_value || 0),
    applyTo: row.apply_to || "order",
    minOrder: Number(row.min_order || 0),
    maxDiscount: row.max_discount === null ? null : Number(row.max_discount),
    usageLimit: row.usage_limit === null ? null : Number(row.usage_limit),
    usedCount: Number(row.used_count || 0),
    claimedCount,
    remainingGlobal: row.usage_limit === null ? null : Math.max(0, Number(row.usage_limit) - claimedCount),
    startsAt: row.starts_at,
    expiresAt: row.expires_at
  };
}

async function findOwnedDiscount(userId, userDiscountId, itemsSubtotal, connection = db) {
  const id = Number(userDiscountId);
  if (!isPositiveInteger(id)) return null;

  const [rows] = await connection.query(
    `SELECT user_discounts.id AS user_discount_id, user_discounts.quantity, user_discounts.used_count AS user_used_count,
            discounts.id, discounts.code, discounts.name, discounts.discount_type, discounts.discount_value,
            discounts.apply_to, discounts.min_order, discounts.max_discount, discounts.usage_limit, discounts.used_count
     FROM user_discounts
     JOIN discounts ON discounts.id = user_discounts.discount_id
     WHERE user_discounts.id = ?
       AND user_discounts.user_id = ?
       AND user_discounts.used_count < user_discounts.quantity
       AND discounts.is_active = 1
       AND (discounts.starts_at IS NULL OR discounts.starts_at <= NOW())
       AND (discounts.expires_at IS NULL OR discounts.expires_at > NOW())
       AND (discounts.usage_limit IS NULL OR discounts.used_count < discounts.usage_limit)
     LIMIT 1`,
    [id, userId]
  );

  if (rows.length === 0) {
    const error = new Error("Voucher khong hop le hoac da het luot su dung");
    error.status = 400;
    throw error;
  }

  const discount = rows[0];
  if (itemsSubtotal < Number(discount.min_order || 0)) {
    const error = new Error(`Don hang can toi thieu ${Number(discount.min_order || 0).toLocaleString("vi-VN")}d de dung voucher nay`);
    error.status = 400;
    throw error;
  }

  return discount;
}

async function restoreUsedVoucher(connection, order) {
  if (order.user_discount_id) {
    await connection.query(
      "UPDATE user_discounts SET used_count = GREATEST(used_count - 1, 0) WHERE id = ? AND user_id = ?",
      [order.user_discount_id, order.user_id]
    );
  }

  if (order.discount_code) {
    await connection.query(
      "UPDATE discounts SET used_count = GREATEST(used_count - 1, 0) WHERE code = ?",
      [order.discount_code]
    );
  }
}

function formatVnpayDate(date) {
  const pad = value => String(value).padStart(2, "0");

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function sortObject(input) {
  return Object.keys(input).sort().reduce((result, key) => {
    result[key] = input[key];
    return result;
  }, {});
}

function ensureVnpayConfig() {
  const config = {
    tmnCode: process.env.VNPAY_TMN_CODE || "",
    hashSecret: process.env.VNPAY_HASH_SECRET || "",
    paymentUrl: process.env.VNPAY_PAYMENT_URL || "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
    returnUrl: process.env.VNPAY_RETURN_URL || `${process.env.FRONTEND_URL || "http://localhost:5500"}/track.html`
  };

  if (!config.tmnCode || !config.hashSecret || !config.returnUrl) {
    const error = new Error("Chua cau hinh VNPay");
    error.status = 500;
    throw error;
  }

  return config;
}

function buildVnpayPaymentUrl({ orderId, amount, ip, orderInfo }) {
  const config = ensureVnpayConfig();
  const params = sortObject({
    vnp_Version: "2.1.0",
    vnp_Command: "pay",
    vnp_TmnCode: config.tmnCode,
    vnp_Amount: String(Math.round(Number(amount) * 100)),
    vnp_CurrCode: "VND",
    vnp_TxnRef: String(orderId),
    vnp_OrderInfo: orderInfo,
    vnp_OrderType: "other",
    vnp_Locale: "vn",
    vnp_ReturnUrl: config.returnUrl,
    vnp_IpAddr: ip || "127.0.0.1",
    vnp_CreateDate: formatVnpayDate(new Date())
  });
  const signData = new URLSearchParams(params).toString();
  const secureHash = crypto.createHmac("sha512", config.hashSecret).update(signData).digest("hex");

  return `${config.paymentUrl}?${signData}&vnp_SecureHash=${secureHash}`;
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

router.get("/shipping-methods", async (req, res) => {
  try {
    const methods = await getActiveShippingMethods();
    res.json(methods.map(method => ({
      id: method.id,
      name: method.name,
      description: method.description,
      fee: Number(method.fee || 0),
      estimatedTime: method.estimated_time,
      sortOrder: method.sort_order
    })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Khong the tai hinh thuc giao hang" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  // POST /api/orders
  // Tạo đơn hàng từ giỏ hàng frontend: validate giao hàng, kiểm tồn kho, áp voucher,
  // trừ tồn kho và tạo phiên thanh toán nếu khách chọn QR/VNPay. Các thao tác ghi DB chạy trong transaction.
  const connection = await db.getConnection();

  try {
    const {
      customerName,
      customerPhone,
      customerAddress,
      customerNote = "",
      paymentMethod = "cod",
      shippingMethodId = null,
      discountCode = "",
      userDiscountId = null,
      items
    } = req.body;
    const normalizedPaymentMethod = String(paymentMethod || "cod").toLowerCase();

    if (!customerName || !customerPhone || !customerAddress) {
      return res.status(400).json({ message: "Vui lòng nhập thong tin giao hàng" });
    }

    if (!["cod", "qr", "vnpay", "wallet"].includes(normalizedPaymentMethod)) {
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
      // Gom số lượng theo foodId để kiểm tồn kho chính xác khi payload có nhiều dòng cùng một món.
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
    const itemsSubtotal = orderItems.reduce((sum, item) => sum + item.subtotal, 0);
    const shippingMethod = await resolveShippingMethod(shippingMethodId, itemsSubtotal, customerAddress, connection);
    const shippingFee = shippingMethod.fee;
    const ownedDiscount = userDiscountId ? await findOwnedDiscount(req.user.id, userDiscountId, itemsSubtotal) : null;
    const discount = ownedDiscount || await findUsableDiscount(discountCode, itemsSubtotal, req.user.id);
    const discountAmounts = calculateDiscountAmount(discount, itemsSubtotal, shippingFee);
    const totalDiscount = discountAmounts.orderDiscount + discountAmounts.shippingDiscount;
    const totalPrice = Math.max(0, itemsSubtotal + shippingFee - totalDiscount);
    const needsOnlinePayment = ["qr", "vnpay"].includes(normalizedPaymentMethod);
    const paymentStatus = needsOnlinePayment ? "pending" : "unpaid";
    const orderStatus = needsOnlinePayment ? "pending_payment" : "pending";

    await connection.beginTransaction();

    const [orderResult] = await connection.query(
      `INSERT INTO orders
        (user_id, customer_name, phone, address, note, shipping_fee, shipping_method_id, shipping_method_name, discount_code, discount_amount, user_discount_id, total_price, payment_method, payment_status, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        customerName.trim(),
        customerPhone.trim(),
        customerAddress.trim(),
        customerNote.trim(),
        shippingFee,
        shippingMethod.id,
        shippingMethod.name,
        discount?.code || null,
        totalDiscount,
        ownedDiscount?.user_discount_id || null,
        totalPrice,
        normalizedPaymentMethod,
        paymentStatus,
        orderStatus
      ]
    );

    const orderId = orderResult.insertId;
    if (discount) {
      await connection.query("UPDATE discounts SET used_count = used_count + 1 WHERE id = ?", [discount.id]);
    }
    if (ownedDiscount) {
      const [voucherUpdate] = await connection.query(
        "UPDATE user_discounts SET used_count = used_count + 1 WHERE id = ? AND user_id = ? AND used_count < quantity",
        [ownedDiscount.user_discount_id, req.user.id]
      );
      if (voucherUpdate.affectedRows === 0) {
        const error = new Error("Voucher da het luot su dung");
        error.status = 400;
        throw error;
      }
    }
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

    if (normalizedPaymentMethod === "vnpay") {
      const transferContent = buildTransferContent(orderId);
      const paymentUrl = buildVnpayPaymentUrl({
        orderId,
        amount: totalPrice,
        ip: req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress,
        orderInfo: transferContent
      });
      const [sessionResult] = await connection.query(
        `INSERT INTO payment_sessions
          (order_id, user_id, method, amount, transfer_content, status, expires_at)
         VALUES (?, ?, 'vnpay', ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
        [orderId, req.user.id, totalPrice, transferContent, QR_PAYMENT_TTL_MINUTES]
      );

      paymentSession = {
        id: sessionResult.insertId,
        method: "vnpay",
        amount: totalPrice,
        transferContent,
        status: "pending",
        paymentUrl,
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
        shippingFee,
        shippingMethod,
        discountCode: discount?.code || null,
        userDiscountId: ownedDiscount?.user_discount_id || null,
        discountAmount: totalDiscount,
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

router.get("/vouchers/available", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT discounts.id, discounts.code, discounts.name, discounts.discount_type, discounts.discount_value,
              discounts.apply_to, discounts.min_order, discounts.max_discount, discounts.usage_limit,
              discounts.used_count, discounts.starts_at, discounts.expires_at,
              COALESCE(claim_stats.claimed_count, 0) AS claimed_count,
              COALESCE(user_discounts.quantity - user_discounts.used_count, 0) AS owned_remaining
       FROM discounts
       LEFT JOIN (
         SELECT discount_id, COALESCE(SUM(quantity), 0) AS claimed_count
         FROM user_discounts
         GROUP BY discount_id
       ) claim_stats ON claim_stats.discount_id = discounts.id
       LEFT JOIN user_discounts
         ON user_discounts.discount_id = discounts.id AND user_discounts.user_id = ?
       WHERE discounts.is_active = 1
         AND (discounts.starts_at IS NULL OR discounts.starts_at <= NOW())
         AND (discounts.expires_at IS NULL OR discounts.expires_at > NOW())
         AND (discounts.usage_limit IS NULL OR COALESCE(claim_stats.claimed_count, 0) < discounts.usage_limit)
       ORDER BY discounts.created_at DESC`,
      [req.user.id]
    );

    res.json(rows.map(row => ({
      ...mapDiscountRow(row),
      ownedRemaining: Number(row.owned_remaining || 0)
    })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.get("/vouchers/mine", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT user_discounts.id AS user_discount_id, user_discounts.quantity, user_discounts.used_count AS user_used_count,
              discounts.id, discounts.code, discounts.name, discounts.discount_type, discounts.discount_value,
              discounts.apply_to, discounts.min_order, discounts.max_discount, discounts.usage_limit,
              discounts.used_count, discounts.starts_at, discounts.expires_at
       FROM user_discounts
       JOIN discounts ON discounts.id = user_discounts.discount_id
       WHERE user_discounts.user_id = ?
         AND user_discounts.used_count < user_discounts.quantity
         AND discounts.is_active = 1
         AND (discounts.starts_at IS NULL OR discounts.starts_at <= NOW())
         AND (discounts.expires_at IS NULL OR discounts.expires_at > NOW())
       ORDER BY user_discounts.claimed_at DESC`,
      [req.user.id]
    );

    res.json(rows.map(row => ({
      userDiscountId: row.user_discount_id,
      quantity: Number(row.quantity || 0),
      usedCount: Number(row.user_used_count || 0),
      remaining: Math.max(0, Number(row.quantity || 0) - Number(row.user_used_count || 0)),
      discount: mapDiscountRow(row)
    })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.post("/vouchers/claim", requireAuth, async (req, res) => {
  const connection = await db.getConnection();

  try {
    const discountId = Number(req.body.discountId || 0);
    const code = normalizeDiscountCode(req.body.code);
    const conditions = [
      "is_active = 1",
      "(starts_at IS NULL OR starts_at <= NOW())",
      "(expires_at IS NULL OR expires_at > NOW())"
    ];
    const params = [];

    if (isPositiveInteger(discountId)) {
      conditions.push("id = ?");
      params.push(discountId);
    } else if (code) {
      conditions.push("code = ?");
      params.push(code);
    } else {
      return res.status(400).json({ message: "Thieu thong tin voucher" });
    }

    await connection.beginTransaction();

    const [discounts] = await connection.query(
      `SELECT id, code, name, discount_type, discount_value, apply_to, min_order, max_discount, usage_limit, used_count
       FROM discounts
       WHERE ${conditions.join(" AND ")}
       LIMIT 1
       FOR UPDATE`,
      params
    );

    if (discounts.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Voucher khong kha dung hoac da het han" });
    }

    const discount = discounts[0];
    const [ownedRows] = await connection.query(
      "SELECT id FROM user_discounts WHERE user_id = ? AND discount_id = ? LIMIT 1",
      [req.user.id, discount.id]
    );

    if (ownedRows.length > 0) {
      await connection.rollback();
      return res.status(200).json({
        message: "Voucher da co trong vi",
        discount: mapDiscountRow(discount)
      });
    }

    if (discount.usage_limit !== null) {
      const [claimStats] = await connection.query(
        "SELECT COALESCE(SUM(quantity), 0) AS claimed_count FROM user_discounts WHERE discount_id = ?",
        [discount.id]
      );
      if (Number(claimStats[0]?.claimed_count || 0) >= Number(discount.usage_limit)) {
        await connection.rollback();
        return res.status(400).json({ message: "Voucher da het so luong phat hanh" });
      }
    }

    await connection.query(
      `INSERT IGNORE INTO user_discounts (user_id, discount_id, quantity)
       VALUES (?, ?, 1)`,
      [req.user.id, discount.id]
    );

    await connection.commit();

    res.status(201).json({
      message: "Da nhan voucher",
      discount: mapDiscountRow(discount)
    });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  } finally {
    connection.release();
  }
});

router.post("/:id/payment/cancel", requireAuth, async (req, res) => {
  // POST /api/orders/:id/payment/cancel
  // Chỉ chính chủ đơn QR chưa thanh toán mới được hủy; khi hủy sẽ hoàn tồn kho và trả lại lượt voucher.
  const connection = await db.getConnection();

  try {
    const orderId = Number(req.params.id);

    if (!isPositiveInteger(orderId)) {
      return res.status(400).json({ message: "Ma đơn hàng không hợp lệ" });
    }

    await connection.beginTransaction();

    const [orders] = await connection.query(
      `SELECT id, user_id, status, payment_status, discount_code, user_discount_id
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
    await restoreUsedVoucher(connection, order);

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

router.post("/discount/preview", requireAuth, async (req, res) => {
  // POST /api/orders/discount/preview
  // Frontend gọi để tính thử voucher trên tiền món/phí ship trước khi tạo đơn thật.
  try {
    const itemsSubtotal = Math.max(0, Number(req.body.itemsSubtotal || 0));
    const shippingMethod = req.body.shippingMethodId
      ? await resolveShippingMethod(req.body.shippingMethodId, itemsSubtotal, "")
      : null;
    const shippingFee = shippingMethod ? shippingMethod.fee : Math.max(0, Number(req.body.shippingFee || 0));
    const discount = req.body.userDiscountId
      ? await findOwnedDiscount(req.user.id, req.body.userDiscountId, itemsSubtotal)
      : await findUsableDiscount(req.body.discountCode, itemsSubtotal, req.user.id);
    const discountAmounts = calculateDiscountAmount(discount, itemsSubtotal, shippingFee);
    const totalDiscount = discountAmounts.orderDiscount + discountAmounts.shippingDiscount;

    res.json({
      code: discount.code,
      name: discount.name,
      userDiscountId: discount.user_discount_id || null,
      applyTo: discount.apply_to || "order",
      discountAmount: totalDiscount,
      orderDiscount: discountAmounts.orderDiscount,
      shippingDiscount: discountAmounts.shippingDiscount
    });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || "Loi server" });
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
      `SELECT id, customer_name, phone, address, note, shipping_fee, shipping_method_id, shipping_method_name, discount_code, discount_amount, total_price, payment_method, payment_status, status, created_at
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
      `SELECT id, customer_name, phone, address, note, shipping_fee, shipping_method_id, shipping_method_name, discount_code, discount_amount, total_price, payment_method, payment_status, status, created_at
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
