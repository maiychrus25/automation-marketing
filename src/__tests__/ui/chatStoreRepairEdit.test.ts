import { applyMessageEdit } from '../../ui/lib/chat/applyMessageEdit';

describe('applyMessageEdit', () => {
  test('repairFillsContentWithoutEditedMark', () => {
    const r: any = applyMessageEdit({ content: 'x' } as any, 'Mới', 0, 5, false);
    expect(r.content).toBe('Mới');
    expect(r.is_edited).toBeUndefined();
    expect(r.edit_history).toBeUndefined();
  });
  test('repairKeepsExistingEditState', () => {
    const r: any = applyMessageEdit({ content: 'x', is_edited: 1, edit_history: '[{"oldBody":"a"}]' } as any, 'Mới', 0, 5, false);
    expect(r.is_edited).toBe(1);
    expect(r.edit_history).toBe('[{"oldBody":"a"}]');
  });
  test('realEditMarksAndKeepsHistory', () => {
    const r: any = applyMessageEdit({ content: 'Cũ' } as any, 'Mới', 1, 5);
    expect(r.content).toBe('Mới');
    expect(r.is_edited).toBe(1);
    expect(JSON.parse(r.edit_history)).toEqual([{ oldBody: 'Cũ', editedAt: 5, editCount: 1 }]);
  });
  test('sameContentIsUnchanged', () => {
    expect(applyMessageEdit({ content: 'Cũ' } as any, 'Cũ', 1, 5)).toBeNull();
    expect(applyMessageEdit({ content: 'Cũ' } as any, 'Cũ', 1, 5, false)).toBeNull();
  });
});
