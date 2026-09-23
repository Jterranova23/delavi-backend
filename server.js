require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const productsRouter = require('./routes/products');
const categoriesRouter = require('./routes/categories');
const ordersRouter = require('./routes/orders');
const authRouter = require('./routes/auth');
const payphoneRouter = require('./routes/payphone');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.includes('CAMBIA_ESTO')) {
  console.error('⛔ Debes definir un JWT_SECRET real en tu archivo .env antes de arrancar en producción.');
  if (process.env.NODE_ENV === 'production') process.exit(1);
}

const app = express();

// Detrás de un proxy/balanceador (Nginx, Render, Railway, etc.) para que
// express-rate-limit y los IPs reales funcionen correctamente.
app.set('trust proxy', 1);

// --- Seguridad de cabeceras HTTP -------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: false // el frontend define su propio CSP; ver frontend/README
  })
);

// --- CORS: solo permite que tu propio dominio llame al API -----------------------
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error('Origen no permitido por la política CORS.'));
    },
    credentials: true
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// --- Límite general de peticiones por IP, contra abuso/DoS básico ----------------
app.use(
  '/api/',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
);

// Archivos de imágenes subidas por el admin
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '30d' }));

// --- Rutas del API -----------------------------------------------------------------
app.use('/api/auth', authRouter);
app.use('/api/products', productsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/payphone', payphoneRouter);

app.get('/api/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV }));

// --- Manejo de errores centralizado (nunca exponemos detalles internos) -----------
app.use((err, req, res, next) => {
  console.error(err);
  if (err.message && err.message.includes('CORS')) {
    return res.status(403).json({ error: 'Origen no permitido.' });
  }
  if (err.name === 'MulterError' || /Formato no permitido/.test(err.message || '')) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Ocurrió un error interno. Intenta más tarde.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ API de la tienda corriendo en http://localhost:${PORT}`);
});
