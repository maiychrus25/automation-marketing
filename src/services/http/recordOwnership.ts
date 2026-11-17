/**
 * A record an employee addresses by its own id (label, quick message, campaign, tag, library item…)
 * must belong to an account the employee may use. Pure rules plus the one owner lookup:
 * no Electron, no fs; the database comes in through a minimal `queryOne` interface.
 *
 * Only rows whose handler uses the id WITHOUT also binding `WHERE <owner column> = <checked account>`
 * are listed here. Rows already constrained by their own SQL (crm_notes, bank_cards, drafts, the
 * quick-message delete…) are not: see the enumeration in the Task 8 report.
 */
import { splitPageIds } from './labelEventScope';

export interface RecordRef { table: string; idColumn: string; ownerColumn: string; id: string }

export type RecordTarget =
    | { kind: 'rest'; method: string; pathname: string; params: unknown }
    | { kind: 'proxy'; channel: string; params: unknown };

// The only (table, id column, owner column) triples the lookup may ever put in a SELECT.
const LABEL = { table: 'local_labels', idColumn: 'id', ownerColumn: 'page_ids' } as const;
const QUICK_MESSAGE = { table: 'local_quick_messages', idColumn: 'id', ownerColumn: 'owner_zalo_id' } as const;
const CAMPAIGN = { table: 'crm_campaigns', idColumn: 'id', ownerColumn: 'owner_zalo_id' } as const;
const CRM_TAG = { table: 'crm_tags', idColumn: 'id', ownerColumn: 'owner_zalo_id' } as const;
const LIBRARY_ITEM = { table: 'media_library_items', idColumn: 'uuid', ownerColumn: 'owner_zalo_id' } as const;
const LIBRARY_FOLDER = { table: 'media_library_folders', idColumn: 'id', ownerColumn: 'owner_zalo_id' } as const;
const KNOWN_COLUMNS = [LABEL, QUICK_MESSAGE, CAMPAIGN, CRM_TAG, LIBRARY_ITEM, LIBRARY_FOLDER];
// An empty owner list means "applies to every account" only for labels (page_ids = '').
const GLOBAL_WHEN_EMPTY_TABLES: ReadonlySet<string> = new Set([LABEL.table]);

const asObject = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

// The id exactly as the handler binds it into its SQL, so the lookup finds the row the handler would hit.
function rawId(value: unknown): string | null {
    return value === undefined || value === null || value === '' ? null : String(value);
}
// For routes whose handler does parseInt(value) || 0 first ("5abc" reaches the SQL as 5).
function intId(value: unknown): string | null {
    const n = parseInt(String(value));
    return n ? String(n) : null;
}
function refs(columns: typeof KNOWN_COLUMNS[number], ...ids: Array<string | null>): RecordRef[] {
    return ids.filter((id): id is string => id !== null).map((id) => ({ ...columns, id }));
}

const CAMPAIGN_BODY_ROUTES = new Set([
    '/api/command/crm/campaigns/clone',
    '/api/command/crm/campaigns/status',
    '/api/command/crm/campaigns/contacts',
    '/api/command/crm/campaigns/contacts/all',
    '/api/command/crm/campaigns/contacts/delete',
    '/api/query/crm/campaigns/contacts',
]);

function restRefs(method: string, pathname: string, params: Record<string, unknown>): RecordRef[] {
    let m = /^\/api\/command\/labels\/(\d+)(?:\/(?:active|order))?$/.exec(pathname);
    if (m) return refs(LABEL, m[1]);
    if (pathname === '/api/command/labels') return refs(LABEL, rawId(asObject(params.label).id));
    if ((m = /^\/api\/command\/quick-messages\/(\d+)\/(?:active|order)$/.exec(pathname))) return refs(QUICK_MESSAGE, m[1]);
    if ((m = /^\/api\/command\/crm\/campaigns\/(\d+)$/.exec(pathname))) return refs(CAMPAIGN, m[1]);
    if (CAMPAIGN_BODY_ROUTES.has(pathname)) return refs(CAMPAIGN, intId(params.campaignId));
    if ((m = /^\/api\/command\/crm\/tags\/(\d+)$/.exec(pathname))) return refs(CRM_TAG, m[1]);
    // References to another record in the body: the id is bound into the handler's SQL as given.
    if (pathname === '/api/command/crm/tags/assign') return refs(CRM_TAG, rawId(params.tagId));
    if (pathname === '/api/command/label-threads') return refs(LABEL, rawId(params.labelId));
    if (pathname === '/api/library/folders' && method === 'POST') return refs(LIBRARY_FOLDER, intId(params.parentId));
    if ((m = /^\/api\/library\/(?:item|file|thumb)\/([a-f0-9-]+)$/.exec(pathname))) {
        // PATCH reads the uuid from the body, not from the path.
        const itemRefs = refs(LIBRARY_ITEM, m[1], method === 'PATCH' ? rawId(params.uuid) : null);
        // PATCH can also move the item into a folder (handler does parseInt).
        return method === 'PATCH' ? [...itemRefs, ...refs(LIBRARY_FOLDER, intId(params.folderId))] : itemRefs;
    }
    if ((m = /^\/api\/library\/folders\/(\d+)$/.exec(pathname))) return refs(LIBRARY_FOLDER, m[1]);
    return [];
}

const PROXY_LABEL_BY_ID = new Set(['db:deleteLocalLabel', 'db:setLocalLabelActive', 'db:setLocalLabelOrder']);
const PROXY_QUICK_MESSAGE_BY_ID = new Set(['db:setLocalQMActive', 'db:setLocalQMOrder']);
const PROXY_LABEL_ON_THREAD = new Set(['db:assignLocalLabelToThread', 'db:removeLocalLabelFromThread']);
const PROXY_CAMPAIGN_BY_ID = new Set(['crm:deleteCampaign', 'crm:updateCampaignStatus']);

function proxyRefs(channel: string, params: Record<string, unknown>): RecordRef[] {
    const found: RecordRef[] = [];
    if (PROXY_LABEL_BY_ID.has(channel)) found.push(...refs(LABEL, rawId(params.id)));
    if (channel === 'db:upsertLocalLabel') found.push(...refs(LABEL, rawId(asObject(params.label).id)));
    if (PROXY_LABEL_ON_THREAD.has(channel)) found.push(...refs(LABEL, rawId(params.labelId)));
    if (channel === 'db:bulkAssignLocalLabelToThread' && Array.isArray(params.labelIds)) found.push(...refs(LABEL, ...[...new Set(params.labelIds.map(rawId))]));
    if (PROXY_QUICK_MESSAGE_BY_ID.has(channel)) found.push(...refs(QUICK_MESSAGE, rawId(params.id)));
    if (PROXY_CAMPAIGN_BY_ID.has(channel)) found.push(...refs(CAMPAIGN, rawId(params.campaignId)));
    // The relay turns these into boss file paths for any channel that has a handler.
    const uuids = [params._libraryUuid, ...(Array.isArray(params._libraryUuids) ? params._libraryUuids : [])];
    found.push(...refs(LIBRARY_ITEM, ...[...new Set(uuids.map(rawId))]));
    return found;
}

/** Records the request reads, changes or deletes by id and whose handler does not bind the owner itself. */
export function recordRefsFor(target: RecordTarget): RecordRef[] {
    const params = asObject(target.params);
    return target.kind === 'rest' ? restRefs(target.method, target.pathname, params) : proxyRefs(target.channel, params);
}

/**
 * `ownerValue`: one account id, a "a,b" string or an array (a label applies to several accounts).
 * True when EVERY id is allowed. Record not found (undefined) is true: the handler reports it missing.
 * An empty owner ('', null, no ids) is false: such a record has no account the employee could hold.
 */
export function isRecordAllowed(ownerValue: unknown, allowed: readonly string[]): boolean {
    if (ownerValue === undefined) return true;
    if (ownerValue === null) return false;
    const owners = typeof ownerValue === 'number' ? [String(ownerValue)] : splitPageIds(ownerValue);
    return owners.length > 0 && owners.every((id) => allowed.includes(id));
}

export interface OwnerLookupDb { queryOne(sql: string, params?: any[]): any }

/** The first record the employee may not use, or null. Fails closed: an unknown table or a failing lookup refuses. */
export function findForeignRecord(db: OwnerLookupDb, recordRefs: readonly RecordRef[], allowed: readonly string[]): RecordRef | null {
    for (const ref of recordRefs) {
        const known = KNOWN_COLUMNS.some((c) => c.table === ref.table && c.idColumn === ref.idColumn && c.ownerColumn === ref.ownerColumn);
        if (!known) return ref;
        try {
            const row: { owner: unknown } | undefined | null = db.queryOne(`SELECT ${ref.ownerColumn} AS owner FROM ${ref.table} WHERE ${ref.idColumn} = ?`, [ref.id]);
            if (!row) continue; // not found: the handler answers "not found"
            const global = GLOBAL_WHEN_EMPTY_TABLES.has(ref.table) && splitPageIds(row.owner).length === 0;
            if (!global && !isRecordAllowed(row.owner ?? null, allowed)) return ref;
        } catch {
            return ref;
        }
    }
    return null;
}
