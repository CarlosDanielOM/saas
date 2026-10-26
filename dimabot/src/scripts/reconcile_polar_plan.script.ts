import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { reconcilePolarPlanEntitlement } from '../domain_events/polar_billing_events.js';

// Uses explicitly supplied process environment, never auto-loads a production .env.
// node dist/scripts/reconcile_polar_plan.script.js --owner <users._id> --customer <Polar ID> [--execute]
export function parsePolarPlanReconciliationArgs(args: string[]) {
    let ownerUserId = '';
    let customerId = '';
    let execute = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--owner' && !ownerUserId) ownerUserId = args[++index] ?? '';
        else if (arg === '--customer' && !customerId) customerId = args[++index] ?? '';
        else if (arg === '--execute' && !execute) execute = true;
        else throw new Error('Usage: reconcile_polar_plan --owner <users._id> --customer <Polar ID> [--execute]');
    }
    if (!/^[a-f\d]{24}$/i.test(ownerUserId) || !customerId.trim() || customerId.startsWith('--')) {
        throw new Error('Explicit owner and customer IDs are required; default mode is dry-run');
    }
    return { ownerUserId, customerId, execute };
}

async function main() {
    const input = parsePolarPlanReconciliationArgs(process.argv.slice(2));
    try {
        await getMongoDBConnection('reconcilePolarPlanEntitlement');
        console.log(JSON.stringify(await reconcilePolarPlanEntitlement(input), null, 2));
    } finally {
        await mongoose.disconnect();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().then(() => process.exit(0), error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
