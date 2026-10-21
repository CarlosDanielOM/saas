// Binary-exact interval hours isolate the source's unrounded 80% threshold.
// 75min/session =1.25h; eight7.5min intervals =8*.125h=1h of observations.
export const coverageSessionMs=75*60000;
export function coverageSnapshotOffsets(firstSnapshotShiftMs=0) {
    if(![0,1].includes(firstSnapshotShiftMs))throw new Error('Coverage fixture accepts only exact boundary or1ms-below shift');
    return Array.from({length:8},(_,index)=>15*60000+firstSnapshotShiftMs+index*7.5*60000);
}
