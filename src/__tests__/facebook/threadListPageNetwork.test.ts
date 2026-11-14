import axios from 'axios';
import { getThreadListPage } from '../../services/facebook/FacebookThreadManager';

jest.mock('axios');
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

test('networkFailureResolvesToError', async () => {
  (axios.post as jest.Mock).mockRejectedValue(new Error('socket hang up'));
  const page = await getThreadListPage({ cookieFacebook: 'c=1', FacebookID: '1' } as any, 'acc', null, 50);
  expect(page).toEqual({ threads: [], nextBefore: null, error: 'socket hang up' });
});
