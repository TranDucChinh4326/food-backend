const express = require("express");
const db = require("../db");

const router = express.Router();

function mapFlashSaleRows(rows) {
  const sales = new Map();

  rows.forEach(row => {
    const saleId = Number(row.flash_sale_id);
    if (!sales.has(saleId)) {
      sales.set(saleId, {
        id: saleId,
        title: row.flash_sale_title,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        items: []
      });
    }

    if (!row.item_id) return;

    const stockLimit = row.stock_limit === null || row.stock_limit === undefined
      ? null
      : Number(row.stock_limit);
    const soldCount = Number(row.sold_count || 0);

    sales.get(saleId).items.push({
      id: Number(row.item_id),
      foodId: Number(row.food_id),
      name: row.food_name,
      image: row.image,
      categoryName: row.category_name,
      originalPrice: Number(row.original_price || 0),
      salePrice: Number(row.sale_price || 0),
      stockLimit,
      soldCount,
      remaining: stockLimit === null ? null : Math.max(0, stockLimit - soldCount),
      perUserLimit: row.per_user_limit === null || row.per_user_limit === undefined
        ? null
        : Number(row.per_user_limit)
    });
  });

  return [...sales.values()];
}

router.get("/active", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT flash_sales.id AS flash_sale_id,
              flash_sales.title AS flash_sale_title,
              DATE_FORMAT(flash_sales.starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at,
              DATE_FORMAT(flash_sales.ends_at, '%Y-%m-%d %H:%i:%s') AS ends_at,
              flash_sale_items.id AS item_id,
              flash_sale_items.food_id,
              flash_sale_items.sale_price,
              flash_sale_items.stock_limit,
              flash_sale_items.sold_count,
              flash_sale_items.per_user_limit,
              foods.name AS food_name,
              foods.price AS original_price,
              foods.image,
              categories.name AS category_name
       FROM flash_sales
       JOIN flash_sale_items
         ON flash_sale_items.flash_sale_id = flash_sales.id
        AND flash_sale_items.is_active = 1
       JOIN foods
         ON foods.id = flash_sale_items.food_id
        AND foods.is_active = 1
       LEFT JOIN categories ON categories.id = foods.category_id
       WHERE flash_sales.is_active = 1
         AND (flash_sales.starts_at IS NULL OR flash_sales.starts_at <= NOW())
         AND (flash_sales.ends_at IS NULL OR flash_sales.ends_at > NOW())
         AND (flash_sale_items.stock_limit IS NULL OR flash_sale_items.sold_count < flash_sale_items.stock_limit)
       ORDER BY flash_sales.ends_at ASC, flash_sales.id DESC, flash_sale_items.sort_order ASC, flash_sale_items.id ASC`
    );

    res.json(mapFlashSaleRows(rows).filter(sale => sale.items.length > 0));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tải flash sale" });
  }
});

module.exports = router;
