// Host-testable assertions shared by the exact-image lifecycle fixtures.
import assert from 'node:assert/strict';
export function ownedBulkWrite(body,database) {
    return body.bulkWrite===1 && Array.isArray(body.nsInfo) && body.nsInfo.length>0
        && body.nsInfo.every(row=>typeof row.ns==='string' && row.ns.startsWith(`${database}.`)
            && row.ns.length>database.length+1);
}
export function collectionWrites(body,collection,database) {
    if(body.update===collection || body.findAndModify===collection)return true;
    return ownedBulkWrite(body,database) && Array.isArray(body.ops)
        && body.ops.some(row=>Number.isInteger(row.update) && body.nsInfo[row.update]?.ns===`${database}.${collection}`);
}
export function checkpointOwnerGuard(body,collection) {
    return body.find===collection && body.filter?._id==='dashboard-daily-v1'
        && typeof body.filter.owner==='string' && body.filter.owner.length>0
        && body.projection?._id===1;
}
export function assertHeartbeatRenewal({abandoned,retained,parsed,collection}) {
    assert(abandoned.leaseUntil instanceof Date && retained.leaseUntil instanceof Date);
    assert.equal(retained.owner,abandoned.owner);
    assert(+retained.leaseUntil>=+abandoned.leaseUntil+15000,
        'watchdog lease must advance at least15s beyond original claim; initial60s lease alone is insufficient');
    const heartbeats=parsed.filter(row=>row.body.update===collection).flatMap(row=>row.body.updates||[])
        .filter(update=>update.q?._id==='dashboard-daily-v1' && update.q.owner===abandoned.owner
            && Object.keys(update.u?.$set||{}).length===1 && update.u.$set.leaseUntil instanceof Date
            && +update.u.$set.leaseUntil>+abandoned.leaseUntil);
    assert(heartbeats.length>=2,'wire proxy must observe at least two owner-guarded lease renewal commands');
    assert(heartbeats.some(update=>+update.u.$set.leaseUntil===+retained.leaseUntil),
        'persisted watchdog lease must match an observed heartbeat command');
    return heartbeats.length;
}
