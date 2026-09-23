const express = require('express');
const fetch = require('node-fetch');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');

const router = express.Router();

const PAYPHONE_CONFIRM_URL = 'https://paymentbox.payphonetodoesposible.com/api/confirm';

// ---------------------------------------------------------------------------
// El widget "Cajita de Pagos" de PayPhone se renderiza en el navegador y,
// por diseño de PayPhone, necesita el token y storeId en el propio HTML.
// Por eso se lo servimos desde nuestro backend (en vez de dejarlo escrito
// en un archivo estático) para poder rotarlo sin tocar el código del
// frontend y para no versionarlo en el repositorio.
// ---------------------------------------------------------------------------
router.get('/config', (req, res) => {
  if (!process.env.PAYPHONE_TOKEN || !process.env.PAYPHONE_STORE_ID) {
    return res.status(503).json({ error: 'PayPhone aún no está configurado en el servidor.' });
  }
  res.json({
    token: process.env.PAYPHONE_TOKEN,
    storeId: process.env.PAYPHONE_STORE_ID
  });
});

// ---------------------------------------------------------------------------
// Confirmación server-side de la transacción (fase 2 del flujo PayPhone).
// El navegador vuelve del formulario de pago con ?id=...&clientTransactionId=...
// Nuestro servidor —nunca el navegador— llama a la API de PayPhone con el
// token secreto para verificar el estado REAL del pago antes de marcar el
// pedido como pagado y descontar stock. Esto es lo que evita que alguien
// falsifique un "pago exitoso" manipulando el navegador.
// ---------------------------------------------------------------------------
router.post(
  '/confirm',
  [body('id').isInt(), body('clientTransactionId').isString().isLength({ min: 1, max: 60 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Parámetros de confirmación inválidos.' });

    const { id, clientTransactionId } = req.body;

    const order = db
      .prepare('SELECT * FROM orders WHERE client_transaction_id = ?')
      .get(clientTransactionId);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });

    try {
      const response = await fetch(PAYPHONE_CONFIRM_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PAYPHONE_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ id, clientTxId: clientTransactionId })
      });

      const data = await response.json();

      if (!response.ok) {
        db.prepare(
          "UPDATE orders SET status = 'cancelled', payphone_raw_response = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(JSON.stringify(data), order.id);
        return res.status(402).json({ error: data.message || 'El pago no pudo confirmarse.' });
      }

      const isApproved = data.transactionStatus === 'Approved';
      const newStatus = isApproved ? 'paid' : 'cancelled';

      db.prepare(
        `UPDATE orders SET status = ?, payphone_transaction_id = ?, payphone_status = ?,
         payphone_raw_response = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(newStatus, String(data.transactionId), data.transactionStatus, JSON.stringify(data), order.id);

      if (isApproved) {
        // Descuenta stock solo cuando el pago ya está confirmado de verdad.
        const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
        const decrementStock = db.prepare(
          'UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?'
        );
        items.forEach((it) => {
          if (it.product_id) decrementStock.run(it.quantity, it.product_id);
        });
      }

      res.json({
        status: newStatus,
        transactionId: data.transactionId,
        amount: data.amount / 100
      });
    } catch (err) {
      console.error('Error confirmando pago con PayPhone:', err.message);
      res.status(502).json({ error: 'No se pudo contactar a PayPhone para confirmar el pago. Intenta de nuevo.' });
    }
  }
);

module.exports = router;
