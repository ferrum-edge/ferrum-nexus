import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { createStore } from './index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = await createStore(config);
  try {
    await store.migrate();
    process.stdout.write(`Migrations applied for driver=${store.driver}\n`);
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
