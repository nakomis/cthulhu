export interface NotifierOptions {
  userKey: string;
  appToken: string;
  /** Injected so tests never touch the network. */
  fetchImpl?: typeof fetch;
}

/**
 * Pushover, not ntfy - home-servers already uses Pushover for Scrutiny alerts,
 * with keys in SSM at /pushover/.
 */
export class PushoverNotifier {
  private readonly userKey: string;
  private readonly appToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: NotifierOptions) {
    this.userKey = options.userKey;
    this.appToken = options.appToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Never throws. A failed notification must not take down the print server
   * or bubble into a status handler - it is strictly best-effort.
   */
  async notify(title: string, message: string): Promise<boolean> {
    try {
      const body = new URLSearchParams({
        token: this.appToken,
        user: this.userKey,
        title,
        message,
      });
      const res = await this.fetchImpl('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        body,
      });
      // Pushover answers 200 with {"status":0,...} for a bad token, so res.ok
      // alone is not enough - it would report success for credentials that
      // silently deliver nothing.
      if (!res.ok) return false;
      try {
        const payload = (await res.json()) as { status?: number };
        return payload.status === 1;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }
}

export interface Notifier {
  notify(title: string, message: string): Promise<boolean>;
}

/** Used when Pushover is not configured. Keeps call sites free of null checks. */
export const nullNotifier: Notifier = {
  async notify() {
    return false;
  },
};
