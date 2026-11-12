// `utils/tokens.ts` for the recorder: the app token is whatever the scenario says.
export const getAppToken = async () => globalThis.__eventsubFixture?.appToken ?? null;
export const getBotToken = async () => null;
