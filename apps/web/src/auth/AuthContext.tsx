import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { refreshSession, setSessionExpiredHandler } from '../api/client';
import { tokenStore } from './tokenStore';
import type { User, UserRole } from '../types';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthCtx {
  status: Status;
  user: User | null;
  login: (email: string, password: string, totp?: string) => Promise<User>;
  logout: () => Promise<void>;
  hasRole: (...roles: UserRole[]) => boolean;
  sessionExpired: boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const user = useSyncExternalStore(tokenStore.subscribe, tokenStore.getUser, tokenStore.getUser);
  const [booting, setBooting] = useState(() => !tokenStore.getUser() && !!tokenStore.getRefreshToken());
  const [sessionExpired, setSessionExpired] = useState(false);

  // Restore session on reload: refresh token (localStorage) → new access token (memory).
  useEffect(() => {
    if (!booting) return;
    let cancelled = false;
    refreshSession()
      .then(async (ok) => {
        if (ok && !tokenStore.getUser()) {
          try {
            tokenStore.setUser(await api.me());
          } catch {
            /* ignore */
          }
        }
      })
      .finally(() => !cancelled && setBooting(false));
    return () => {
      cancelled = true;
    };
  }, [booting]);

  useEffect(() => {
    setSessionExpiredHandler(() => {
      tokenStore.clear();
      qc.clear();
      setSessionExpired(true);
    });
  }, [qc]);

  const login = useCallback(async (email: string, password: string, totp?: string) => {
    const res = await api.login(email, password, totp);
    tokenStore.setSession(res);
    setSessionExpired(false);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    const rt = tokenStore.getRefreshToken();
    try {
      await api.logout(rt);
    } catch {
      /* best effort */
    }
    tokenStore.clear();
    qc.clear();
  }, [qc]);

  const value = useMemo<AuthCtx>(
    () => ({
      status: booting ? 'loading' : user ? 'authenticated' : 'anonymous',
      user,
      login,
      logout,
      hasRole: (...roles) => !!user && roles.includes(user.role),
      sessionExpired,
    }),
    [booting, user, login, logout, sessionExpired],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used inside AuthProvider');
  return c;
}

export const OWNER_ROLES: UserRole[] = ['owner', 'manager', 'platform_admin'];
export const ERB_ROLES: UserRole[] = ['erb_national', 'erb_provincial', 'platform_admin'];
export const ZRA_ROLES: UserRole[] = ['zra_auditor', 'platform_admin'];
export const ADMIN_ROLES: UserRole[] = ['platform_admin'];

export function homeFor(role: UserRole | undefined): string {
  switch (role) {
    case 'owner':
    case 'manager':
      return '/dashboard';
    case 'erb_national':
    case 'erb_provincial':
      return '/erb';
    case 'zra_auditor':
      return '/zra';
    case 'platform_admin':
      return '/admin';
    default:
      return '/login';
  }
}
