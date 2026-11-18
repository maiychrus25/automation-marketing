/**
 * Facebook poster commands an employee sends through the relay: which browser profiles and records the command may touch (pure).
 * The relay calls `checkPosterRequest` for every `proxy` poster channel, with the profiles the boss assigned to the employee (`allowed`).
 * Default-deny: a reference that cannot be tied to the employee's profiles is refused; ids are compared as exact strings.
 */

import { POSTER_CHANNEL_ROUTES } from './employeeChannelRoutes';
import { PROFILE_SCOPE_PARAM, RELAY_EMPLOYEE_PARAM, isWithinScope, startProfileRefs } from '../facebookPoster/profileScope';

/** `null` = no such record (the boss-side handler reports "not found"). */
export interface PosterLookup {
    scheduleProfiles(id: string): string[] | null;
    runProfiles(id: string): string[] | null;
    campaignProfiles(id: string): string[] | null;
    leadProfiles(id: string): string[] | null;
    /** Tracked post URLs of these profiles, newest first (the default fill of commentCollect keeps the first MAX_COLLECT_POST_URLS). */
    trackedPostUrls(profileIds: readonly string[]): string[];
}

export type PosterCheck =
    | { ok: true; params: Record<string, unknown> }
    | { ok: false; code: 'PROFILE_FORBIDDEN' | 'RECORD_FORBIDDEN' | 'PARAMS_INVALID' };

/** Mirrors MAX_COLLECT_POST_URLS in electron/ipc/facebookPosterIpc.ts (commentCollect refuses more URLs); a test keeps the two equal. */
export const MAX_COLLECT_POST_URLS = 50;
/** Most profile references one request may carry (profileId, profileIds and the post's profiles together); a longer list is refused before any lookup. */
export const MAX_PROFILE_REFS = 200;
/** Equals MAX_PROFILE_IDS in src/services/research/ResearchService.ts (checkProfileIds), a cap only trackPosts applies (it refuses more); checkLogins and listGroups use it as their default of the first 50 allowed profiles. A test keeps the two equal. */
export const MAX_PROFILE_IDS = 50;
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];

const INVALID: PosterCheck = { ok: false, code: 'PARAMS_INVALID' };
const PROFILE_FORBIDDEN: PosterCheck = { ok: false, code: 'PROFILE_FORBIDDEN' };
const RECORD_FORBIDDEN: PosterCheck = { ok: false, code: 'RECORD_FORBIDDEN' };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isProfileRef = (v: unknown): v is string => typeof v === 'string' && v !== '' && v === v.trim();
/** Record ids: a string or a finite number, looked up as a string. */
const recordKey = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);

/** Commands that carry post params in `params.params` (the outer `kind` of schedules is once/recurring, never a start kind). */
const POST_PARAMS_CHANNELS = new Set(['facebookPoster:scheduleCreate', 'facebookPoster:draftSave']);
const SCHEDULE_ID_CHANNELS = new Set(['facebookPoster:scheduleUpdate', 'facebookPoster:scheduleDelete', 'facebookPoster:draftGet', 'facebookPoster:draftApprove']);
const RUN_ID_CHANNELS = new Set(['facebookPoster:getRun', 'facebookPoster:cancel']);
const CAMPAIGN_ID_CHANNELS = new Set(['facebookPoster:campaignGet', 'facebookPoster:campaignUpdate', 'facebookPoster:campaignDelete']);
/** "Every profile" when no profile is named becomes the employee's own profiles. */
const DEFAULT_ALL_PROFILES = new Set(['facebookPoster:checkLogins', 'facebookPoster:trackPosts', 'facebookPoster:listGroups']);

export function checkPosterRequest(channel: string, params: unknown, allowed: readonly string[], lookup: PosterLookup): PosterCheck {
    if (!Object.prototype.hasOwnProperty.call(POSTER_CHANNEL_ROUTES, channel) || POSTER_CHANNEL_ROUTES[channel].route !== 'proxy') return INVALID;
    if (allowed.length === 0 && channel !== 'browserProfile:list') return PROFILE_FORBIDDEN;
    if (params !== undefined && params !== null && !isRecord(params)) return INVALID;
    const out: Record<string, unknown> = { ...(params as Record<string, unknown> | undefined) };
    delete out[PROFILE_SCOPE_PARAM];
    delete out._fromRelay;
    delete out[RELAY_EMPLOYEE_PARAM];
    for (const key of UNSAFE_KEYS) delete out[key];
    if (isRecord(out.params)) {
        out.params = { ...out.params };
        // draftSave stores every key of the post params, so the relay keys must not survive in the nested object either.
        for (const key of [...UNSAFE_KEYS, PROFILE_SCOPE_PARAM, RELAY_EMPLOYEE_PARAM, '_fromRelay']) delete (out.params as Record<string, unknown>)[key];
    }

    // Rule 2: profile references, shape first and then membership.
    const refs: unknown[] = [];
    if (out.profileId !== undefined) refs.push(out.profileId);
    if (out.profileIds !== undefined) {
        if (!Array.isArray(out.profileIds)) return INVALID;
        refs.push(...out.profileIds);
    }
    const inner = isRecord(out.params) ? out.params : undefined;
    const postBased = channel === 'facebookPoster:start' || POST_PARAMS_CHANNELS.has(channel);
    if (postBased) {
        const innerRefs = startProfileRefs(channel === 'facebookPoster:start' ? out.kind : 'post', out.params);
        if (innerRefs.length === 0) return PROFILE_FORBIDDEN;
        refs.push(...innerRefs);
    }
    if (refs.length > MAX_PROFILE_REFS) return INVALID;
    if (!refs.every(isProfileRef)) return INVALID;
    if (!(refs as string[]).every((id) => allowed.includes(id))) return PROFILE_FORBIDDEN;

    // Rule 3: records by id.
    const records: Array<{ id: unknown; profiles: (id: string) => string[] | null; campaign: boolean; mustExist?: boolean }> = [];
    const lookups = {
        schedule: (id: string) => lookup.scheduleProfiles(id), run: (id: string) => lookup.runProfiles(id),
        campaign: (id: string) => lookup.campaignProfiles(id), lead: (id: string) => lookup.leadProfiles(id),
    };
    // scheduleDelete also removes a media folder named by the id: an id the database does not know must not reach it.
    if (SCHEDULE_ID_CHANNELS.has(channel)) records.push({ id: out.id, profiles: lookups.schedule, campaign: false, mustExist: channel === 'facebookPoster:scheduleDelete' });
    if (channel === 'facebookPoster:draftSave' && out.id !== undefined) records.push({ id: out.id, profiles: lookups.schedule, campaign: false });
    // `cancel` acts on in-memory state, so a run the database does not know must not reach the handler (for the other channels "not found" is harmless).
    if (RUN_ID_CHANNELS.has(channel)) records.push({ id: out.runId, profiles: lookups.run, campaign: false, mustExist: channel === 'facebookPoster:cancel' });
    if (CAMPAIGN_ID_CHANNELS.has(channel)) records.push({ id: out.id, profiles: lookups.campaign, campaign: true });
    if (channel === 'facebookPoster:leadUpdate') records.push({ id: out.id, profiles: lookups.lead, campaign: false });
    // A campaign or schedule named as a filter or as a link, at the top level or inside the post params; null/undefined = none.
    for (const holder of [out, inner]) {
        if (holder?.campaignId !== undefined && holder.campaignId !== null) records.push({ id: holder.campaignId, profiles: lookups.campaign, campaign: true });
    }
    if (out.scheduleId !== undefined && out.scheduleId !== null) records.push({ id: out.scheduleId, profiles: lookups.schedule, campaign: false });

    for (const rec of records) {
        const key = recordKey(rec.id);
        if (key === null) return INVALID;
        const profiles = rec.profiles(key);
        if (profiles === null) {
            if (rec.mustExist) return RECORD_FORBIDDEN;
            continue;
        }
        const within = rec.campaign ? profiles.every((id) => allowed.includes(id)) : isWithinScope(profiles, allowed);
        if (!within) return RECORD_FORBIDDEN;
    }

    // Rule 5: defaults in place of "every profile".
    if (DEFAULT_ALL_PROFILES.has(channel) && (!Array.isArray(out.profileIds) || out.profileIds.length === 0)) out.profileIds = allowed.slice(0, MAX_PROFILE_IDS);
    if (channel === 'facebookPoster:commentCollect') {
        if (Array.isArray(out.postUrls) && out.postUrls.length > MAX_COLLECT_POST_URLS) return INVALID;
        const tracked = lookup.trackedPostUrls(allowed);
        let urls = tracked.slice(0, MAX_COLLECT_POST_URLS);
        if (out.postUrls !== undefined) {
            if (!Array.isArray(out.postUrls)) return INVALID;
            urls = out.postUrls.filter((u): u is string => typeof u === 'string' && tracked.includes(u));
        }
        if (urls.length === 0 || urls.length > MAX_COLLECT_POST_URLS) return INVALID;
        out.postUrls = [...urls];
    }

    // A `pageId` (pageMetrics) passes through unchanged: the boss handler scopes the page by `_profileScope`.
    out[PROFILE_SCOPE_PARAM] = [...allowed];
    return { ok: true, params: out };
}

/** The employee's view of `browserProfile:list`: only assigned profiles (id, name, group_id, note), only their groups (id, name), only their running ids. */
export function filterBrowserProfileList(result: unknown, allowed: readonly string[]): unknown {
    if (!isRecord(result) || !Array.isArray(result.profiles)) return { profiles: [], groups: [], runningIds: [] };
    const profiles = result.profiles
        .filter((p): p is Record<string, unknown> => isRecord(p) && typeof p.id === 'string' && allowed.includes(p.id))
        .map((p) => ({ id: p.id, name: p.name, group_id: p.group_id, note: p.note }));
    const groupIds = new Set(profiles.map((p) => p.group_id));
    return {
        ...(result.success !== undefined ? { success: result.success } : {}),
        profiles,
        groups: Array.isArray(result.groups)
            ? result.groups.filter((g): g is Record<string, unknown> => isRecord(g) && groupIds.has(g.id)).map((g) => ({ id: g.id, name: g.name }))
            : [],
        runningIds: Array.isArray(result.runningIds) ? result.runningIds.filter((id) => typeof id === 'string' && allowed.includes(id)) : [],
    };
}

const REF_PATTERN = /^[\w.:-]{1,80}$/;

/** Record id for the boss log line of a successful poster write: from the checked params, else from what the handler returned; '-' when there is none. Never text, paths or URLs. */
export function posterActionRef(params: unknown, result: unknown): string {
    const pick = (value: unknown): string | null => {
        const text = typeof value === 'number' ? String(value) : value;
        return typeof text === 'string' && REF_PATTERN.test(text) ? text : null;
    };
    const p = isRecord(params) ? params : {};
    const r = isRecord(result) ? result : {};
    const nested = (key: string) => (isRecord(r[key]) ? (r[key] as Record<string, unknown>).id : undefined);
    for (const value of [p.id, p.scheduleId, p.campaignId, p.runId, nested('schedule'), nested('campaign'), r.runId, nested('run'), r.id]) {
        const ref = pick(value);
        if (ref) return ref;
    }
    return '-';
}
