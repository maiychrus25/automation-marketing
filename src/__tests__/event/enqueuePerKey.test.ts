import { enqueuePerKey } from '../../utils/enqueuePerKey';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('enqueuePerKey', () => {
    it('runs same-key tasks in order even when the first is slower', async () => {
        const chains = new Map<string, Promise<void>>();
        const order: string[] = [];
        enqueuePerKey(chains, 'g', async () => { await sleep(30); order.push('A'); });
        const last = enqueuePerKey(chains, 'g', async () => { order.push('B'); });
        await last;
        expect(order).toEqual(['A', 'B']);
    });

    it('runs different keys independently', async () => {
        const chains = new Map<string, Promise<void>>();
        const order: string[] = [];
        const a = enqueuePerKey(chains, 'g1', async () => { await sleep(30); order.push('A'); });
        const b = enqueuePerKey(chains, 'g2', async () => { order.push('B'); });
        await Promise.all([a, b]);
        expect(order).toEqual(['B', 'A']);
    });

    it('does not block the next task after a throw', async () => {
        const chains = new Map<string, Promise<void>>();
        const order: string[] = [];
        enqueuePerKey(chains, 'g', async () => { throw new Error('boom'); });
        await enqueuePerKey(chains, 'g', async () => { order.push('B'); });
        expect(order).toEqual(['B']);
    });

    it('leaves the map empty after all tasks settle', async () => {
        const chains = new Map<string, Promise<void>>();
        enqueuePerKey(chains, 'g', async () => { await sleep(5); });
        await enqueuePerKey(chains, 'g', async () => {});
        expect(chains.size).toBe(0);
    });
});
