const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

function normalizeFavoriteFoodId(value) {
    const foodId = Number(value);
    return Number.isInteger(foodId) && foodId > 0 ? foodId : null;
}

router.get("/favorites", requireAuth, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT user_favorite_foods.food_id AS foodId
             FROM user_favorite_foods
             JOIN foods ON foods.id = user_favorite_foods.food_id
             WHERE user_favorite_foods.user_id = ?
               AND foods.is_active = 1
             ORDER BY user_favorite_foods.created_at DESC`,
            [req.user.id]
        );

        res.json({
            favorites: rows.map(row => Number(row.foodId))
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Không thể tải món yêu thích" });
    }
});

router.get("/favorites/detail", requireAuth, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT foods.id,
                    foods.name,
                    foods.price,
                    foods.stock_quantity AS stockQuantity,
                    foods.description AS \`desc\`,
                    foods.image,
                    categories.name AS categoryName,
                    categories.slug AS category,
                    parent_categories.name AS parentCategoryName,
                    parent_categories.slug AS parentCategory,
                    COALESCE(sold_stats.sold_count, 0) AS soldCount,
                    COALESCE(review_stats.rating, 0) AS rating,
                    COALESCE(review_stats.review_count, 0) AS reviewCount,
                    user_favorite_foods.created_at AS favoritedAt
             FROM user_favorite_foods
             JOIN foods ON foods.id = user_favorite_foods.food_id
             LEFT JOIN categories ON categories.id = foods.category_id
             LEFT JOIN categories AS parent_categories ON parent_categories.id = categories.parent_id
             LEFT JOIN (
                 SELECT order_details.food_id, COALESCE(SUM(order_details.quantity), 0) AS sold_count
                 FROM order_details
                 JOIN orders ON orders.id = order_details.order_id
                 WHERE orders.status = 'done'
                 GROUP BY order_details.food_id
             ) sold_stats ON sold_stats.food_id = foods.id
             LEFT JOIN (
                 SELECT food_id, ROUND(AVG(rating), 1) AS rating, COUNT(*) AS review_count
                 FROM food_reviews
                 WHERE is_visible = 1
                 GROUP BY food_id
             ) review_stats ON review_stats.food_id = foods.id
             WHERE user_favorite_foods.user_id = ?
               AND foods.is_active = 1
               AND (categories.id IS NULL OR categories.is_active = 1)
               AND (parent_categories.id IS NULL OR parent_categories.is_active = 1)
             ORDER BY user_favorite_foods.created_at DESC`,
            [req.user.id]
        );

        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Không thể tải chi tiết món yêu thích" });
    }
});

router.post("/favorites/:foodId", requireAuth, async (req, res) => {
    try {
        const foodId = normalizeFavoriteFoodId(req.params.foodId);
        if (!foodId) {
            return res.status(400).json({ message: "Mã món ăn không hợp lệ" });
        }

        const [foods] = await db.query(
            "SELECT id FROM foods WHERE id = ? AND is_active = 1 LIMIT 1",
            [foodId]
        );

        if (foods.length === 0) {
            return res.status(404).json({ message: "Không tìm thấy món ăn" });
        }

        await db.query(
            `INSERT IGNORE INTO user_favorite_foods (user_id, food_id)
             VALUES (?, ?)`,
            [req.user.id, foodId]
        );

        res.status(201).json({ message: "Đã thêm vào món yêu thích", foodId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Không thể lưu món yêu thích" });
    }
});

router.delete("/favorites/:foodId", requireAuth, async (req, res) => {
    try {
        const foodId = normalizeFavoriteFoodId(req.params.foodId);
        if (!foodId) {
            return res.status(400).json({ message: "Mã món ăn không hợp lệ" });
        }

        await db.query(
            "DELETE FROM user_favorite_foods WHERE user_id = ? AND food_id = ?",
            [req.user.id, foodId]
        );

        res.json({ message: "Đã xóa khỏi món yêu thích", foodId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Không thể xóa món yêu thích" });
    }
});

router.get("/", async (req, res) => {
    // GET /api/foods
    // Trả danh sách món đang bán cho menu/detail/chatbot, kèm danh mục, tồn kho, số đã bán và điểm đánh giá.
    // Query ưu tiên schema danh mục mới; nếu môi trường cũ thiếu cột thì fallback để frontend vẫn tải được món.
    try {
        let foods;

        try {
            [foods] = await db.query(
                `SELECT foods.id,
                       foods.name,
                       foods.category_id,
                       foods.price,
                       foods.stock_quantity,
                       foods.description,
                       foods.image,
                       foods.is_active,
                       foods.created_at,
                       categories.name AS category_name,
                       categories.slug AS category_slug,
                       categories.type AS category_type,
                       categories.parent_id AS parent_category_id,
                       parent_categories.name AS parent_category_name,
                       parent_categories.slug AS parent_category_slug,
                       COALESCE(sales.total_sold, 0) AS sold_count,
                       COALESCE(reviews.review_count, 0) AS review_count,
                       COALESCE(reviews.average_rating, 0) AS rating
                 FROM foods
                 LEFT JOIN categories ON categories.id = foods.category_id
                 LEFT JOIN categories AS parent_categories ON parent_categories.id = categories.parent_id
                 LEFT JOIN (
                    SELECT order_details.food_id, SUM(order_details.quantity) AS total_sold
                    FROM order_details
                    JOIN orders ON orders.id = order_details.order_id
                    WHERE orders.status = 'done'
                    GROUP BY order_details.food_id
                 ) sales ON sales.food_id = foods.id
                 LEFT JOIN (
                    SELECT food_id, COUNT(*) AS review_count, AVG(rating) AS average_rating
                    FROM food_reviews
                    WHERE is_visible = 1
                    GROUP BY food_id
                 ) reviews ON reviews.food_id = foods.id
                 WHERE foods.is_active = 1
                   AND (categories.id IS NULL OR categories.is_active = 1)
                   AND (parent_categories.id IS NULL OR parent_categories.is_active = 1)
                 ORDER BY COALESCE(parent_categories.sort_order, categories.sort_order) ASC,
                          categories.parent_id IS NOT NULL ASC,
                          categories.sort_order ASC,
                          foods.created_at DESC,
                          foods.id DESC`
            );
        } catch (error) {
            [foods] = await db.query(
                `SELECT foods.id,
                       foods.name,
                       foods.category_id,
                       foods.price,
                       foods.stock_quantity,
                       foods.description,
                       foods.image,
                       foods.is_active,
                       foods.created_at,
                       categories.name AS category_name,
                       COALESCE(sales.total_sold, 0) AS sold_count,
                       COALESCE(reviews.review_count, 0) AS review_count,
                       COALESCE(reviews.average_rating, 0) AS rating
                 FROM foods
                 LEFT JOIN categories ON categories.id = foods.category_id
                 LEFT JOIN (
                    SELECT order_details.food_id, SUM(order_details.quantity) AS total_sold
                    FROM order_details
                    JOIN orders ON orders.id = order_details.order_id
                    WHERE orders.status = 'done'
                    GROUP BY order_details.food_id
                 ) sales ON sales.food_id = foods.id
                 LEFT JOIN (
                    SELECT food_id, COUNT(*) AS review_count, AVG(rating) AS average_rating
                    FROM food_reviews
                    WHERE is_visible = 1
                    GROUP BY food_id
                 ) reviews ON reviews.food_id = foods.id
                 WHERE foods.is_active = 1
                 ORDER BY foods.created_at DESC, foods.id DESC`
            );
        }

        res.json(foods);
    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: "Database error"
        });
    }
});

router.get("/categories", async (req, res) => {
    // GET /api/foods/categories
    // Trả cây danh mục công khai để frontend dựng menu điều hướng và bộ lọc món ăn/đồ uống.
    try {
        let categories;

        try {
            [categories] = await db.query(
                `SELECT categories.id,
                        categories.name,
                        categories.slug,
                        categories.type,
                        categories.parent_id AS parentId,
                        categories.sort_order AS sortOrder,
                        categories.is_active AS isActive,
                        parent_categories.name AS parentName,
                        parent_categories.slug AS parentSlug
                 FROM categories
                 LEFT JOIN categories AS parent_categories ON parent_categories.id = categories.parent_id
                 WHERE categories.is_active = 1
                   AND (parent_categories.id IS NULL OR parent_categories.is_active = 1)
                 ORDER BY COALESCE(parent_categories.sort_order, categories.sort_order) ASC,
                          categories.parent_id IS NOT NULL ASC,
                          categories.sort_order ASC,
                          categories.name ASC`
            );
        } catch (error) {
            const [oldCategories] = await db.query(
                `SELECT id, name
                 FROM categories
                 ORDER BY id ASC`
            );

            categories = oldCategories.map(category => ({
                ...category,
                slug: null,
                type: Number(category.id) === 4 ? "drink" : "food",
                parentId: null,
                sortOrder: category.id,
                isActive: 1,
                parentName: null,
                parentSlug: null
            }));
        }

        res.json(categories);
    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: "Database error"
        });
    }
});

module.exports = router;
