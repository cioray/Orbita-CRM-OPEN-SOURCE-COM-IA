import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import {Evolution} from './evolution.js';
import {startContactIdentitySync} from './contact-identity.js';

const config = loadConfig();
const db = new Database(config.DATABASE_URL);
const app = buildApp(config, db);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  void app.close().then(() => db.close()).then(() => process.exit(0));
});
const stopContactSync=startContactIdentitySync(db,new Evolution(config),config.TENANT_ID);
app.addHook('onClose',stopContactSync);
await app.listen({ host: config.HOST, port: config.PORT });
