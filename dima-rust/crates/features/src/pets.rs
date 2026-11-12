//! Pets without sockets: admission of `pet.talk` and `pet.ask` with plan and queue limits, state,
//! readiness, moods, peers, tokens, the TTS bridge and lane, wakeups, and the settings and admin
//! diagnostics services. Package **P4-FEAT-PETS** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `pets/admission.ts` (174 lines): `admitPetAction`
//! - `pets/delivery.ts` (37 lines): `beginPetSnapshot`, `emitPetReadyAndPlay`, `emitPetSnapshot`
//! - `pets/diagnostics.ts` (47 lines): `petDiagnostic`
//! - `pets/mood_decoration.ts` (19 lines): `prefetchMoodCueSettings`, `safelyBuildMoodInstruction`,
//!   `safelyFilterMoodCues`, `safelyResolveMood`
//! - `pets/mood_warnings.ts` (23 lines): `warnPetMood`
//! - `pets/moods.ts` (89 lines): `MOOD_NAMES`, `activeMoodImages`, `moodImageLimit`,
//!   `moodImageSlots`, `moodInstruction`, `resolvePetMood`, `savedPetMoods`
//! - `pets/peers.ts` (44 lines): `desktopCandidates`, `petPeers`, `selectedVtsController`
//! - `pets/queue.ts` (78 lines): `claimQueued`, `nextIndependentQueued`
//! - `pets/queue_limits.ts` (5 lines)
//! - `pets/readiness.schema.ts` (11 lines)
//! - `pets/readiness.ts` (78 lines): `initializePetReadiness`, `refreshPetReadiness`,
//!   `stopPetReadiness`
//! - `pets/selection.ts` (23 lines): `selectOwnPetPlayback`
//! - `pets/speech_text.ts` (15 lines): `filterPetTalkText`, `refilterDesktopPetText`
//! - `pets/state.ts` (109 lines): `LEASE_TTL_MS`, `PetError`, `cancelPetRequest`, `finishRequest`,
//!   `invalidatePet`, `notifyPet`, `requestView`, `runtimeFor`
//! - `pets/tokens.ts` (70 lines): `authenticatePetCapability`, `authorizePetAudio`,
//!   `issueAudioTicket`, `petOverlayToken`
//! - `pets/tts_bridge.ts` (57 lines): `hasReadTtsTurn`, `isReadTtsConfigured`,
//!   `observeReadTtsRuntime`, `parkReadTts`, `prepareReadTts`, `protectReadTtsTurn`,
//!   `readTtsAvailable`, `readTtsOwners`, `readTtsQueueChannels`, `readTtsTurnCurrent`,
//!   `registerReadTtsBridge`, `releaseReadTts`, `reportReadTts`, `reserveReadTts`,
//!   `scheduleReadTtsResume`
//! - `pets/tts_lane.ts` (44 lines): `endPetLaneTurn`, `petLaneItem`, `registerPetLaneBridge`,
//!   `startPetLaneTurn`
//! - `pets/wakeups.ts` (52 lines): `subscribePetWakeups`
//! - `server/services/pet_settings.service.ts` (196 lines): `PetSettingsError`,
//!   `getPetConfiguration`, `requirePetPlan`, `savePetConfiguration`
//! - `server/services/admin_pet_diagnostics.service.ts` (63 lines): `getAdminPetDiagnostics`
//!
//! The pet runtime and its sockets are `dima-realtime::pets` (P4-RT-PETS).
