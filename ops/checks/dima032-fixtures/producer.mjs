// Separate real packaged admission/AST producer. Never starts the API/provider runtime.
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString());
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const mongo = await getMongoDBConnection('dima032-producer');
const { petPeers } = await import('/app/dist/pets/peers.js');
if (input.now !== undefined) { if (!Number.isSafeInteger(input.now)) throw new Error('Invalid fixture clock'); Date.now = () => input.now; }
let result;
try {
    if (input.streamEnd) {
        if (!/^\d{1,30}$/.test(input.channelId)) throw new Error('Invalid fixture channel');
        const { applyStreamOperationsDomainEvent } = await import('/app/dist/domain_events/stream_operations_events.js');
        const { clearSpeechFiles, TTS_SESSION_ENDED } = await import('/app/dist/utils/speech.js');
        if (input.dropHint || input.holdHint) {
            const { pubSubManager } = await import('/app/dist/classes/pubsub_manager.class.js');
            const publish = pubSubManager.publish.bind(pubSubManager);
            pubSubManager.publish = async (topic, body) => {
                if (topic === TTS_SESSION_ENDED) {
                    if (input.dropHint) return;
                    const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
                    const cache = await getDragonflyClient('dima032-producer-hint');
                    await cache.set('dima032:test:entered:session-publish', 'true', { EX: 60 });
                    while (await cache.get('dima032:test:hold:session-publish')) await new Promise(resolve => setTimeout(resolve, 10));
                }
                return publish(topic, body);
            };
        }
        const noop = async () => {};
        // Only unrelated Twitch/role/timer effects are inert. The changed consumer,
        // Redis deletion/marker and cross-process PubSub publication are actual code.
        await applyStreamOperationsDomainEvent({ type: 'stream.ended', source: 'twitch-eventsub', channelID: input.channelId,
            payload: { event: {} } }, { hasNewerLifecycleEvent: async () => false, unloadChannelTimersFromCache: noop,
            resetRedemptionCost: async () => ({}), resetSumimetro: noop, clearChannelCache: noop, clearSpeechFiles,
            clearHistory: noop, loadChannelTimersIntoCache: noop, getChannelEditors: async () => ({}),
            loadChannelAdminsIntoCache: noop, unVIPExpiredUser: async () => ({}) });
        result = { ok: true };
    } else if (input.ast) {
        const { registerPetFunctions } = await import('/app/dist/utils/ast_parser/functions/pet.functions.js');
        const { createExecutionContext, evaluate } = await import('/app/dist/utils/ast_parser/evaluator.js');
        const { parse } = await import('/app/dist/utils/ast_parser/parser.js');
        const { createTwitchEffectContext, scopeAstEffectContext } = await import('/app/dist/utils/ast_parser/effects.js');
        registerPetFunctions();
        const authority = createTwitchEffectContext(input.action);
        const context = createExecutionContext({ broadcasterId: input.action.channelId, userPlan: 'premium', userLevel: 10,
            platform: 'twitch', enforceFunctionPermissions: false, authorization: { origin: 'authored' },
            effectContext: scopeAstEffectContext(authority, input.action.channelId, 'dima032:fixture') });
        const evaluated = await evaluate(parse(`$(pet.talk ${input.action.text})`).ast, context);
        result = { value: evaluated.value };
    } else {
        const { admitPetAction } = await import('/app/dist/pets/admission.js');
        result = await admitPetAction(input.action);
    }
} catch (error) { result = { error: error.code || String(error) }; }
console.log('DIMA032_PRODUCER:' + JSON.stringify({ result, pid: process.pid, peers: petPeers.size }));
await mongo.connection.close(); process.exit(0);
