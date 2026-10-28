/**
 * backup-database.js
 * Makes a timestamped, verified backup of the live PostgreSQL database using `pg_dump`
 * (custom format, -Fc), restorable with `pg_restore`. This replaced the old SQLite
 * file-copy backup (better-sqlite3's online backup API) when the app moved to Postgres -
 * pg_dump is Postgres's own equivalent: a consistent, online snapshot safe to take while
 * the server keeps running.
 *
 * Keeps the last N backups (default 14) and deletes older ones automatically.
 *
 * Run manually: node scripts/backup-database.js
 * Recommended production schedule (daily, outside business hours):
 *   0 3 * * * cd /path/to/app && node scripts/backup-database.js >> /var/log/aiventra-backup.log 2>&1
 *
 * To restore a backup:
 *   pg_restore -h $DB_HOST -p $DB_PORT -U $DB_USER -d <target_db> --clean --if-exists <backup file>
 *
 * For real disaster recovery, the backups directory itself should also be synced to
 * off-server storage (S3, another host, etc.) - this script only handles the local,
 * on-disk half of that; see docs/security.md "Backup & recovery" for the full picture.
 */
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
require('dotenv').config();

const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_LAST = Number(process.env.BACKUP_RETAIN_COUNT) || 14;

const PG_ENV = {
  ...process.env,
  PGHOST: process.env.DB_HOST || 'localhost',
  PGPORT: process.env.DB_PORT || '5432',
  PGDATABASE: process.env.DB_NAME || 'aiventra',
  PGUSER: process.env.DB_USER || 'postgres',
  PGPASSWORD: process.env.DB_PASSWORD // never hard-coded - passed through from the environment
};

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function main() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `aiventra-${stamp}.dump`);

  try {
    // -Fc: custom format - compressed, and the only format pg_restore can selectively
    // restore from or verify with `pg_restore --list`.
    await run('pg_dump', ['-Fc', '-f', backupPath], PG_ENV);

    // Verify the backup actually contains data before trusting it (list its table of
    // contents and confirm the `organizations` table is in there).
    const toc = await run('pg_restore', ['--list', backupPath], PG_ENV);
    if (!/organizations/.test(toc)) {
      throw new Error('Backup verification failed: organizations table not found in dump.');
    }

    console.log(`Backup complete: ${backupPath} (verified readable)`);
    rotateOldBackups();
  } catch (err) {
    console.error('Backup FAILED:', err.message);
    process.exit(1);
  }
}

function rotateOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('aiventra-') && f.endsWith('.dump'))
    .map(f => ({ name: f, path: path.join(BACKUP_DIR, f), mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const toDelete = files.slice(KEEP_LAST);
  toDelete.forEach(f => { fs.unlinkSync(f.path); console.log(`Removed old backup: ${f.name}`); });
  if (toDelete.length === 0) console.log(`Retaining all ${files.length} backup(s) (limit: ${KEEP_LAST}).`);
}

main();
