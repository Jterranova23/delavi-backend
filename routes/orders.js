const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ---------------------------------------------------------------------------
// PÚBLICO: crear un pedido a partir del carrito.
//
// REGLA DE SEGURIDAD CLAVE: nunca confiamos en los precios que manda el
// navegador. El cliente solo envía { productId, quantity }; el precio y el
// nombre se leen de la base de datos en el servidor. Así nadie puede abrir
// las herramientas de desarrollador y pagar $1 por un producto de $50.
// ---------------------------------------------------------------------------
router.post(
  '/',
  [
    body('customerName').trim().isLength({ min: 2, max: 100 }),
    body('customerEmail').isEmail().normalizeEmail(),
    body('customerPhone').trim().isLength({ min: 7, max: 20 }),
    body('customerDocument').optional().isString().isLength({ max: 20 }),
    body('shippingAddress').trim().isLength({ min: 5, max: 300 }),
    body('shippingCity').trim().isLength({ min: 2, max: 80 }),
    body('items').isArray({ min: 1 }),
    body('items.*.productId').isInt(),
    body('items.*.quantity').isInt({ min: 1, max: 50 })
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Datos del pedido inválidos.', details: errors.array() });
    }

    const {
      customerName, customerEmail, customerPhone, customerDocument,
      shippingAddress, shippingCity, items
    } = req.body;

    // Recalcula todo en el servidor a partir de la base de datos real.
    let subtotalCents = 0;
    const resolvedItems = [];

    for (const item of items) {
      const product = db
        .prepare("SELECT * FROM products WHERE id = ? AND status = 'active'")
        .get(item.productId);

      if (!product) {
        return res.status(400).json({ error: `Un producto del carrito ya no está disponible.` });
      }
      if (product.stock < item.quantity) {
        return res.status(400).json({ error: `No hay suficiente stock de "${product.name}".` });
      }

      subtotalCents += product.price_cents * item.quantity;
      resolvedItems.push({
        productId: product.id,
        name: product.name,
        unitPriceCents: product.price_cents,
        quantity: item.quantity
      });
    }

    const shippingCents = subtotalCents >= 3000 ? 0 : 350; // envío gratis desde $30, ejemplo
    const totalCents = subtotalCents + shippingCents;
    const clientTransactionId = `ORD-${Date.now()}-${uuidv4().slice(0, 6)}`;

    const insertOrder = db.prepare(`
      INSERT INTO orders
        (client_transaction_id, customer_name, customer_email, customer_phone, customer_document,
         shipping_address, shipping_city, subtotal_cents, shipping_cents, tax_cents, total_cents, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending')
    `);

    const info = insertOrder.run(
      clientTransactionId, customerName, customerEmail, customerPhone, customerDocument || null,
      shippingAddress, shippingCity, subtotalCents, shippingCents, totalCents
    );

    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, unit_price_cents, quantity)
      VALUES (?, ?, ?, ?, ?)
    `);
    resolvedItems.forEach((it) =>
      insertItem.run(info.lastInsertRowid, it.productId, it.name, it.unitPriceCents, it.quantity)
    );

    res.status(201).json({
      orderId: info.lastInsertRowid,
      clientTransactionId,
      subtotalCents,
      shippingCents,
      totalCents
    });
  }
);

// PÚBLICO: consultar el estado de un pedido propio por su clientTransactionId
router.get('/track/:clientTransactionId', (req, res) => {
  const order = db
    .prepare('SELECT * FROM orders WHERE client_transaction_id = ?')
    .get(req.params.clientTransactionId);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });

  res.json({
    status: order.status,
    total: order.total_cents / 100,
    createdAt: order.created_at
  });
});

// ---------------------------------------------------------------------------
// ADMIN: listar y actualizar estado de pedidos (ej. marcar como "enviado")
// ---------------------------------------------------------------------------
router.get('/', requireAdmin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  res.json(orders);
});

router.get('/:id', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id);
  res.json({ ...order, items });
});

router.patch(
  '/:id/status',
  requireAdmin,
  [body('status').isIn(['pending', 'paid', 'cancelled', 'shipped', 'delivered'])],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Estado inválido.' });

    db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
      req.body.status,
      req.params.id
    );
    res.json({ ok: true });
  }
);

module.exports = router;
