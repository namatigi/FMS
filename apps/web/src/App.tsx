import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ADMIN_ROLES, ERB_ROLES, homeFor, OWNER_ROLES, useAuth, ZRA_ROLES } from './auth/AuthContext';
import { RequireAuth } from './auth/RequireAuth';
import { Layout } from './components/Layout';
import { Empty, FullPageLoader, Loading } from './components/ui';
import Login from './pages/Login';
import type { UserRole } from './types';

const Dashboard = lazy(() => import('./pages/owner/Dashboard'));
const Stations = lazy(() => import('./pages/owner/Stations'));
const StationDetail = lazy(() => import('./pages/station/StationDetail'));
const AlertsPage = lazy(() => import('./pages/station/AlertsTab').then((m) => ({ default: m.AlertsPage })));
const ErbOverview = lazy(() => import('./pages/erb/Overview'));
const Provinces = lazy(() => import('./pages/erb/Provinces'));
const ProvinceStations = lazy(() => import('./pages/erb/Provinces').then((m) => ({ default: m.ProvinceStations })));
const SalesTrends = lazy(() => import('./pages/erb/SalesTrends'));
const Compliance = lazy(() => import('./pages/erb/Compliance'));
const Forecasts = lazy(() => import('./pages/erb/Forecasts'));
const CapPrices = lazy(() => import('./pages/erb/CapPrices'));
const ExportPage = lazy(() => import('./pages/erb/Export'));
const Receipts = lazy(() => import('./pages/zra/Receipts'));
const ZraTransactions = lazy(() => import('./pages/zra/Receipts').then((m) => ({ default: m.ZraTransactions })));
const AdminConsole = lazy(() => import('./pages/admin/AdminConsole'));
const Security = lazy(() => import('./pages/Security'));

function Guard({ roles, children }: { roles: UserRole[]; children: ReactNode }) {
  return (
    <RequireAuth roles={roles}>
      <Suspense fallback={<Loading label="Loading page…" />}>{children}</Suspense>
    </RequireAuth>
  );
}

function Home() {
  const { user, status } = useAuth();
  if (status === 'loading') return <FullPageLoader />;
  return <Navigate to={homeFor(user?.role)} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Home />} />
        <Route path="dashboard" element={<Guard roles={OWNER_ROLES}><Dashboard /></Guard>} />
        <Route path="stations" element={<Guard roles={[...OWNER_ROLES, 'zra_auditor']}><Stations /></Guard>} />
        <Route path="stations/map" element={<Guard roles={OWNER_ROLES}><Stations defaultView="map" /></Guard>} />
        <Route path="stations/:id" element={<Guard roles={[...OWNER_ROLES, 'zra_auditor', 'erb_national', 'erb_provincial']}><StationDetail /></Guard>} />
        <Route path="stations/:id/:tab" element={<Guard roles={[...OWNER_ROLES, 'zra_auditor', 'erb_national', 'erb_provincial']}><StationDetail /></Guard>} />
        <Route path="alerts" element={<Guard roles={OWNER_ROLES}><AlertsPage /></Guard>} />

        <Route path="erb" element={<Guard roles={ERB_ROLES}><ErbOverview /></Guard>} />
        <Route path="erb/provinces" element={<Guard roles={ERB_ROLES}><Provinces /></Guard>} />
        <Route path="erb/provinces/:id" element={<Guard roles={ERB_ROLES}><ProvinceStations /></Guard>} />
        <Route path="erb/sales" element={<Guard roles={ERB_ROLES}><SalesTrends /></Guard>} />
        <Route path="erb/compliance" element={<Guard roles={ERB_ROLES}><Compliance /></Guard>} />
        <Route path="erb/forecasts" element={<Guard roles={ERB_ROLES}><Forecasts /></Guard>} />
        <Route path="erb/prices" element={<Guard roles={ERB_ROLES}><CapPrices /></Guard>} />
        <Route path="erb/export" element={<Guard roles={ERB_ROLES}><ExportPage /></Guard>} />

        <Route path="zra" element={<Guard roles={ZRA_ROLES}><Receipts /></Guard>} />
        <Route path="zra/transactions" element={<Guard roles={ZRA_ROLES}><ZraTransactions /></Guard>} />

        <Route path="admin" element={<Guard roles={ADMIN_ROLES}><AdminConsole /></Guard>} />
        <Route path="admin/:entity" element={<Guard roles={ADMIN_ROLES}><AdminConsole /></Guard>} />

        <Route path="security" element={<Guard roles={['erb_national', 'erb_provincial', 'platform_admin']}><Security /></Guard>} />

        <Route path="*" element={<Empty title="Page not found">The page you requested does not exist.</Empty>} />
      </Route>
    </Routes>
  );
}
