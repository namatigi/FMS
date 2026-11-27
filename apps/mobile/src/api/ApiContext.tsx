import React, { createContext, useContext } from 'react';
import type { ApiClient } from './client';
import type { User } from './types';

const ApiContext = createContext<ApiClient | null>(null);
const UserContext = createContext<User | null>(null);

export function ApiProvider({ client, user, children }: { client: ApiClient; user?: User | null; children: React.ReactNode }) {
  return (
    <ApiContext.Provider value={client}>
      <UserContext.Provider value={user ?? null}>{children}</UserContext.Provider>
    </ApiContext.Provider>
  );
}

export function useApi(): ApiClient {
  const c = useContext(ApiContext);
  if (!c) throw new Error('useApi must be used inside <ApiProvider>');
  return c;
}

/** Signed-in user (null when signed out). */
export function useCurrentUser(): User | null {
  return useContext(UserContext);
}

export function canEditPrices(user: User | null): boolean {
  return user?.role === 'owner' || user?.role === 'platform_admin';
}
