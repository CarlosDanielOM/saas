// Stand-in for the native `re2` package, so the moderation modules load (their functions never run
// in this recording: moderation is the stub `moderation.mjs`).
export default class RE2 extends RegExp {
  constructor(pattern, flags) {
    super(pattern instanceof RegExp ? pattern.source : pattern, flags ?? (pattern instanceof RegExp ? pattern.flags : ''));
  }
}
