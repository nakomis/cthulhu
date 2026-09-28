import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('defaults to port 9120, which is what the nginx vhost on Leia expects', () => {
    expect(loadConfig({ PRINTER_IP: '192.168.1.2' }).port).toBe(9120);
  });

  it('accepts a pinned printer IP with discovery off', () => {
    const config = loadConfig({ PRINTER_IP: '192.168.1.2', DISCOVERY_ENABLED: 'false' });
    expect(config.printerIp).toBe('192.168.1.2');
    expect(config.discoveryEnabled).toBe(false);
  });

  it('allows discovery with no pinned IP', () => {
    const config = loadConfig({});
    expect(config.printerIp).toBeUndefined();
    expect(config.discoveryEnabled).toBe(true);
  });

  it('refuses a config with no way to reach the printer at all', () => {
    expect(() => loadConfig({ DISCOVERY_ENABLED: 'false' })).toThrow(ConfigError);
  });

  it('treats an empty PRINTER_IP as unset rather than as an address', () => {
    // An unset variable in a rendered .env arrives as "", not as absent.
    expect(() => loadConfig({ PRINTER_IP: '', DISCOVERY_ENABLED: 'false' })).toThrow(ConfigError);
  });

  it.each(['0', 'no', '-1', 'quite'])('rejects nonsense port %s', (value) => {
    expect(() => loadConfig({ PORT: value, PRINTER_IP: '1.2.3.4' })).toThrow(ConfigError);
  });

  it.each(['yes', 'maybe', '2'])('rejects nonsense DISCOVERY_ENABLED %s', (value) => {
    expect(() => loadConfig({ DISCOVERY_ENABLED: value, PRINTER_IP: '1.2.3.4' })).toThrow(
      ConfigError,
    );
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('parses DISCOVERY_ENABLED=%s', (raw, expected) => {
    expect(loadConfig({ DISCOVERY_ENABLED: raw, PRINTER_IP: '1.2.3.4' }).discoveryEnabled).toBe(
      expected,
    );
  });

  describe('PLATE_Z_OFFSET_MM', () => {
    it('is undefined when unset', () => {
      expect(loadConfig({ PRINTER_IP: '1.2.3.4' }).plateZOffsetMm).toBeUndefined();
    });

    it('parses a sensible offset', () => {
      expect(loadConfig({ PRINTER_IP: '1.2.3.4', PLATE_Z_OFFSET_MM: '3.2' }).plateZOffsetMm).toBe(
        3.2,
      );
    });

    // Invalid values are treated as unset rather than refusing to start: a
    // typo here should disable the Magic Files Z-offset entry, not the whole
    // server - see the comment on plateZOffsetFromEnv in config.ts.
    it.each(['0', '-1', '10.1', 'not-a-number', ''])(
      'treats %s as unconfigured rather than throwing',
      (raw) => {
        expect(() => loadConfig({ PRINTER_IP: '1.2.3.4', PLATE_Z_OFFSET_MM: raw })).not.toThrow();
        expect(
          loadConfig({ PRINTER_IP: '1.2.3.4', PLATE_Z_OFFSET_MM: raw }).plateZOffsetMm,
        ).toBeUndefined();
      },
    );

    it('accepts the top of the sensible range', () => {
      expect(loadConfig({ PRINTER_IP: '1.2.3.4', PLATE_Z_OFFSET_MM: '10' }).plateZOffsetMm).toBe(
        10,
      );
    });
  });
});
