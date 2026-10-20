import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve('.env');
if (existsSync(target)) {
  console.log('.env existente preservado.');
  process.exit(0);
}
const secret = () => randomBytes(32).toString('hex');
const databasePassword = secret();
const applicationPassword = secret();
const evolutionKey = secret();
const content = [
  `POSTGRES_PASSWORD=${databasePassword}`,
  `APP_DB_PASSWORD=${applicationPassword}`,
  `DATABASE_ADMIN_URL=postgresql://motor:${databasePassword}@localhost:55432/motor`,
  `DATABASE_URL=postgresql://motor_app:${applicationPassword}@localhost:55432/motor`,
  'REDIS_URL=redis://localhost:26379',
  `ADMIN_TOKEN=${secret()}`,
  `WEBHOOK_SECRET=${secret()}`,
  'TENANT_ID=00000000-0000-4000-8000-000000000001',
  'EVOLUTION_URL=http://localhost:8080',
  `EVOLUTION_API_KEY=${evolutionKey}`,
  'EVOLUTION_INSTANCE=minha-instancia',
  'EVOLUTION_POSTGRES_PASSWORD=' + secret(),
  'CRM_PORT=8090',
  'EVOLUTION_PORT=8080',
  'DATABASE_PORT=55432',
  'QUEUE_PORT=26379',
  'PORT=8090',
  'HOST=0.0.0.0',
  'TYPESAFE_API_KEY=',
  'OPENAI_API_KEY=',
  'GEMINI_API_KEY=',
  'OPENROUTER_API_KEY=',
  'MEDIA_ROOT=./data/media',
  ''
].join('\n');
writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
console.log('.env criado com segredos locais. Preencha somente as chaves de IA desejadas.');
