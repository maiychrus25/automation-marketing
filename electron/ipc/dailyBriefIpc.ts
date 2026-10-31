import DatabaseService from '../../src/services/database/DatabaseService';
import { DailyBriefStore } from '../../src/services/dailyBrief/DailyBriefStore';
import { PageBusinessStore } from '../../src/services/dailyBrief/PageBusinessStore';
import { PageWorkStore } from '../../src/services/dailyBrief/PageWorkStore';
import { createBriefOperations } from '../../src/services/dailyBrief/briefOperations';
import { buildBriefFinished, emitControlEvent } from '../../src/services/control/controlEvents';
import { learnPages } from './facebookPosterIpc';

const preparedDbPaths = new Set<string>();

/** Store của workspace đang mở; schema chỉ chuẩn bị một lần cho mỗi đường dẫn DB. */
export function getDailyBriefStore(): DailyBriefStore {
    const db = DatabaseService.getInstance();
    const store = new DailyBriefStore(db);
    const dbPath = db.getDbPath();
    if (!preparedDbPaths.has(dbPath)) {
        store.ensureSchema();
        preparedDbPaths.add(dbPath);
    }
    return store;
}

const preparedBusinessPaths = new Set<string>();
const preparedWorkPaths = new Set<string>();
export function getPageBusinessStore(): PageBusinessStore {
    const db = DatabaseService.getInstance(); const store = new PageBusinessStore(db); const file = db.getDbPath();
    if (!preparedBusinessPaths.has(file)) { getDailyBriefStore(); store.ensureSchema(); preparedBusinessPaths.add(file); }
    return store;
}
export function getPageWorkStore(): PageWorkStore {
    const db = DatabaseService.getInstance(); const store = new PageWorkStore(db); const file = db.getDbPath();
    if (!preparedWorkPaths.has(file)) { getPageBusinessStore(); store.ensureSchema(); preparedWorkPaths.add(file); }
    return store;
}

export const briefOperations = createBriefOperations({
    store: getDailyBriefStore,
    now: Date.now,
    profileExists: (id) => !!DatabaseService.getInstance().getBrowserProfileById(id),
    emitFinished: (payload) => emitControlEvent('briefs.finished', buildBriefFinished(payload)),
});

export const pageOperations = {
    learn: (p: { profileIds?: string[] | null; force?: boolean } = {}, assertCurrent?: () => void) => {
        if (p.force !== undefined && typeof p.force !== 'boolean') throw new Error('force phải là boolean');
        const { jobId } = learnPages(p.profileIds ?? null, p.force ?? false, assertCurrent);
        return { jobId };
    },
    list: () => ({ identities: getDailyBriefStore().listIdentities() }),
};
