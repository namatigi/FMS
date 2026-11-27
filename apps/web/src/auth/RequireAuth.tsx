import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { homeFor, useAuth } from './AuthContext';
import type { UserRole } from '../types';
import { FullPageLoader } from '../components/ui';

export function RequireAuth({ roles, children }: { roles?: UserRole[]; children: ReactNode }) {
  const { status, user } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <FullPageLoader label="Restoring session…" />;
  if (status === 'anonymous' || !user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return <>{children}</>;
}
