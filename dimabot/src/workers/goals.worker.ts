import 'dotenv/config';
import { settleGoals } from '../goals/completion.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
if (process.argv.includes('--dry-run')) console.log('goals: completion, fixed deadlines and rolling failures');
else {
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  do {
    await settleGoals();
    if (process.argv.includes('--once')) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  } while (!stopping);
  await (await getMongoDBConnection('goals-worker-close')).disconnect();
  process.exit(0);
}
