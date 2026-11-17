import { mergeTempAttachments } from '../../ui/lib/chat/mergeTempAttachments';

const j = (v: unknown) => JSON.stringify(v);

describe('mergeTempAttachments', () => {
    test('keepsTheRealLocalPathOverTheTempOne', () => {
        const out = mergeTempAttachments(j([{ localPath: '/employee/tmp.png' }]), j([{ localPath: 'page-1/real.png' }]));
        expect(JSON.parse(out!)).toEqual([{ localPath: 'page-1/real.png' }]);
    });
    test('usesTheTempPathWhenTheRealOneHasNone_forEveryIndex', () => {
        const out = mergeTempAttachments(j([{ localPath: '/t/a.png' }, { localPath: '/t/b.png' }]), j([{ type: 'image' }, { type: 'image', localPath: 'real/b.png' }, { type: 'image' }]));
        expect(JSON.parse(out!)).toEqual([{ type: 'image', localPath: '/t/a.png' }, { type: 'image', localPath: 'real/b.png' }, { type: 'image' }]);
    });
    test('differentLengthsOrBadJsonNeverThrow', () => {
        expect(mergeTempAttachments(j([]), j([{ a: 1 }]))).toBe(j([{ a: 1 }]));
        expect(mergeTempAttachments(j([{ localPath: 'x' }]), j([]))).toBe(j([]));
        expect(mergeTempAttachments('not json', '[{"a":1}]')).toBe('[{"a":1}]');
        expect(mergeTempAttachments(undefined, undefined)).toBeUndefined();
    });
});
