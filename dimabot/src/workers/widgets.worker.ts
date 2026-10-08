import 'dotenv/config';
import { settleDue } from '../widgets/service.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
if (process.argv.includes('--dry-run')) console.log('widgets: durable draws and Twitch poll AST; indexed deadlines');
else {
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  do {
    await settleDue();
    if (process.argv.includes('--once')) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (!stopping);
  (await getMongoDBConnection('widget-worker-close')).disconnect();
  process.exit(0);
}
