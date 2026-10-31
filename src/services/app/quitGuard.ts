export function createQuitGuard(deps: {
    drain: () => Promise<boolean>;
    onReady: () => void;
    onBlocked: () => void;
}): () => Promise<boolean> {
    let ready = false;
    let pending: Promise<boolean> | null = null;
    return () => {
        if (ready) return Promise.resolve(true);
        if (pending) return pending;
        pending = (async () => {
            let drained = false;
            try { drained = await deps.drain(); } catch { /* Keep the DB open on failed cleanup. */ }
            if (drained) {
                ready = true;
                deps.onReady();
            } else {
                deps.onBlocked();
            }
            return drained;
        })().finally(() => { pending = null; });
        return pending;
    };
}
