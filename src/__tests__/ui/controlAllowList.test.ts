import { findBroadCidrs } from '../../ui/components/settings/controlAllowList';

describe('findBroadCidrs', () => {
    it('flags CIDRs broader than /16 including 0.0.0.0/0', () => {
        expect(findBroadCidrs('10.0.0.0/8\n0.0.0.0/0, 192.168.0.0/16 192.168.1.0/24 203.0.113.5 172.16.0.0/12')).toEqual(['10.0.0.0/8', '0.0.0.0/0', '172.16.0.0/12']);
    });
    it('ignores single IPs, empty text and junk', () => {
        expect(findBroadCidrs('')).toEqual([]);
        expect(findBroadCidrs('203.0.113.5\nnope/3')).toEqual([]);
    });
});
