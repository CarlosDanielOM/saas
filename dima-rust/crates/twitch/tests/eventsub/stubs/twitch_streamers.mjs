// `classes/twitch_streamers.class.ts` for the recorder: the directory and the streamer tokens of
// the scenario (the Rust side builds the same from the seeded users).
export default {
  async getTwitchAccountById(id) {
    return globalThis.__eventsubFixture?.directory?.[id] ?? null;
  },
  async getAccountTokenById(id) {
    return globalThis.__eventsubFixture?.tokens?.[id] ?? null;
  },
};
