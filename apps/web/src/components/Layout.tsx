import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { provinceName, ROLE_LABELS, type UserRole } from '../types';
import { useTheme } from '../lib/theme';

interface NavItem {
  to: string;
  label: string;
  roles: UserRole[];
  end?: boolean;
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

const OWN: UserRole[] = ['owner', 'manager', 'platform_admin'];
const ERB: UserRole[] = ['erb_national', 'erb_provincial', 'platform_admin'];
const ZRA: UserRole[] = ['zra_auditor', 'platform_admin'];
const ADM: UserRole[] = ['platform_admin'];

const NAV: NavGroup[] = [
  {
    label: 'Stations',
    items: [
      { to: '/dashboard', label: 'Dashboard', roles: OWN },
      { to: '/stations', label: 'Stations', roles: [...OWN, 'zra_auditor'], end: true },
      { to: '/stations/map', label: 'Station map', roles: OWN },
      { to: '/alerts', label: 'Alerts', roles: OWN },
    ],
  },
  {
    label: 'Regulator (ERB)',
    items: [
      { to: '/erb', label: 'National overview', roles: ERB, end: true },
      { to: '/erb/provinces', label: 'Provinces', roles: ERB },
      { to: '/erb/sales', label: 'Sales trends', roles: ERB },
      { to: '/erb/compliance', label: 'Compliance', roles: ERB },
      { to: '/erb/forecasts', label: 'Forecasts & AI', roles: ERB },
      { to: '/erb/prices', label: 'Cap prices', roles: ['erb_national', 'erb_provincial', 'platform_admin'] },
      { to: '/erb/export', label: 'Export', roles: ERB },
    ],
  },
  {
    label: 'Revenue (ZRA)',
    items: [
      { to: '/zra', label: 'Fiscal receipts', roles: ZRA, end: true },
      { to: '/zra/transactions', label: 'Transactions', roles: ZRA },
    ],
  },
  {
    label: 'Administration',
    items: [{ to: '/admin', label: 'Admin console', roles: ADM }],
  },
  {
    label: 'Account',
    items: [{ to: '/security', label: 'Security (MFA)', roles: ['erb_national', 'erb_provincial', 'platform_admin'] }],
  },
];

export function Layout() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => setOpen(false), [loc.pathname]);
  if (!user) return null;

  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.roles.includes(user.role)) })).filter((g) => g.items.length);
  const scope =
    user.role === 'erb_provincial' ? provinceName(user.province_id) : user.role === 'erb_national' ? 'National' : null;

  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <button type="button" className="btn btn-ghost btn-icon nav-toggle" aria-label="Toggle navigation" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          ☰
        </button>
        <NavLink to="/" className="brand" aria-label="FMS Zambia home">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span>
            <strong>FMS</strong> <span className="brand-sub">Zambia Fuel Monitoring</span>
          </span>
        </NavLink>
        <div className="topbar-right">
          {import.meta.env.VITE_USE_MOCKS === 'true' && <span className="badge badge-warn" title="Data served by Mock Service Worker">Mock data</span>}
          <button type="button" className="btn btn-ghost btn-icon" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title="Toggle theme">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <div className="user-chip" title={user.email}>
            <span className="user-name">{user.full_name}</span>
            <span className="user-role">
              {ROLE_LABELS[user.role]}
              {scope ? ` · ${scope}` : ''}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={async () => {
              await logout();
              nav('/login', { replace: true });
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <nav className="sidebar" aria-label="Main">
        {groups.map((g) => (
          <div key={g.label} className="nav-group">
            <div className="nav-group-label">{g.label}</div>
            <ul>
              {g.items.map((i) => (
                <li key={i.to}>
                  <NavLink to={i.to} end={i.end}>
                    {i.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="nav-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
