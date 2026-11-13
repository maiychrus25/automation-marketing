const cancel = jest.fn();
jest.mock('electron', () => ({ app: { getPath: () => '/tmp', quit: jest.fn() }, safeStorage: { isEncryptionAvailable: () => false }, dialog: {} }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('../../services/zalo/mobileSync/MobileSyncService', () => ({
  __esModule: true,
  default: { getInstance: () => ({ cancel }) },
}));

import ZaloLoginHelper from '../../utils/ZaloLoginHelper';

describe('ZaloLoginHelper.markRemoved', () => {
  beforeEach(() => cancel.mockReset());

  test('cancelsARunningPhoneSyncWithoutAwaitingIt', () => {
    cancel.mockReturnValue(new Promise(() => undefined)); // never settles: markRemoved must not wait
    expect(() => ZaloLoginHelper.markRemoved('111222333')).not.toThrow();
    expect(cancel).toHaveBeenCalledWith('111222333');
  });

  test('neverThrowsWhenCancelThrowsOrRejects', () => {
    cancel.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => ZaloLoginHelper.markRemoved('111222334')).not.toThrow();
    cancel.mockReturnValueOnce(Promise.reject(new Error('late')));
    expect(() => ZaloLoginHelper.markRemoved('111222335')).not.toThrow();
  });
});
