import { describe, expect, it } from 'vitest';
import { parseDiscoveryResponse } from './discovery.js';

const VALID = {
  Id: 'uuid-1',
  Data: {
    Name: 'Mars 5 Ultra',
    MachineName: 'ELEGOO Mars 5 Ultra',
    BrandName: 'ELEGOO',
    MainboardIP: '192.168.1.2',
    MainboardID: '000000000001d354',
    ProtocolVersion: 'V3.0.0',
    FirmwareVersion: 'V1.0.0',
  },
};

describe('parseDiscoveryResponse', () => {
  it('flattens a valid response', () => {
    expect(parseDiscoveryResponse(VALID)).toEqual({
      id: 'uuid-1',
      name: 'Mars 5 Ultra',
      machineName: 'ELEGOO Mars 5 Ultra',
      brandName: 'ELEGOO',
      address: '192.168.1.2',
      mainboardId: '000000000001d354',
      protocolVersion: 'V3.0.0',
      firmwareVersion: 'V1.0.0',
    });
  });

  it.each([
    ['null', null],
    ['a string', 'M99999'],
    ['an empty object', {}],
    ['a response with no Data', { Id: 'x' }],
    ['a response with no MainboardIP', { Id: 'x', Data: { MainboardID: 'y' } }],
    ['a response with no MainboardID', { Id: 'x', Data: { MainboardIP: '1.2.3.4' } }],
  ])('rejects %s', (_label, input) => {
    expect(parseDiscoveryResponse(input)).toBeNull();
  });

  it('tolerates missing optional descriptive fields', () => {
    const sparse = { Id: 'x', Data: { MainboardIP: '1.2.3.4', MainboardID: 'mb' } };
    const printer = parseDiscoveryResponse(sparse);
    expect(printer?.address).toBe('1.2.3.4');
    expect(printer?.name).toBe('');
  });
});
