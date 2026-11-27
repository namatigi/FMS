import type { AuthResponse, User } from '../types';

/**
 * Token storage policy:
 *  - access token: memory only (never persisted, lost on reload → recovered via refresh)
 *  - refresh token: localStorage (rotating, opaque; 30 days)
 */
const REFRESH_KEY = 'fms.refresh_token';

type Listener = () => void;

let accessToken: string | null = null;
let accessExpiresAt = 0;
let currentUser: User | null = null;
const listeners = new Set<Listener>();

function safeGet(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}
function safeSet(v: string | null) {
  try {
    if (v) localStorage.setItem(REFRESH_KEY, v);
    else localStorage.removeItem(REFRESH_KEY);
  } catch {
    /* storage unavailable (private mode); session will last until reload */
  }
}

export const tokenStore = {
  getAccessToken: () => accessToken,
  getRefreshToken: () => safeGet(),
  getUser: () => currentUser,
  /** True when the access token is missing or expires within 30 s. */
  isAccessExpired: (now = Date.now()) => !accessToken || now > accessExpiresAt - 30_000,
  setSession(res: AuthResponse) {
    accessToken = res.access_token;
    accessExpiresAt = Date.now() + (res.expires_in || 900) * 1000;
    if (res.refresh_token) safeSet(res.refresh_token);
    if (res.user) currentUser = res.user;
    listeners.forEach((l) => l());
  },
  setUser(u: User) {
    currentUser = u;
    listeners.forEach((l) => l());
  },
  clear() {
    accessToken = null;
    accessExpiresAt = 0;
    currentUser = null;
    safeSet(null);
    listeners.forEach((l) => l());
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};
