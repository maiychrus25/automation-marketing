import { PairingTickets, PAIRING_TTL_MS, MAX_PENDING_TICKETS } from '../../services/control/PairingTickets';

function make() {
  let now = 1_000_000;
  const tickets = new PairingTickets(() => now);
  return { tickets, advance: (ms: number) => { now += ms; } };
}

describe('PairingTickets', () => {
  test('ticket is 43 chars base64url and expires in 15 minutes', () => {
    const { tickets } = make();
    const t = tickets.create('bot', '1.2.3.4');
    expect(t.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.expiresAt).toBe(1_000_000 + PAIRING_TTL_MS);
    expect(PAIRING_TTL_MS).toBe(15 * 60_000);
  });

  test('consume from the right IP works once', () => {
    const { tickets } = make();
    const { ticket } = tickets.create('bot', '1.2.3.4');
    expect(tickets.consume(ticket, '1.2.3.4')).toEqual({ name: 'bot', botIp: '1.2.3.4' });
    expect(tickets.consume(ticket, '1.2.3.4')).toBeNull();
  });

  test('clear drops every pending ticket', () => {
    const { tickets } = make();
    const a = tickets.create('a', '1.2.3.4');
    tickets.create('b', '5.6.7.8');
    tickets.clear();
    expect(tickets.pending()).toEqual([]);
    expect(tickets.consume(a.ticket, '1.2.3.4')).toBeNull();
  });

  test('wrong IP returns null but keeps the ticket', () => {
    const { tickets } = make();
    const { ticket } = tickets.create('bot', '1.2.3.4');
    expect(tickets.consume(ticket, '9.9.9.9')).toBeNull();
    expect(tickets.consume(ticket, '1.2.3.4')).toEqual({ name: 'bot', botIp: '1.2.3.4' });
  });

  test('expired ticket returns null', () => {
    const { tickets, advance } = make();
    const { ticket } = tickets.create('bot', '1.2.3.4');
    advance(PAIRING_TTL_MS + 1);
    expect(tickets.consume(ticket, '1.2.3.4')).toBeNull();
    expect(tickets.pending()).toEqual([]);
  });

  test('a new ticket for the same IP invalidates the old one', () => {
    const { tickets } = make();
    const a = tickets.create('a', '1.2.3.4');
    const b = tickets.create('b', '1.2.3.4');
    expect(tickets.consume(a.ticket, '1.2.3.4')).toBeNull();
    expect(tickets.consume(b.ticket, '1.2.3.4')).toEqual({ name: 'b', botIp: '1.2.3.4' });
  });

  test('the 6th ticket evicts the oldest', () => {
    const { tickets, advance } = make();
    const first = tickets.create('n0', '10.0.0.0');
    for (let i = 1; i < MAX_PENDING_TICKETS; i++) { advance(10); tickets.create(`n${i}`, `10.0.0.${i}`); }
    expect(tickets.pending()).toHaveLength(MAX_PENDING_TICKETS);
    advance(10);
    const sixth = tickets.create('n5', '10.0.0.5');
    expect(tickets.pending()).toHaveLength(MAX_PENDING_TICKETS);
    expect(tickets.consume(first.ticket, '10.0.0.0')).toBeNull();
    expect(tickets.consume(sixth.ticket, '10.0.0.5')).not.toBeNull();
  });

  test('pending never exposes the raw ticket', () => {
    const { tickets } = make();
    const { ticket } = tickets.create('bot', '1.2.3.4');
    const list = tickets.pending();
    expect(list).toEqual([{ name: 'bot', botIp: '1.2.3.4', expiresAt: 1_000_000 + PAIRING_TTL_MS }]);
    expect(JSON.stringify(list)).not.toContain(ticket);
  });

  test('cancel removes the ticket of that IP', () => {
    const { tickets } = make();
    const { ticket } = tickets.create('bot', '1.2.3.4');
    tickets.cancel('1.2.3.4');
    expect(tickets.consume(ticket, '1.2.3.4')).toBeNull();
  });

  test('IPv4-mapped IPv6 matches the plain IPv4', () => {
    const { tickets } = make();
    const { ticket } = tickets.create('bot', '::ffff:1.2.3.4');
    expect(tickets.consume(ticket, '1.2.3.4')).toEqual({ name: 'bot', botIp: '1.2.3.4' });
    const again = tickets.create('bot', '1.2.3.4');
    expect(tickets.consume(again.ticket, '::ffff:1.2.3.4')).not.toBeNull();
  });
});


describe('scoped pairing tickets', () => {
  test('ticketPreservesWorkspaceAndAssignments', () => {
    const { tickets } = make();
    const policy = { kind: 'page_runner' as const, workspaceId: 'ws-a', assignments: [{ pageId: '123', profileIds: ['p1'] }] };
    const { ticket } = tickets.create('runner', '203.0.113.5', policy);
    policy.assignments[0].profileIds.push('injected');
    policy.workspaceId = 'changed';
    expect(tickets.consume(ticket, '203.0.113.5')).toEqual({ name: 'runner', botIp: '203.0.113.5', policy: {
      kind: 'page_runner', workspaceId: 'ws-a', assignments: [{ pageId: '123', profileIds: ['p1'] }],
    } });
  });
  test('invalid policy does not replace an existing ticket', () => {
    const { tickets } = make();
    const { ticket } = tickets.create('legacy', '203.0.113.5');
    expect(() => tickets.create('bad', '203.0.113.5', { kind: 'legacy' } as any)).toThrow();
    expect(tickets.consume(ticket, '203.0.113.5')).toEqual({ name: 'legacy', botIp: '203.0.113.5' });
  });
});
