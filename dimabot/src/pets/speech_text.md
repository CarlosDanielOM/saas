# Pure pet speech text APIs

These APIs compose the pure filtering step at the pet speech boundary. They do
not start the pet runtime or adopt application callers.

| TypeScript export | Native API |
| --- | --- |
| `NormalizeTtsMessageOptions` | `utils::tts::NormalizeTtsMessageOptions` |
| `NormalizeTtsMessageResult` | `utils::tts::NormalizeTtsMessageResult` (UTF-8 input), `NormalizeTtsMessageResultJs` (lossless input and original text) |
| `normalizeTtsMessage` | `normalize_tts_message`, `normalize_tts_message_js` |
| `buildSpokenUserMessage` | `build_spoken_user_message`, `build_spoken_user_message_js`; `TtsLanguage` and `SpeechSource` represent the source unions |
| `extractEmoteNames` | `extract_emote_names`, `extract_emote_names_js`; supplied groups preserve property and entry order |
| `filterExpressiveTtsTags` re-export | `filter_expressive_tts_tags`, `filter_expressive_tts_tags_js` |
| `filterPetTalkText` | `pet_speech_text::filter_pet_talk_text` |

For pet composition, pass the effective `TtsProvider` selected after credit
fallback. Build `NormalizeTtsMessageOptions` from the effective channel filters
and pass emote names through the options. The expressive-tag argument is the
raw JSON value at `filters.expressiveTags`, for example
`settings.get("filters").and_then(|filters| filters.get("expressiveTags"))`.
Pass that value as supplied by the caller. The helper itself does not normalize
it or insert schema defaults: `filterPetTalkText` forwards it directly as
`enabledTags`, and the native raw JSON adapter enables a tag only when its value
is the JSON boolean `true`. A caller may supply already normalized settings.
Missing, null, primitive, malformed-shape, and non-boolean values therefore do
not enable tags. The schema-normalization API remains a separate operation.

The returned original text is the text after expressive-tag filtering, matching
the source helper's composition order. The current source runtime's settings
and emote lookup, cancellation/revision handling, phases, persistence, billing,
and final spoken text remain open application-adapter/runtime work. See the
[lossless normalization migration note](../../../migration-notes/tts-lossless-normalization-2026-10-29.md)
for source mapping and verification scope.
