// Supplemental fixture for the unchanged bot-d3f31c3ea2b9 image's older test source.
// Only the transport/journal suite receives an already-eligible raid configuration;
// every admission, trigger, parser and packaged production module remains real or
// uses that suite's existing explicit mocks. This is not loaded by runtime acceptance.
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';
const suite = '/app/dist/bot/eventsub.twitch.test.js';
// Future images contain the checked-in five-line fixture correction themselves.
if (process.argv[1] === suite && !readFileSync(suite, 'utf8').includes("mock.module('../utils/raid_subscriptions.js'")) {
  mock.module('/app/dist/utils/raid_subscriptions.js', { namedExports: {
    acceptsRaidNotification: async () => true
  } });
}
