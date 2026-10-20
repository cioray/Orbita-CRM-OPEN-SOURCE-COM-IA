import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { defaultSettings, loadConfig } from './config.js';

const config = loadConfig();
const adminUrl = process.env.DATABASE_ADMIN_URL;
const password = process.env.APP_DB_PASSWORD;
if (!adminUrl || !password || !/^[a-f0-9]{64}$/.test(password)) throw new Error('Missing migration credentials');
const connection = new pg.Client({ connectionString: adminUrl });
await connection.connect();
try {
  await connection.query('SELECT pg_advisory_lock(82734921)');
  const existing = await connection.query("SELECT 1 FROM pg_roles WHERE rolname='motor_app'");
  if (!existing.rowCount) await connection.query(`CREATE ROLE motor_app LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
  await connection.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const filename of (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(`migrations/${filename}`, 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const applied = await connection.query('SELECT checksum FROM schema_migrations WHERE name=$1', [filename]);
    if (applied.rowCount) {
      if (applied.rows[0].checksum !== checksum) throw new Error(`Migration modified: ${filename}`);
      continue;
    }
    await connection.query('BEGIN');
    try {
      await connection.query(sql);
      await connection.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [filename, checksum]);
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    }
    console.log(`Applied ${filename}`);
  }
  await connection.query('INSERT INTO tenant_directory(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [config.TENANT_ID, 'Órbita Community']);
  await connection.query('INSERT INTO tenant_settings(tenant_id,settings) VALUES($1,$2) ON CONFLICT DO NOTHING', [config.TENANT_ID, defaultSettings]);
  await connection.query('INSERT INTO connections(tenant_id,instance_name) VALUES($1,$2) ON CONFLICT DO NOTHING', [config.TENANT_ID, config.EVOLUTION_INSTANCE]);
  console.log('Migrations and local seed ready');
} finally {
  await connection.end();
}
