const express = require("express");
const router = express.Router();
const db = require("../db");

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
