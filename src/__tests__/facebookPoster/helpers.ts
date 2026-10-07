import Database from 'better-sqlite3';
import type { SqlDatabase } from '../../services/facebookPoster/FacebookPosterStore';

/** In-memory SQLite adapter for FacebookPosterStore tests. */
export function memoryDb(): SqlDatabase {
  const db = new Database(':memory:');
  return {
    exec: (sql) => { db.exec(sql); },
    run: (sql, p = []) => { db.prepare(sql).run(...p); },
    runInsert: (sql, p = []) => Number(db.prepare(sql).run(...p).lastInsertRowid),
    transaction: (fn) => db.transaction(fn)(),
    // Spread: .all() trả mảng của realm Node; jest chạy test trong realm khác nên deepStrictEqual sẽ báo lệch prototype.
    query: (sql, p = []) => [...db.prepare(sql).all(...p)] as any,
    // Giống DatabaseService.queryOne: không có dòng thì trả undefined.
    queryOne: (sql, p = []) => db.prepare(sql).get(...p) as any,
  };
}

/** Runs `run` with jest fake timers, ticking 5 s at a time until it settles (max 500 ticks), like FB Poster's runWithFakeTimers. */
export async function runWithFakeTimers<T>(run: () => Promise<T>): Promise<T> {
    jest.useFakeTimers();
    try {
        const promise = run();
        let settled = false;
        promise.then(() => { settled = true; }, () => { settled = true; });
        for (let i = 0; i < 500 && !settled; i++) {
            await jest.advanceTimersByTimeAsync(5000);
        }
        return await promise;
    } finally {
        jest.useRealTimers();
    }
}

/** Fake Playwright locator registry: records which data-maihub-target values were clicked. */
export function fakeLocators(clicked: string[]) {
    return (selector: string) => ({
        first: () => ({
            click: async () => {
                const m = /data-maihub-target="([^"]+)"/.exec(selector);
                clicked.push(m ? m[1] : selector);
            },
        }),
    });
}
