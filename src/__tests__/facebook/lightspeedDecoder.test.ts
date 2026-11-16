import { decodeLightspeed } from '../../services/facebook/lightspeedDecoder';

const i64 = (v: string | number) => [19, String(v)];
const call = (name: string, ...args: unknown[]) => [5, name, ...args];

describe('decodeLightspeed', () => {
  test('nestedBlocksKeepCallOrderAndPlainValues', () => {
    const step = [1, [1, call('a', 'text', true, 7)], [1, [1, call('b')], call('c', false)]];
    expect(decodeLightspeed(step)).toEqual([
      { name: 'a', args: ['text', true, 7] },
      { name: 'b', args: [] },
      { name: 'c', args: [false] },
    ]);
  });

  // id hội thoại có thể vượt 2^53: phải giữ nguyên từng chữ số.
  test('sixtyFourBitNumbersStayExactStrings', () => {
    const [c] = decodeLightspeed(call('p', i64('9007199254740993123'), i64(-1), [9]));
    expect(c.args).toEqual(['9007199254740993123', '-1', null]);
  });

  // Hình dạng thật của một tin mới: kiểm tra-rồi-chèn. Việc "đã có chưa" để DB quyết định, nên nhánh chèn luôn chạy.
  test('theCheckThenInsertShapeOfALiveMessageRunsTheInsert', () => {
    const step = [1,
      [4, 0, 1, call('executeFirstBlockForSyncTransactionV4', i64(205))],
      [23, [2, 0], [1,
        [4, 1, 1, call('checkAuthoritativeMessageExists', i64(1), 'mid.$a')],
        [23, [26, [2, 1]], [1, [1, call('verifyThreadExists', i64(1))], [1, call('insertMessage', 'hi')]]],
        [1, call('upsertSequenceId', i64(5))],
      ]],
      [1, call('executeFinallyBlockForSyncTransaction')],
    ];
    expect(decodeLightspeed(step).map(c => c.name)).toEqual([
      'executeFirstBlockForSyncTransactionV4', 'checkAuthoritativeMessageExists', 'verifyThreadExists', 'insertMessage',
      'upsertSequenceId', 'executeFinallyBlockForSyncTransaction',
    ]);
  });

  test('aFalseConditionRunsTheElseBranchOnly', () => {
    const step = [1, [3, 0, i64(0)], [23, [2, 0], [1, call('then')], [1, call('else')]], [23, [2, 0], [1, call('thenOnly')]]];
    expect(decodeLightspeed(step).map(c => c.name)).toEqual(['else']);
  });

  test('storedValuesCanBeUsedAsArguments', () => {
    const step = [1, [3, 2, i64(42)], call('writeThreadCapabilities', [2, 2], 'x')];
    expect(decodeLightspeed(step)).toEqual([{ name: 'writeThreadCapabilities', args: ['42', 'x'] }]);
  });

  test('anUnknownStepIsReportedAndDoesNotStopTheRest', () => {
    const seen: number[] = [];
    const step = [1, call('before'), [99, 'whatever', [1, call('insideUnknown')]], call('after', [99, 1])];
    expect(decodeLightspeed(step, t => seen.push(t))).toEqual([{ name: 'before', args: [] }, { name: 'after', args: [null] }]);
    expect(seen).toEqual([99, 99]);
  });

  // Gặp trên hộp thư Page thật (26.38.0): bước 61 dựng một tham số phụ dạng chuỗi JSON. Không phải bước lạ cần báo.
  test('valueOnlyStepsAreIgnoredWithoutAReport', () => {
    const seen: number[] = [];
    expect(decodeLightspeed([1, call('p', [61, [53]], 'x')], t => seen.push(t))).toEqual([{ name: 'p', args: [null, 'x'] }]);
    expect(seen).toEqual([]);
  });

  test.each([[null], ['text'], [{}], [[]], [[5]], [[5, 42]]])('malformedInputGivesNoCalls_%#', (input) => {
    expect(decodeLightspeed(input)).toEqual([]);
  });
});
