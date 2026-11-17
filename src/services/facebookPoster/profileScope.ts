/** Profile scope rules for the Facebook poster when an employee works through the relay (pure, no imports). */

export const PROFILE_SCOPE_PARAM = '_profileScope';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Raw profile references of a `start` request, whatever their type: callers that must reject malformed ones look at these. */
export function startProfileRefs(kind: unknown, params: unknown): unknown[] {
  if (!isRecord(params)) return [];
  if (kind === 'post') return Array.isArray(params.profiles) ? params.profiles.map((p) => (isRecord(p) ? p.profileId : undefined)) : [];
  if (kind === 'scan_groups') return Array.isArray(params.profileIds) ? params.profileIds : [];
  if (kind === 'join' || kind === 'collect_comments') return params.profileId === undefined ? [] : [params.profileId];
  return [];
}

/** Profiles of a stored schedule or run (`params_json` string or parsed object). */
export function profileIdsOfStoredParams(paramsJson: unknown): string[] {
  let value = paramsJson;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!isRecord(value)) return [];
  const ids = new Set<string>();
  const add = (v: unknown) => { if (typeof v === 'string' && v !== '') ids.add(v); };
  if (Array.isArray(value.profiles)) for (const p of value.profiles) if (isRecord(p)) add(p.profileId);
  if (Array.isArray(value.profileIds)) value.profileIds.forEach(add);
  add(value.profileId);
  return [...ids];
}

/** `scope` undefined = no limit (the boss). A record with no profile is not within any scope. */
export function isWithinScope(profileIds: readonly string[], scope: readonly string[] | undefined): boolean {
  if (scope === undefined) return true;
  return profileIds.length > 0 && profileIds.every((id) => scope.includes(id));
}

/** Only the relay may set a scope: a value without `_fromRelay === true` is ignored. */
export function readProfileScope(params: unknown): string[] | undefined {
  if (!isRecord(params) || params._fromRelay !== true) return undefined;
  const scope = params[PROFILE_SCOPE_PARAM];
  return Array.isArray(scope) && scope.every((v) => typeof v === 'string') ? [...scope] : undefined;
}
