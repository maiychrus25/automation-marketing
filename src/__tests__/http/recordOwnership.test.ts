import { findForeignRecord, isRecordAllowed, recordRefsFor, RecordRef } from '../../services/http/recordOwnership';

const LABEL = { table: 'local_labels', idColumn: 'id', ownerColumn: 'page_ids' };
const QM = { table: 'local_quick_messages', idColumn: 'id', ownerColumn: 'owner_zalo_id' };
const CAMPAIGN = { table: 'crm_campaigns', idColumn: 'id', ownerColumn: 'owner_zalo_id' };
const TAG = { table: 'crm_tags', idColumn: 'id', ownerColumn: 'owner_zalo_id' };
const ITEM = { table: 'media_library_items', idColumn: 'uuid', ownerColumn: 'owner_zalo_id' };
const FOLDER = { table: 'media_library_folders', idColumn: 'id', ownerColumn: 'owner_zalo_id' };

const rest = (method: string, pathname: string, params: unknown = {}) => recordRefsFor({ kind: 'rest', method, pathname, params });
const proxy = (channel: string, params: unknown = {}) => recordRefsFor({ kind: 'proxy', channel, params });

describe('isRecordAllowed', () => {
  test.each([
    ['a', ['a'], true],
    ['b', ['a'], false],
    ['a,b', ['a'], false],
    [['a'], ['a', 'b'], true],
    [undefined, ['a'], true],
    ['', ['a'], false],
    [null, [], false],
    [' a , b ', ['a', 'b'], true],
    [',', ['a'], false],
    [[], ['a'], false],
    ['a', [], false],
  ] as Array<[unknown, string[], boolean]>)('%j against %j is %s', (owner, allowed, expected) => {
    expect(isRecordAllowed(owner, allowed)).toBe(expected);
  });
});

describe('recordRefsFor lists the records a request names by id', () => {
  test.each([
    ['DELETE', '/api/command/labels/7', {}, [{ ...LABEL, id: '7' }]],
    ['PATCH', '/api/command/labels/7/active', {}, [{ ...LABEL, id: '7' }]],
    ['POST', '/api/command/labels/7/order', {}, [{ ...LABEL, id: '7' }]],
    ['POST', '/api/command/labels', { label: { id: 9, name: 'x' } }, [{ ...LABEL, id: '9' }]],
    ['POST', '/api/command/quick-messages/4/active', {}, [{ ...QM, id: '4' }]],
    ['POST', '/api/command/quick-messages/4/order', {}, [{ ...QM, id: '4' }]],
    ['DELETE', '/api/command/crm/campaigns/3', {}, [{ ...CAMPAIGN, id: '3' }]],
    ['POST', '/api/command/crm/campaigns/clone', { campaignId: '3' }, [{ ...CAMPAIGN, id: '3' }]],
    ['POST', '/api/command/crm/campaigns/status', { campaignId: 3 }, [{ ...CAMPAIGN, id: '3' }]],
    ['POST', '/api/command/crm/campaigns/contacts', { campaignId: 3 }, [{ ...CAMPAIGN, id: '3' }]],
    ['DELETE', '/api/command/crm/campaigns/contacts', { campaignId: 3 }, [{ ...CAMPAIGN, id: '3' }]],
    ['POST', '/api/command/crm/campaigns/contacts/all', { campaignId: 3 }, [{ ...CAMPAIGN, id: '3' }]],
    ['POST', '/api/command/crm/campaigns/contacts/delete', { campaignId: 3 }, [{ ...CAMPAIGN, id: '3' }]],
    ['GET', '/api/query/crm/campaigns/contacts', { campaignId: '3' }, [{ ...CAMPAIGN, id: '3' }]],
    ['DELETE', '/api/command/crm/tags/5', {}, [{ ...TAG, id: '5' }]],
    ['GET', '/api/library/item/ab-12', {}, [{ ...ITEM, id: 'ab-12' }]],
    ['DELETE', '/api/library/item/ab-12', {}, [{ ...ITEM, id: 'ab-12' }]],
    ['PATCH', '/api/library/item/ab-12', { uuid: 'cd-34' }, [{ ...ITEM, id: 'ab-12' }, { ...ITEM, id: 'cd-34' }]],
    ['GET', '/api/library/file/ab-12', {}, [{ ...ITEM, id: 'ab-12' }]],
    ['GET', '/api/library/thumb/ab-12', {}, [{ ...ITEM, id: 'ab-12' }]],
    ['DELETE', '/api/library/folders/8', {}, [{ ...FOLDER, id: '8' }]],
    ['POST', '/api/command/crm/tags/assign', { tagId: 5, contactId: 'c1' }, [{ ...TAG, id: '5' }]],
    ['POST', '/api/command/label-threads', { labelId: 7, threadId: 't' }, [{ ...LABEL, id: '7' }]],
    ['DELETE', '/api/command/label-threads', { labelId: '7', threadId: 't' }, [{ ...LABEL, id: '7' }]],
    ['PATCH', '/api/library/item/ab-12', { folderId: 8 }, [{ ...ITEM, id: 'ab-12' }, { ...FOLDER, id: '8' }]],
    ['POST', '/api/library/folders', { name: 'f', parentId: '8' }, [{ ...FOLDER, id: '8' }]],
  ])('REST %s %s', (method, pathname, params, expected) => {
    expect(rest(method as string, pathname as string, params)).toEqual(expected);
  });

  test.each([
    ['db:deleteLocalLabel', { id: 7 }, [{ ...LABEL, id: '7' }]],
    ['db:setLocalLabelActive', { id: 7, isActive: 0 }, [{ ...LABEL, id: '7' }]],
    ['db:setLocalLabelOrder', { id: 7, order: 1 }, [{ ...LABEL, id: '7' }]],
    ['db:upsertLocalLabel', { label: { id: 7, name: 'x', pageIds: 'acc-a' } }, [{ ...LABEL, id: '7' }]],
    ['db:setLocalQMActive', { id: 4, isActive: 1 }, [{ ...QM, id: '4' }]],
    ['db:setLocalQMOrder', { id: 4, order: 2 }, [{ ...QM, id: '4' }]],
    ['crm:deleteCampaign', { zaloId: 'acc-a', campaignId: 3 }, [{ ...CAMPAIGN, id: '3' }]],
    ['crm:updateCampaignStatus', { campaignId: 3, status: 'active' }, [{ ...CAMPAIGN, id: '3' }]],
    ['db:assignLocalLabelToThread', { zaloId: 'acc-a', labelId: 7, threadId: 't' }, [{ ...LABEL, id: '7' }]],
    ['db:removeLocalLabelFromThread', { zaloId: 'acc-a', labelId: 7, threadId: 't' }, [{ ...LABEL, id: '7' }]],
    ['db:bulkAssignLocalLabelToThread', { zaloId: 'acc-a', labelIds: [7, '9'], threadIds: ['t'] }, [{ ...LABEL, id: '7' }, { ...LABEL, id: '9' }]],
    ['zalo:sendImages', { _libraryUuid: 'ab-12' }, [{ ...ITEM, id: 'ab-12' }]],
    ['zalo:sendImages', { _libraryUuids: ['ab-12', 'cd-34', 'ab-12'] }, [{ ...ITEM, id: 'ab-12' }, { ...ITEM, id: 'cd-34' }]],
    ['zalo:sendVideo', { _libraryUuid: 'ab-12', _libraryUuids: ['cd-34'] }, [{ ...ITEM, id: 'ab-12' }, { ...ITEM, id: 'cd-34' }]],
  ])('proxy %s', (channel, params, expected) => {
    expect(proxy(channel as string, params)).toEqual(expected);
  });

  test('aRowAlreadyConstrainedBySqlIsNotListed', () => {
    expect(rest('DELETE', '/api/command/crm/notes/3')).toEqual([]);
    expect(rest('DELETE', '/api/command/quick-messages/4')).toEqual([]);
    expect(rest('DELETE', '/api/command/bank-cards/2')).toEqual([]);
    expect(rest('DELETE', '/api/command/crm/tags/5/contacts/c1')).toEqual([]);
    expect(proxy('crm:deleteNote', { zaloId: 'acc-a', noteId: 3 })).toEqual([]);
    expect(proxy('db:deleteLocalQuickMessage', { zaloId: 'acc-a', id: 4 })).toEqual([]);
  });

  test('aCampaignIdIsReadTheWayTheHandlerReadsIt', () => {
    expect(rest('POST', '/api/command/crm/campaigns/status', { campaignId: '3abc' })).toEqual([{ ...CAMPAIGN, id: '3' }]);
    expect(rest('POST', '/api/command/crm/campaigns/status', { campaignId: [3] })).toEqual([{ ...CAMPAIGN, id: '3' }]);
    expect(rest('POST', '/api/command/crm/campaigns/status', { campaignId: 'x' })).toEqual([]);
  });

  test('missingOrMalformedParamsGiveNoRefsInsteadOfThrowing', () => {
    expect(rest('POST', '/api/command/labels', { label: 'x' })).toEqual([]);
    expect(rest('POST', '/api/command/labels', null)).toEqual([]);
    expect(proxy('db:setLocalLabelActive', 'oops')).toEqual([]);
    expect(proxy('zalo:sendImages', { _libraryUuids: 'ab-12' })).toEqual([]);
  });
});

describe('findForeignRecord', () => {
  const dbWith = (rows: Record<string, unknown>) => ({
    queryOne: jest.fn((sql: string, params?: unknown[]) => {
      const table = /FROM (\w+) WHERE/.exec(sql)?.[1];
      const key = `${table}:${params?.[0]}`;
      return key in rows ? { owner: rows[key] } : undefined;
    }),
  });
  const ref = (base: typeof LABEL, id: string): RecordRef => ({ ...base, id });

  test('aRecordOfAnotherAccountIsReturnedAndAnOwnOneIsNot', () => {
    const db = dbWith({ 'crm_campaigns:1': 'acc-a', 'crm_campaigns:2': 'acc-b' });
    expect(findForeignRecord(db, [ref(CAMPAIGN, '1')], ['acc-a'])).toBeNull();
    expect(findForeignRecord(db, [ref(CAMPAIGN, '2')], ['acc-a'])).toEqual(ref(CAMPAIGN, '2'));
    expect(findForeignRecord(db, [ref(CAMPAIGN, '1'), ref(CAMPAIGN, '2')], ['acc-a'])).toEqual(ref(CAMPAIGN, '2'));
  });

  test('theIdIsBoundNeverConcatenated', () => {
    const db = dbWith({});
    findForeignRecord(db, [ref(ITEM, "x' OR '1'='1")], ['acc-a']);
    expect(db.queryOne).toHaveBeenCalledWith('SELECT owner_zalo_id AS owner FROM media_library_items WHERE uuid = ?', ["x' OR '1'='1"]);
  });

  test('aLabelOfSeveralAccountsNeedsEveryAccount', () => {
    const db = dbWith({ 'local_labels:1': 'acc-a,acc-b' });
    expect(findForeignRecord(db, [ref(LABEL, '1')], ['acc-a'])).toEqual(ref(LABEL, '1'));
    expect(findForeignRecord(db, [ref(LABEL, '1')], ['acc-a', 'acc-b'])).toBeNull();
  });

  test('aLabelWithoutAccountsIsGlobalButAnEmptyOwnerElsewhereIsRefused', () => {
    const db = dbWith({ 'local_labels:1': '', 'local_labels:2': null, 'crm_campaigns:1': '', 'local_quick_messages:1': null });
    expect(findForeignRecord(db, [ref(LABEL, '1'), ref(LABEL, '2')], ['acc-a'])).toBeNull();
    expect(findForeignRecord(db, [ref(CAMPAIGN, '1')], ['acc-a'])).toEqual(ref(CAMPAIGN, '1'));
    expect(findForeignRecord(db, [ref(QM, '1')], ['acc-a'])).toEqual(ref(QM, '1'));
  });

  test('aMissingRecordIsLeftToTheHandler', () => {
    expect(findForeignRecord(dbWith({}), [ref(LABEL, '99')], [])).toBeNull();
  });

  test('anEmployeeWithNoAccountsMayStillTouchNothingOwned', () => {
    expect(findForeignRecord(dbWith({ 'crm_campaigns:1': 'acc-a' }), [ref(CAMPAIGN, '1')], [])).toEqual(ref(CAMPAIGN, '1'));
  });

  test('anUnknownTableOrAFailingLookupRefuses', () => {
    const db = dbWith({});
    const stolen = { table: 'accounts', idColumn: 'zalo_id', ownerColumn: 'cookies', id: 'acc-a' };
    expect(findForeignRecord(db, [stolen], ['acc-a'])).toEqual(stolen);
    expect(db.queryOne).not.toHaveBeenCalled();
    const broken = { queryOne: () => { throw new Error('no such table'); } };
    expect(findForeignRecord(broken, [ref(CAMPAIGN, '1')], ['acc-a'])).toEqual(ref(CAMPAIGN, '1'));
  });
});
