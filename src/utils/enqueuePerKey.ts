/**
 * Run `task` after every earlier task enqueued under the same key has settled.
 * A failing task never blocks the next one. The map entry is removed once the
 * latest task for the key settles, so keys do not leak.
 */
export function enqueuePerKey(
    chains: Map<string, Promise<void>>,
    key: string,
    task: () => Promise<void>,
): Promise<void> {
    const prev = chains.get(key) || Promise.resolve();
    const tail: Promise<void> = prev.then(async () => {
        try { await task(); } catch { /* one failed task must not break the chain */ }
    }).then(() => {
        if (chains.get(key) === tail) chains.delete(key);
    });
    chains.set(key, tail);
    return tail;
}
