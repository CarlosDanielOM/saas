import { Schema, model } from 'mongoose';
import { FISH_VOICES } from '../server/services/tts/fish_tts.service.js';
import { ChannelTtsSettingsSchema } from './channel_tts_settings.schema.js';

export interface FishVoiceFavorite {
    id: string;
    name: string;
    alias: string;
}

interface ChannelFishVoiceFavorites {
    channelID: string;
    favorites: FishVoiceFavorite[];
}

export const MAX_FISH_VOICE_FAVORITES = 20;

export class FavoriteAliasError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
}

export function normalizeFavoriteAlias(value: unknown): string {
    if (typeof value !== 'string') {
        throw new FavoriteAliasError(400, 'invalid_alias', 'Nickname must use 1–40 letters, numbers, or underscores and start with a letter.');
    }
    const alias = value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(alias)) {
        throw new FavoriteAliasError(400, 'invalid_alias', 'Nickname must use 1–40 letters, numbers, or underscores and start with a letter.');
    }
    if (Object.hasOwn(FISH_VOICES, alias)) {
        throw new FavoriteAliasError(409, 'alias_taken', 'That nickname is reserved for a built-in voice.');
    }
    return alias;
}

const favoriteSchema = new Schema<FishVoiceFavorite>({
    id: { type: String, required: true },
    name: { type: String, required: true },
    alias: { type: String, required: true }
}, { _id: false });

const schema = new Schema<ChannelFishVoiceFavorites>({
    channelID: { type: String, required: true, unique: true },
    favorites: { type: [favoriteSchema], default: [] }
});

export const ChannelFishVoiceFavoritesSchema = model<ChannelFishVoiceFavorites>('channel_fish_voice_favorites', schema);

export async function getFishVoiceFavorites(channelID: string): Promise<FishVoiceFavorite[]> {
    const document = await ChannelFishVoiceFavoritesSchema.findOne({ channelID }).lean();
    return document?.favorites ?? [];
}

export function makeFavoriteAlias(name: string, usedAliases: Iterable<string>): string {
    const base = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'voice';
    const used = new Set([...usedAliases, ...Object.keys(FISH_VOICES)]);
    let alias = base;
    for (let suffix = 2; used.has(alias); suffix++) alias = `${base}_${suffix}`;
    return alias;
}

export async function addFishVoiceFavorite(channelID: string, id: string, name: string): Promise<FishVoiceFavorite> {
    await ChannelFishVoiceFavoritesSchema.updateOne({ channelID }, { $setOnInsert: { channelID, favorites: [] } }, { upsert: true });
    for (let attempt = 0; attempt <= MAX_FISH_VOICE_FAVORITES; attempt++) {
        const favorites = await getFishVoiceFavorites(channelID);
        const existing = favorites.find(favorite => favorite.id === id);
        if (existing) return existing;
        if (favorites.length >= MAX_FISH_VOICE_FAVORITES) throw new Error('favorites_full');
        const alias = makeFavoriteAlias(name, favorites.map(favorite => favorite.alias));
        const favorite = { id, name, alias };
        const updated = await ChannelFishVoiceFavoritesSchema.findOneAndUpdate({
            channelID,
            'favorites.id': { $ne: id },
            'favorites.alias': { $ne: alias },
            $expr: { $lt: [{ $size: '$favorites' }, MAX_FISH_VOICE_FAVORITES] }
        }, { $push: { favorites: favorite } }, { new: true });
        if (updated) return favorite;
    }
    throw new Error('favorites_conflict');
}

export async function removeFishVoiceFavorite(channelID: string, id: string): Promise<void> {
    await ChannelFishVoiceFavoritesSchema.updateOne({ channelID }, { $pull: { favorites: { id } } });
}

export async function renameFishVoiceFavorite(channelID: string, id: string, value: unknown): Promise<FishVoiceFavorite> {
    const alias = normalizeFavoriteAlias(value);
    const favorites = await getFishVoiceFavorites(channelID);
    const existing = favorites.find(favorite => favorite.id === id);
    if (!existing) throw new FavoriteAliasError(404, 'favorite_not_found', 'Favorite voice not found on this account.');
    if (existing.alias === alias) return existing;

    // Older set.voice calls stored aliases as defaults. Move that setting to the
    // stable voice ID before changing the alias, so the selected voice keeps working.
    await ChannelTtsSettingsSchema.updateOne(
        { channelID, 'voices.cloneDefault': existing.alias },
        { $set: { 'voices.cloneDefault': id } }
    );

    const updated = await ChannelFishVoiceFavoritesSchema.findOneAndUpdate(
        { channelID, 'favorites.id': id, 'favorites.alias': { $ne: alias } },
        { $set: { 'favorites.$[target].alias': alias } },
        { arrayFilters: [{ 'target.id': id }], new: true }
    ).lean();
    if (!updated) {
        const current = await getFishVoiceFavorites(channelID);
        const now = current.find(favorite => favorite.id === id);
        if (!now) throw new FavoriteAliasError(404, 'favorite_not_found', 'Favorite voice not found on this account.');
        if (now.alias === alias) return now;
        throw new FavoriteAliasError(409, 'alias_taken', 'That nickname is already used by another favorite voice.');
    }
    return updated.favorites.find(favorite => favorite.id === id)!;
}
