const bcrypt = require('bcryptjs');
const slugify = require('slugify');
const db = require('./config/db');

// Exportada para poder llamarla tanto desde "npm run seed" (uso local) como
// automáticamente al arrancar el servidor (uso en producción, ej. Railway),
// sin depender de un paso manual aparte. Es segura de llamar varias veces:
// no crea un segundo admin ni duplica categorías si ya existen.
function run() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.warn('⚠️  ADMIN_EMAIL/ADMIN_PASSWORD no definidos: se omite la creación del admin inicial.');
    return;
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

module.exports = { run };

// Si se ejecuta directamente ("node seed.js" / "npm run seed"), corre de una vez.
// Si otro archivo hace require('./seed'), solo queda disponible run() para llamarla cuando quiera.
if (require.main === module) {
  require('dotenv').config();
  run();
}
