/**
 * create-super-admin.js
 * Creates an Aiventra platform admin account (organization_id = NULL, role =
 * 'aiventra_super_admin'). This account can access the Aiventra Admin Control Center at
 * /admin.html but has NO direct access to any hospital's clinical data (see
 * server/routes/support.js for the approval-gated, time-boxed exception).
 *
 * Run: node scripts/create-super-admin.js "Full Name" username password
 */
const bcrypt = require('bcryptjs');
const db = require('../server/db');

const [, , name, username, password] = process.argv;

if (!name || !username || !password) {
  console.error('Usage: node scripts/create-super-admin.js "Full Name" <username> <password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

async function main() {
  await db.init();

  const existing = await db.prepare(`SELECT id FROM users WHERE username = ?`).get(username.trim().toLowerCase());
  if (existing) {
    console.error(`A user with username "${username}" already exists.`);
    process.exit(1);
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = await db.prepare(`INSERT INTO users (organization_id, name, username, password_hash, role) VALUES (NULL, ?, ?, ?, 'aiventra_super_admin')`)
    .run(name, username.trim().toLowerCase(), hash);

  console.log(`\nAiventra platform admin created (user id ${info.lastInsertRowid}).`);
  console.log(`Log in at /admin.html with:`);
  console.log(`  Username: ${username.trim().toLowerCase()}`);
  console.log(`  Password: (as entered)\n`);
  await db.pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
