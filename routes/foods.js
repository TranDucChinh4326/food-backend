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
                   AND (categories.id IS NULL OR categories.is_active = 1)
                   AND (parent_categories.id IS NULL OR parent_categories.is_active = 1)
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

router.get("/categories", async (req, res) => {
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
                 ORDER BY categories.type ASC, categories.parent_id IS NULL DESC, categories.parent_id ASC, categories.sort_order ASC, categories.name ASC`
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
