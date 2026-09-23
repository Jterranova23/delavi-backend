const express = require('express');
const slugify = require('slugify');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { body, query, validationResult } = require('express-validator');
const db = require('../config/db');
const { requireAdmin } = require('../middleware/auth');
const { upload, UPLOAD_DIR } = require('../middleware/upload');

const router = express.Router();

function attachImages(product) {
  const images = db
    .prepare('SELECT id, url, position FROM product_images WHERE product_id = ? ORDER BY position')
    .all(product.id);
  // images: [{ id, url, position }] — se conserva el id para poder borrar una imagen puntual.
  return { ...product, images };
}

// ---------------------------------------------------------------------------
// PÚBLICO: catálogo de la tienda (solo productos "active")
// ---------------------------------------------------------------------------
router.get(
  '/',
  [
    query('category').optional().isString(),
    query('search').optional().isString().isLength({ max: 100 }),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 60 }).toInt()
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Parámetros de búsqueda inválidos.' });

    const page = req.query.page || 1;
    const limit = req.query.limit || 24;
    const offset = (page - 1) * limit;

    let sql = `
      SELECT p.*, c.name AS category_name, c.slug AS category_slug
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.status = 'active'
    `;
    const params = [];

    if (req.query.category) {
      sql += ' AND c.slug = ?';
      params.push(req.query.category);
    }
    if (req.query.search) {
      sql += ' AND p.name LIKE ?';
      params.push(`%${req.query.search}%`);
    }

    sql += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const products = db.prepare(sql).all(...params).map(attachImages);
    res.json({ products, page, limit });
  }
);

// PÚBLICO: detalle de un producto por slug
router.get('/:slug', (req, res) => {
  const product = db
    .prepare(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.slug = ? AND p.status = 'active'`
    )
    .get(req.params.slug);

  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
  res.json(attachImages(product));
});

// ---------------------------------------------------------------------------
// ADMIN: listar TODOS los productos (incluye borradores), crear, editar, borrar
// ---------------------------------------------------------------------------
router.get('/admin/all', requireAdmin, (req, res) => {
  const products = db
    .prepare(
      `SELECT p.*, c.name AS category_name FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ORDER BY p.created_at DESC`
    )
    .all()
    .map(attachImages);
  res.json(products);
});

const productValidators = [
  body('name').trim().isLength({ min: 2, max: 150 }),
  body('description').optional().isString().isLength({ max: 5000 }),
  body('price').isFloat({ min: 0.01 }),
  body('compareAtPrice').optional({ nullable: true }).isFloat({ min: 0 }),
  body('stock').isInt({ min: 0 }),
  body('categoryId').optional({ nullable: true }).isInt(),
  body('status').isIn(['draft', 'active', 'archived']),
  body('sku').optional({ nullable: true }).isString().isLength({ max: 60 })
];

router.post('/', requireAdmin, productValidators, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos de producto inválidos.', details: errors.array() });

  const { name, description = '', price, compareAtPrice, stock, categoryId, status, sku } = req.body;
  const slugBase = slugify(name, { lower: true, strict: true });
  let slug = slugBase;
  let n = 1;
  while (db.prepare('SELECT 1 FROM products WHERE slug = ?').get(slug)) {
    slug = `${slugBase}-${++n}`;
  }

  const info = db
    .prepare(
      `INSERT INTO products (name, slug, description, price_cents, compare_at_price_cents, stock, sku, category_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      slug,
      description,
      Math.round(price * 100),
      compareAtPrice ? Math.round(compareAtPrice * 100) : null,
      stock,
      sku || null,
      categoryId || null,
      status
    );

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(attachImages(product));
});

router.put('/:id', requireAdmin, productValidators, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos de producto inválidos.', details: errors.array() });

  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Producto no encontrado.' });

  const { name, description = '', price, compareAtPrice, stock, categoryId, status, sku } = req.body;

  db.prepare(
    `UPDATE products SET name=?, description=?, price_cents=?, compare_at_price_cents=?, stock=?, sku=?, category_id=?, status=?, updated_at=datetime('now')
     WHERE id = ?`
  ).run(
    name,
    description,
    Math.round(price * 100),
    compareAtPrice ? Math.round(compareAtPrice * 100) : null,
    stock,
    sku || null,
    categoryId || null,
    status,
    req.params.id
  );

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json(attachImages(product));
});

router.delete('/:id', requireAdmin, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });

  // Borra también los archivos de imagen físicos asociados.
  const images = db.prepare('SELECT url FROM product_images WHERE product_id = ?').all(req.params.id);
  images.forEach((img) => {
    const filePath = path.join(UPLOAD_DIR, path.basename(img.url));
    fs.unlink(filePath, () => {});
  });

  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// ADMIN: subir imágenes de un producto (rápido: varias a la vez, se optimizan)
// ---------------------------------------------------------------------------
router.post('/:id/images', requireAdmin, upload.array('images', 8), async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) {
    (req.files || []).forEach((f) => fs.unlink(f.path, () => {}));
    return res.status(404).json({ error: 'Producto no encontrado.' });
  }

  const savedUrls = [];
  const rejected = [];

  for (const file of req.files || []) {
    // Reescribimos la imagen con sharp: limita dimensiones y recomprime.
    // Esto también elimina metadatos EXIF (ubicación, dispositivo) por privacidad
    // y, sobre todo, es nuestra verdadera validación de seguridad: un archivo
    // renombrado o con un Content-Type falso (ej. un .html o .exe disfrazado de
    // .jpg) hace que sharp falle al decodificarlo, y aquí lo detectamos y
    // descartamos en vez de dejar que tumbe el servidor.
    try {
      const outputName = `${path.parse(file.filename).name}.webp`;
      const outputPath = path.join(UPLOAD_DIR, outputName);

      await sharp(file.path)
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(outputPath);

      savedUrls.push(`/uploads/${outputName}`);
    } catch (err) {
      rejected.push(file.originalname);
    } finally {
      fs.unlink(file.path, () => {}); // borra siempre el original sin optimizar
    }
  }

  if (savedUrls.length) {
    const maxPos = db
      .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM product_images WHERE product_id = ?')
      .get(req.params.id).m;

    const insert = db.prepare('INSERT INTO product_images (product_id, url, position) VALUES (?, ?, ?)');
    savedUrls.forEach((url, i) => insert.run(req.params.id, url, maxPos + 1 + i));
  }

  if (rejected.length && !savedUrls.length) {
    return res.status(400).json({ error: 'Ninguno de los archivos era una imagen válida.', rejected });
  }

  res.status(201).json({ images: savedUrls, rejected: rejected.length ? rejected : undefined });
});

router.delete('/:id/images/:imageId', requireAdmin, (req, res) => {
  const image = db
    .prepare('SELECT * FROM product_images WHERE id = ? AND product_id = ?')
    .get(req.params.imageId, req.params.id);
  if (!image) return res.status(404).json({ error: 'Imagen no encontrada.' });

  fs.unlink(path.join(UPLOAD_DIR, path.basename(image.url)), () => {});
  db.prepare('DELETE FROM product_images WHERE id = ?').run(req.params.imageId);
  res.status(204).end();
});

module.exports = router;
