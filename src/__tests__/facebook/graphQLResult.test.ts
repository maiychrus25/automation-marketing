jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import Logger from '../../utils/Logger';
import {
  assertFacebookMutationSuccess,
  FacebookOperationError,
  parseFacebookResponse,
} from '../../services/facebook/FacebookGraphQLResult';

describe('parseFacebookResponse', () => {
  test('stripsAntiJsonPrefix', () => {
    expect(parseFacebookResponse('for (;;);{"a":1}')).toEqual({ a: 1 });
  });
  test('fallsBackToFirstNonEmptyLine', () => {
    expect(parseFacebookResponse('\n{"a":1}\n{"b":2}')).toEqual({ a: 1 });
  });
  test('returnsNullWhenNotJson', () => {
    expect(parseFacebookResponse('<html>x</html>')).toBeNull();
    expect(parseFacebookResponse('')).toBeNull();
    expect(parseFacebookResponse(undefined)).toBeNull();
  });
  test('passesParsedObjectThrough', () => {
    expect(parseFacebookResponse({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('assertFacebookMutationSuccess', () => {
  test('throwsOnApiError', () => {
    const body = 'for (;;);{"error":1357004,"errorSummary":"Phiên hết hạn"}';
    expect(() => assertFacebookMutationSuccess('op', body)).toThrow(/Phiên hết hạn/);
    try { assertFacebookMutationSuccess('op', body); } catch (e: any) {
      expect(e).toBeInstanceOf(FacebookOperationError);
      expect(e.operation).toBe('op');
      expect(e.code).toBe('api_error');
    }
  });
  test('throwsOnGraphQlErrors', () => {
    expect(() => assertFacebookMutationSuccess('op', '{"errors":[{"message":"Rate limited"}]}')).toThrow(/Rate limited/);
    expect(() => assertFacebookMutationSuccess('op', { errors: [{ message: 'x' }] })).toThrow(FacebookOperationError);
  });
  test('throwsOnNullData', () => {
    expect(() => assertFacebookMutationSuccess('op', '{"data":null}')).toThrow(/null/);
  });
  test('doesNotThrowOnSuccess', () => {
    expect(() => assertFacebookMutationSuccess('op', '{"data":{"x":{"id":"1"}}}')).not.toThrow();
    expect(() => assertFacebookMutationSuccess('op', { data: { x: 1 } })).not.toThrow();
  });
  test('unparseableBodyIsUnknownNotFailure', () => {
    expect(() => assertFacebookMutationSuccess('op', '<html>login</html>')).not.toThrow();
    expect(() => assertFacebookMutationSuccess('op', '')).not.toThrow();
    expect(() => assertFacebookMutationSuccess('op', undefined)).not.toThrow();
  });
  test('multiLineUsesFirstLine', () => {
    expect(() => assertFacebookMutationSuccess('op', '{"data":{"x":1}}\n{"errors":[{"message":"late"}]}')).not.toThrow();
  });
});

describe('assertFacebookMutationSuccess partial success', () => {
  const fails = (b: unknown) => () => assertFacebookMutationSuccess('op', b);
  beforeEach(() => { (Logger.warn as jest.Mock).mockClear(); });
  test('usableDataWithErrorsWarnsOnly', () => {
    expect(fails('{"data":{"x":{"id":"1"}},"errors":[{"message":"warn"}]}')).not.toThrow();
    expect(fails({ data: { x: { id: '1' } }, errors: [{ message: 'warn' }] })).not.toThrow();
    expect(Logger.warn).toHaveBeenCalledTimes(2);
  });
  test('usableDataWithErrorFieldWarnsOnly', () => {
    expect(fails('{"data":{"x":{"id":"1"}},"error":{"message":"info"}}')).not.toThrow();
  });
  test('noUsableDataWithErrorsThrows', () => {
    expect(fails('{"data":{"x":null},"errors":[{"message":"Rate limited"}]}')).toThrow(/Rate limited/);
    expect(fails('{"data":null,"errors":[{"message":"Rate limited"}]}')).toThrow(FacebookOperationError);
    expect(fails('{"errors":[{"message":"Rate limited"}]}')).toThrow(/Rate limited/);
    expect(fails({ data: { x: null }, errors: [{ message: 'Rate limited' }] })).toThrow(/Rate limited/);
  });
  test('apiErrorWithoutDataStillThrows', () => {
    expect(fails('for (;;);{"error":1357004,"errorSummary":"Phiên hết hạn"}')).toThrow(/Phiên hết hạn/);
  });
  test('falsyErrorIsNoError', () => {
    expect(fails('{"error":0,"data":{"x":1}}')).not.toThrow();
  });
  test('nullPayloadMembersUnchanged', () => {
    expect(fails('{"data":{"x":null}}')).not.toThrow();
    expect(fails('{"data":null}')).toThrow(FacebookOperationError);
  });
});
