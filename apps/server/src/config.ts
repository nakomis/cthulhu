/**
 * Server configuration, read from the environment.
 *
 * Secrets never live in the repo - Ansible renders `.env` from AWS SSM at
 * deploy time. See CTHU-10.
 */
export interface Config {
  port: number;
  host: string;
  /**
   * Pinned printer address. Discovery is the convenience path; a pinned IP is
   * the production path, and is the only option at all if the printer's WiFi
   * lands it on a different subnet from Luke.
   */
  printerIp: string | undefined;
  /** Whether to attempt UDP broadcast discovery. Needs host networking. */
  discoveryEnabled: boolean;
  discoveryTimeoutMs: number;
}

export class ConfigError extends Error {}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${key} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function boolFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ConfigError(`${key} must be true/false or 1/0, got ${JSON.stringify(raw)}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {
    // 9120 on Luke; Plane already holds 9110.
    port: intFromEnv(env, 'PORT', 9120),
    host: env.HOST ?? '0.0.0.0',
    printerIp: env.PRINTER_IP || undefined,
    discoveryEnabled: boolFromEnv(env, 'DISCOVERY_ENABLED', true),
    discoveryTimeoutMs: intFromEnv(env, 'DISCOVERY_TIMEOUT_MS', 2000),
  };

  if (!config.printerIp && !config.discoveryEnabled) {
    throw new ConfigError(
      'No way to reach the printer: set PRINTER_IP, or leave DISCOVERY_ENABLED on.',
    );
  }
  return config;
}
