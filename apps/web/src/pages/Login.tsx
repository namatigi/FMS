import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { homeFor, useAuth } from '../auth/AuthContext';
import { ApiError, errorMessage } from '../api/client';
import { Spinner } from '../components/ui';

const DEMO = ['owner@zambezi.local', 'manager@zambezi.local', 'erb@erb.local', 'erb.cop@erb.local', 'zra@zra.local', 'admin@fms.local'];

export default function Login() {
  const { login, status, user, sessionExpired } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needTotp, setNeedTotp] = useState(false);
  const [totp, setTotp] = useState('');

  if (status === 'authenticated' && user) return <Navigate to={from && from !== '/login' ? from : homeFor(user.role)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const u = await login(email.trim(), password, needTotp ? totp.trim() : undefined);
      nav(from && from !== '/login' ? from : homeFor(u.role), { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'mfa_required') {
        setNeedTotp(true);
        setError(null);
      } else if (err instanceof ApiError && err.code === 'invalid_mfa_code') {
        setError('Incorrect authentication code.');
      } else if (err instanceof ApiError && (err.status === 429 || err.code === 'account_locked')) {
        setError(`Account temporarily locked after too many failed attempts. ${err.message}`);
      } else {
        setError(err instanceof ApiError && err.status === 401 ? 'Incorrect email or password.' : errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const isDev = import.meta.env.DEV || import.meta.env.VITE_USE_MOCKS === 'true';

  return (
    <div className="login-page">
      <main className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <img src="/icon.svg" alt="" width={44} height={44} />
          <div>
            <h1 id="login-title">Fuel Monitoring System</h1>
            <p className="muted">Republic of Zambia · stations, ERB and ZRA</p>
          </div>
        </div>
        {sessionExpired && (
          <div className="alert alert-warn" role="status">
            Your session expired. Please sign in again.
          </div>
        )}
        <form onSubmit={submit} className="form" noValidate>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {needTotp && (
            <div className="field">
              <label htmlFor="totp">Authentication code</label>
              <input id="totp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={8} required value={totp} onChange={(e) => setTotp(e.target.value)} autoFocus />
              <small className="muted">Enter the 6-digit code from your authenticator app.</small>
            </div>
          )}
          {error && (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy || !email || !password || (needTotp && !totp)}>
            {busy ? <Spinner size={16} /> : null} Sign in
          </button>
        </form>
        {isDev && (
          <details className="details demo-users">
            <summary>Demo accounts (development only)</summary>
            <p className="muted small">Password for all demo accounts is in db/seed/001_demo.sql.</p>
            <ul>
              {DEMO.map((d) => (
                <li key={d}>
                  <button type="button" className="link" onClick={() => setEmail(d)}>
                    {d}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </main>
    </div>
  );
}
