import 'dotenv/config';
import { runDueActions } from '../roulette/actions.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';

if (process.argv.includes('--dry-run')) {
  console.log('roulette-actions: durable, single-claim winner AST execution');
} else {
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  do {
    await runDueActions();
    if (process.argv.includes('--once')) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (!stopping);
  const mongo = await getMongoDBConnection('roulette-actions-close');
  await mongo.disconnect();
  process.exit(0);
}
