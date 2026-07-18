const express = require("express");
const router = express.Router();
const db = require("../db");

router.get("/", async (req, res) => {
    try {
        let foods;

        try {
            [foods] = await db.query(
                `SELECT foods.*,
                        categories.name AS category_name,
                        categories.slug AS category_slug,
                        categories.type AS category_type,
                        categories.parent_id AS parent_category_id,
                        parent_categories.name AS parent_category_name,
                        parent_categories.slug AS parent_category_slug
                 FROM foods
                 LEFT JOIN categories ON categories.id = foods.category_id
                 LEFT JOIN categories AS parent_categories ON parent_categories.id = categories.parent_id
                 WHERE foods.is_active = 1
                 ORDER BY categories.sort_order ASC, foods.created_at DESC, foods.id DESC`
            );
        } catch (error) {
            [foods] = await db.query(
                `SELECT foods.*, categories.name AS category_name
                 FROM foods
                 LEFT JOIN categories ON categories.id = foods.category_id
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

module.exports = router;
