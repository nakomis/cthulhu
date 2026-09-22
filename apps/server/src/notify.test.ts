import { describe, expect, it, vi } from 'vitest';
import { nullNotifier, PushoverNotifier } from './notify.js';

const ok = (body: unknown) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

describe('PushoverNotifier', () => {
  it('reports success only when Pushover says status:1', async () => {
    const fetchImpl = ok({ status: 1, request: 'abc' });
    const n = new PushoverNotifier({ userKey: 'u', appToken: 't', fetchImpl });
    await expect(n.notify('Print finished', 'x.goo has finished printing.')).resolves.toBe(true);
  });

  it('reports FAILURE when Pushover returns 200 with status:0', async () => {
    // This is the important one. Pushover answers HTTP 200 with {"status":0}
    // for an invalid token, so checking res.ok alone reports success for
    // credentials that silently deliver nothing at all.
    const fetchImpl = ok({ status: 0, errors: ['application token is invalid'] });
    const n = new PushoverNotifier({ userKey: 'u', appToken: 'bad', fetchImpl });
    await expect(n.notify('t', 'm')).resolves.toBe(false);
  });

  it('reports failure on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    const n = new PushoverNotifier({ userKey: 'u', appToken: 't', fetchImpl });
    await expect(n.notify('t', 'm')).resolves.toBe(false);
  });

  it('never throws when the network is down', async () => {
    // A Pushover outage must not take down the print server or bubble up
    // through a status handler.
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const n = new PushoverNotifier({ userKey: 'u', appToken: 't', fetchImpl });
    await expect(n.notify('t', 'm')).resolves.toBe(false);
  });

  it('sends the token, user, title and message', async () => {
    const fetchImpl = ok({ status: 1 });
    const n = new PushoverNotifier({ userKey: 'USER', appToken: 'TOKEN', fetchImpl });
    await n.notify('Print finished', 'hanger.goo has finished printing.');

    const [, init] = fetchImpl.mock.calls[0] as [string, { body: URLSearchParams }];
    expect(init.body.get('token')).toBe('TOKEN');
    expect(init.body.get('user')).toBe('USER');
    expect(init.body.get('title')).toBe('Print finished');
    expect(init.body.get('message')).toContain('hanger.goo');
  });

  it('nullNotifier reports false, so callers can log a real outcome', async () => {
    await expect(nullNotifier.notify('t', 'm')).resolves.toBe(false);
  });
});
