const express = require('express');
const slugify = require('slugify');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Público: listar categorías (para menú de la tienda)
router.get('/', (req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
  res.json(categories);
});

// Admin: crear categoría
router.post(
  '/',
  requireAdmin,
  [body('name').trim().isLength({ min: 2, max: 60 })],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Nombre de categoría inválido.' });

    const { name } = req.body;
    const slug = slugify(name, { lower: true, strict: true });

    try {
      const info = db
        .prepare('INSERT INTO categories (name, slug) VALUES (?, ?)')
        .run(name, slug);
      res.status(201).json({ id: info.lastInsertRowid, name, slug });
    } catch (err) {
      res.status(409).json({ error: 'Ya existe una categoría con ese nombre.' });
    }
  }
);

// Admin: eliminar categoría
router.delete('/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
