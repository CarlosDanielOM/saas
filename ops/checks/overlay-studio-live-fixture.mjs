// Fake Studio backends: the `live` map the API adds to every Studio response (dimabot/src/overlays/publish.ts).
// Like the real server, an overlay is live when running the fake's own publish step on the saved draft
// gives the copy it stored. Pass that step as `build` when the fake changes the copy (e.g. custom widget pins).

/** The plain publish step: the overlay's content and the alert designs it uses. */
export const publishedCopy = (scene, state) => structuredClone({ width: scene.width, height: scene.height, widgets: scene.widgets, waitFor: scene.waitFor ?? [],
  designs: (state.designs ?? []).filter(d => scene.widgets.some(w => w.designId === d.id)) });

const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
// Design revisions are not content; fakes that store every design compare only the ones this overlay uses.
const content = copy => canonical({ ...copy, waitFor: copy.waitFor ?? [],
  designs: (copy.designs ?? []).filter(d => copy.widgets.some(w => w.designId === d.id)).map(({ revision: _revision, ...design }) => design) });

export function liveMap(state, build = publishedCopy) {
  return Object.fromEntries(state.scenes.map(scene => [scene.id, !!scene.published && content(build(scene, state)) === content(scene.published)]));
}
/** A Studio state response as the API sends it. */
export const withLive = (state, build = publishedCopy) => ({ ...state, live: liveMap(state, build) });
