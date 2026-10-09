import 'dotenv/config';
import { settleDuels } from '../duel/completion.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
if (process.argv.includes('--dry-run')) console.log('duel: durable battle deadlines, winner announcements and moderator restoration');
else {
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  do {
    await settleDuels();
    if (process.argv.includes('--once')) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (!stopping);
  (await getMongoDBConnection('duel-worker-close')).disconnect();
  process.exit(0);
}
