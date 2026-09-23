require('dotenv').config();
const bcrypt = require('bcryptjs');
const slugify = require('slugify');
const db = require('./config/db');

function run() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error('⛔ Define ADMIN_EMAIL y ADMIN_PASSWORD en tu .env antes de correr el seed.');
    process.exit(1);
  }

  const existing = db.prepare('SELECT id FROM admins WHERE email = ?').get(email);
  if (existing) {
    console.log(`ℹ️  Ya existe un admin con el email ${email}. No se creó ninguno nuevo.`);
  } else {
    const hash = bcrypt.hashSync(password, 12);
    db.prepare('INSERT INTO admins (email, password_hash, name, role) VALUES (?, ?, ?, ?)').run(
      email,
      hash,
      'Administrador Principal',
      'admin'
    );
    console.log(`✅ Usuario administrador creado: ${email}`);
    console.log('   Cambia esta contraseña apenas inicies sesión por primera vez.');
  }

  const sampleCategories = ['Tecnología', 'Ropa y Accesorios', 'Hogar y Cocina', 'Mascotas', 'Belleza'];
  const insertCat = db.prepare('INSERT OR IGNORE INTO categories (name, slug) VALUES (?, ?)');
  sampleCategories.forEach((name) => insertCat.run(name, slugify(name, { lower: true, strict: true })));
  console.log('✅ Categorías de ejemplo listas (puedes editarlas o borrarlas desde el panel admin).');
}

run();
