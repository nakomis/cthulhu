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
   * the production path. The home network is a single flat 172.29.0.0/16, so
   * broadcast discovery does work - but a pinned IP does not depend on
   * broadcast surviving switches, WiFi isolation or a future VLAN split.
   */
  printerIp: string | undefined;
  /** Whether to attempt UDP broadcast discovery. Needs host networking. */
  discoveryEnabled: boolean;
  discoveryTimeoutMs: number;
  discoveryBroadcastAddress: string;
  /** Where the SQLite history database lives. */
  databasePath: string;
  /** Pushover, for print-finished notifications. Both required, or neither. */
  pushoverUserKey: string | undefined;
  pushoverAppToken: string | undefined;
  /** MJPEG camera stream on the printer. */
  cameraEnabled: boolean;
  /**
   * Full URL of the printer's MJPEG stream. The community docs barely cover
   * the video stream, so the default below is a GUESS and must be overridable
   * without a rebuild - the fake printer, for instance, serves it on the same
   * port as the WebSocket. Use {ip} as a placeholder for the printer address.
   */
  cameraUrl: string;
  /**
   * Port serving the printer's HTTP file-transfer interface. Another guess
   * from thin documentation, so it must be overridable without a rebuild.
   */
  uploadPort: number;
  /** Directory of the built SPA. Unset in dev, where Vite serves it. */
  webRoot: string | undefined;
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
  const pushoverUserKey = env.PUSHOVER_USER_KEY || undefined;
  const pushoverAppToken = env.PUSHOVER_APP_TOKEN || undefined;

  // Half-configured notifications are worse than none: the print finishes,
  // nothing buzzes, and nothing says why. Fail at startup instead.
  if (Boolean(pushoverUserKey) !== Boolean(pushoverAppToken)) {
    throw new ConfigError(
      'Pushover needs BOTH PUSHOVER_USER_KEY and PUSHOVER_APP_TOKEN, or neither.',
    );
  }

  const config: Config = {
    // 9120 on Luke; Plane already holds 9110.
    port: intFromEnv(env, 'PORT', 9120),
    host: env.HOST ?? '0.0.0.0',
    printerIp: env.PRINTER_IP || undefined,
    discoveryEnabled: boolFromEnv(env, 'DISCOVERY_ENABLED', true),
    discoveryTimeoutMs: intFromEnv(env, 'DISCOVERY_TIMEOUT_MS', 2000),
    discoveryBroadcastAddress: env.DISCOVERY_BROADCAST_ADDRESS || '255.255.255.255',
    databasePath: env.DATABASE_PATH ?? '/data/cthulhu.sqlite',
    pushoverUserKey,
    pushoverAppToken,
    cameraEnabled: boolFromEnv(env, 'CAMERA_ENABLED', true),
    cameraUrl: env.CAMERA_URL || 'http://{ip}:3031/video',
    uploadPort: intFromEnv(env, 'UPLOAD_PORT', 3030),
    webRoot: env.WEB_ROOT || undefined,
  };

  if (!config.printerIp && !config.discoveryEnabled) {
    throw new ConfigError(
      'No way to reach the printer: set PRINTER_IP, or leave DISCOVERY_ENABLED on.',
    );
  }
  return config;
}
