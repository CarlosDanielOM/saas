import * as T from 'three';
import { describe, expect, it, vi } from 'vitest';
import { PrepQueue } from './duel-claude-3d-prep';
import { fracture, pieceMotion } from './duel-claude-3d-remains';

describe('duel battle preparation queue', () => {
  it('spends a frame budget, always making progress, and reports completion once', () => {
    let now = 0; const done = vi.fn(), ran: string[] = [];
    const queue = new PrepQueue(done, () => now);
    const job = (name: string, ms: number) => ({ name, run: () => { ran.push(name); now += ms; } });
    queue.reset([job('a', 4), job('b', 4), job('c', 10), job('d', 1)]);
    queue.step(6); expect(ran).toEqual(['a', 'b']);
    queue.step(6); expect(ran).toEqual(['a', 'b', 'c']); // a slow job still runs (alone)
    expect(done).not.toHaveBeenCalled();
    queue.step(6); expect(ran).toEqual(['a', 'b', 'c', 'd']);
    expect(done).toHaveBeenCalledTimes(1); expect(queue.idle).toBe(true); expect(queue.slowest).toEqual({ name: 'c', ms: 10 });
  });

  it('holds on asynchronous work without blocking, and ignores work from a replaced battle', async () => {
    const done = vi.fn(); let resolve!: () => void;
    const queue = new PrepQueue(done);
    queue.reset([{ name: 'compile', run: () => new Promise<void>(r => { resolve = r; }) }, { name: 'bake', run: () => undefined }]);
    queue.step(6); queue.step(6);
    expect(queue.pending).toBe(2);
    resolve(); await Promise.resolve(); await Promise.resolve();
    expect(queue.pending).toBe(1);
    queue.step(6); expect(done).toHaveBeenCalledTimes(1);
    // A stale promise settling after a reset must not advance the new battle.
    let stale!: () => void; const next = vi.fn();
    queue.reset([{ name: 'old compile', run: () => new Promise<void>(r => { stale = r; }) }]); queue.step(6);
    queue.reset([{ name: 'new', run: next }]);
    stale(); await Promise.resolve(); await Promise.resolve();
    expect(queue.pending).toBe(1); queue.step(6); expect(next).toHaveBeenCalled();
  });

  it('flushes everything at once when the finisher is about to play (blocking fallbacks)', () => {
    const done = vi.fn(), order: string[] = [];
    const queue = new PrepQueue(done);
    queue.reset([{ name: 'a', run: () => { order.push('a'); } }, { name: 'compile', run: () => Promise.resolve(), now: () => { order.push('compile now'); } }, { name: 'b', run: () => { order.push('b'); } }]);
    queue.add([{ name: 'first', run: () => { order.push('first'); } }]);
    queue.flush();
    expect(order).toEqual(['first', 'a', 'compile now', 'b']); expect(done).toHaveBeenCalledTimes(1); expect(queue.idle).toBe(true);
  });
});

describe('duel shatter', () => {
  it('splits along the planes, duplicating only boundary vertices and keeping groups', () => {
    const box = new T.BoxGeometry(1, 2, 1, 4, 4, 4); box.addGroup(0, 36, 0); box.addGroup(36, box.index!.count - 36, 1);
    const plane = new T.Plane(new T.Vector3(1, 0, 0), 0);
    const { geometry, fracture: f } = fracture(box, [plane]);
    expect(f.pieces).toBe(2);
    expect(geometry.index!.count).toBe(box.index!.count);
    expect(geometry.groups.map(g => [g.start, g.count, g.materialIndex])).toEqual(box.groups.map(g => [g.start, g.count, g.materialIndex]));
    expect(geometry.attributes['position'].count).toBeGreaterThan(box.attributes['position'].count);
    expect(geometry.attributes['position'].count).toBeLessThan(box.index!.count);
    // Every triangle belongs to one piece; pieces sit on opposite sides of the plane.
    const piece = geometry.attributes['aPiece'], index = geometry.index!;
    for (let t = 0; t < index.count; t += 3) { const p = piece.getX(index.getX(t)); expect(piece.getX(index.getX(t + 1))).toBe(p); expect(piece.getX(index.getX(t + 2))).toBe(p); }
    expect(Math.sign(f.centers[0].x)).toBe(-Math.sign(f.centers[1].x));
    // Seams: distance to the cut.
    const edge = geometry.attributes['aEdge'], position = geometry.attributes['position'];
    for (let i = 0; i < position.count; i++) expect(edge.getX(i)).toBeCloseTo(Math.abs(position.getX(i)), 5);
  });

  it('flies pieces in closed form and stops them at the floor', () => {
    const offset = new T.Vector3(), spin = new T.Quaternion();
    pieceMotion(3, new T.Vector3(.2, 1, 0), new T.Vector3(0, 1, 0), 0, -1, offset, spin);
    expect(offset.length()).toBe(0); expect(spin.w).toBe(1);
    pieceMotion(3, new T.Vector3(.2, 1, 0), new T.Vector3(0, 1, 0), .3, -1, offset, spin);
    const early = offset.clone(); expect(early.x).toBeGreaterThan(0);
    pieceMotion(3, new T.Vector3(.2, 1, 0), new T.Vector3(0, 1, 0), 3, -1, offset, spin);
    expect(offset.y).toBeCloseTo(-1 - 1, 5); // floor (-1) minus the piece's height (1)
    pieceMotion(3, new T.Vector3(.2, 1, 0), new T.Vector3(0, 1, 0), 3, -1, early, spin);
    expect(early).toEqual(offset); // pure: same inputs, same result
  });
});
