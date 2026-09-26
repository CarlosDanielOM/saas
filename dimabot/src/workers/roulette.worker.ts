import 'dotenv/config';
import { settleDue } from '../roulette/service.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';

if (process.argv.includes('--dry-run')) {
  console.log('roulette-completion: durable Mongo deadlines, no external providers');
} else {
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  await getMongoDBConnection('roulette-worker');
  do {
    await settleDue(); // Supervisor restarts this worker if storage fails.
    if (process.argv.includes('--once')) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (!stopping);
  const mongo = await getMongoDBConnection('roulette-worker-close');
  await mongo.disconnect();
}
