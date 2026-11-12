// Run with the reference checkout's tsx from dimabot; no source is modified.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const require = createRequire(process.cwd() + '/package.json');
const React = require('react');
globalThis.fetch = async () => {
  throw new Error('Network forbidden in email fixture generation');
};
const { render } = require('@react-email/render');
async function main() {
  const root = process.cwd() + '/src/utils/email/templates/';
  const defs = [
    ['welcome', 'WelcomeEmail', 'getWelcomeEmailSubject'],
    [
      'activation-reminder',
      'ActivationReminderEmail',
      'getActivationReminderSubject',
    ],
    ['stream-summary', 'StreamSummaryEmail', 'getStreamSummaryEmailSubject'],
    [
      'vod-clip-analysis-finished',
      'VodClipAnalysisFinishedEmail',
      'getVodClipAnalysisFinishedSubject',
    ],
  ];
  const mods = await Promise.all(
    defs.map(
      async ([file]) => import(pathToFileURL(root + file + '.tsx').href),
    ),
  );
  const base: any = {
    streamerName: 'DIMA_NAME_TOKEN',
    discountCode: 'DIMA_DISCOUNT_TOKEN',
    dashboardLink: 'https://dima.dashboard.invalid/TOKEN',
    activationLink: 'https://dima.activation.invalid/TOKEN',
    streamDate: 'DIMA_DATE_TOKEN',
    streamDuration: 137,
    headline: 'DIMA_HEADLINE_TOKEN',
    recapSnippet: 'DIMA_RECAP_TOKEN',
    highlights: [
      'DIMA_HIGHLIGHT_0_TOKEN',
      'DIMA_HIGHLIGHT_1_TOKEN',
      'DIMA_HIGHLIGHT_2_TOKEN',
      'DIMA_HIGHLIGHT_3_TOKEN',
      'DIMA_HIGHLIGHT_4_TOKEN',
    ],
    stats: {
      averageViewers: 231,
      peakViewers: 432,
      follows: 123,
      subs: 234,
      bits: 345,
      donations: 999,
    },
    memoryCount: 789,
    fullSummaryLink: 'https://dima.summary.invalid/TOKEN',
    dashboardUrl: 'https://dima.clips.invalid/TOKEN',
    approvedCount: 678,
  };
  // Normalization: omit only the optional Prettier pass. Every case also records
  // the reference service’s prettyHtml; Rust emits this compact renderer output.
  async function output(i: number, p: any) {
    const el = React.createElement(mods[i][defs[i][1]], p);
    return {
      html: await render(el),
      text: await render(el, {
        plainText: true,
        htmlToTextOptions: { wordwrap: false },
      }),
      subject:
        i === 2
          ? mods[i][defs[i][2]](p.streamDate, p.language)
          : mods[i][defs[i][2]](p.language),
    };
  }
  function diff(a: string, b: string) {
    let start = 0;
    while (start < a.length && a[start] === b[start]) start++;
    let end = 0;
    while (
      end < a.length - start &&
      end < b.length - start &&
      a[a.length - 1 - end] === b[b.length - 1 - end]
    )
      end++;
    return {
      start: Buffer.byteLength(a.slice(0, start)),
      old: a.slice(start, a.length - end),
      replacement: b.slice(start, b.length - end),
    };
  }
  const templates: any[] = [];
  for (let i = 0; i < 4; i++)
    for (const language of ['en', 'es'])
      for (const theme of ['dark', 'light'])
        for (const highlightCount of i === 2 ? [0, 1, 2, 3, 4, 5] : [0]) {
          const p = {
            ...base,
            language,
            theme,
            highlights: base.highlights.slice(0, highlightCount),
          };
          const original = await output(i, p);
          const patches: any = {};
          const changes: any =
            i === 0
              ? { discount: { discountCode: '' } }
              : i === 2
                ? {
                    memory0: { memoryCount: 0 },
                    memory1: { memoryCount: 1 },
                    recap: { recapSnippet: '' },
                    follows: { stats: { ...p.stats, follows: 0 } },
                    subs: { stats: { ...p.stats, subs: 0 } },
                    bits: { stats: { ...p.stats, bits: 0 } },
                  }
                : i === 3
                  ? { count1: { approvedCount: 1 } }
                  : {};
          for (const [key, change] of Object.entries(changes)) {
            const altered = await output(i, { ...p, ...(change as any) });
            patches[key] = {
              html: diff(original.html, altered.html),
              text: diff(original.text, altered.text),
            };
          }
          templates.push({
            kind: defs[i][0],
            language,
            theme,
            highlightCount,
            ...original,
            patches,
          });
        }
  const cases: any[] = [];
  for (let i = 0; i < 4; i++)
    for (const language of ['en', 'es', 'unknown'])
      for (const theme of ['dark', 'light'])
        for (let edge = 0; edge < 8; edge++) {
          const special = [
            'Alice',
            '<>&"\' 😀 مرحبا שָׁלוֹם é',
            'a'.repeat(400),
            'x y '.repeat(120),
            '',
            '\n hello\t world \n',
            'DIMA_NAME_TOKEN',
            '𝄞👨‍👩‍👧‍👦',
          ][edge];
          const p: any = {
            ...base,
            streamerName: special,
            discountCode: edge % 2 ? special : undefined,
            language,
            theme,
            headline: special,
            recapSnippet: edge % 2 ? special : '',
            streamDate: special,
            highlights:
              edge === 0
                ? []
                : Array.from({ length: edge }, (_, j) =>
                    j % 2 ? special : 'highlight ' + j,
                  ),
            memoryCount: edge - 1,
            approvedCount: edge - 1,
            streamDuration: [0, 0.5, 59.5, 60, 61, 10000, -1, 137][edge],
            stats: {
              averageViewers: [0, 999, 1000, 9999, 10000, 999999, 1000000, -1][
                edge
              ],
              peakViewers: 432,
              follows: edge % 2 ? 0 : 123,
              subs: edge % 2 ? 234 : 0,
              bits: edge % 2 ? 0 : 345,
              donations: 999,
            },
          };
          const el = React.createElement(mods[i][defs[i][1]], p);
          cases.push({
            kind: defs[i][0],
            input: p,
            prettyHtml: await render(el, { pretty: true }),
            ...(await output(i, p)),
            text: await render(el, { plainText: true }),
          });
        }
  // Optional fields absent and URL escaping are independent of the text-edge matrix.
  for (let i = 0; i < 4; i++) {
    const variants = [
      { language: undefined, theme: undefined, discountCode: undefined },
      {
        language: 'es',
        theme: 'invalid',
        discountCode: 'SALE',
        streamerName: '<tag> & "quote" مرحبا 😀',
        dashboardLink: 'https://example.invalid/?x="&y=<😀>',
        activationLink: 'https://example.invalid/?x="&y=<😀>',
        fullSummaryLink: 'https://example.invalid/?x="&y=<😀>',
        dashboardUrl: 'https://example.invalid/?x="&y=<😀>',
      },
      {
        streamDuration: 60,
        approvedCount: 1,
        memoryCount: 1,
        highlights: ['one', '', 'two', 'three', 'four', 'five', 'six'],
      },
      {
        approvedCount: 0,
        memoryCount: 0,
        highlights: [],
        recapSnippet: '',
        discountCode: '',
      },
    ];
    for (const v of variants) {
      const p = { ...base, ...v };
      const el = React.createElement(mods[i][defs[i][1]], p);
      cases.push({
        kind: defs[i][0],
        input: p,
        prettyHtml: await render(el, { pretty: true }),
        ...(await output(i, p)),
        text: await render(el, { plainText: true }),
      });
    }
  }
  writeFileSync(process.argv[2], JSON.stringify({ cases }, null, 2) + '\n');
  writeFileSync(
    new URL('../src/generated.json', import.meta.url),
    JSON.stringify(templates, null, 2) + '\n',
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
