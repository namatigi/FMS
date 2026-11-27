import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Badge, Card, CopyButton, Field, PageHeader, QueryView } from '../components/ui';

/** TOTP MFA management (core-api: erb_* and platform_admin). */
export default function Security() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.meDetails });
  const [code, setCode] = useState('');
  const enroll = useMutation({ mutationFn: api.mfaEnroll });
  const verify = useMutation({
    mutationFn: () => api.mfaVerify(code.trim()),
    onSuccess: () => {
      setCode('');
      enroll.reset();
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const disable = useMutation({
    mutationFn: () => api.mfaDisable(code.trim()),
    onSuccess: () => {
      setCode('');
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const codeOk = /^\d{6,8}$/.test(code.trim());

  return (
    <>
      <PageHeader title="Account security" subtitle="Two-factor authentication (TOTP) for regulator and administrator accounts" />
      <Card>
        <QueryView q={me} isEmpty={() => false}>
          {(u) =>
            u.mfa_enabled ? (
              <form className="form form-narrow" onSubmit={(e) => { e.preventDefault(); disable.mutate(); }}>
                <p>
                  Status: <Badge tone="good">MFA enabled</Badge>
                </p>
                <Field label="Current authentication code (to disable)">
                  {(id) => <input id={id} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />}
                </Field>
                <button type="submit" className="btn btn-danger" disabled={!codeOk || disable.isPending}>Disable MFA</button>
                {disable.isError && <div className="alert alert-error" role="alert">{errorMessage(disable.error)}</div>}
              </form>
            ) : !enroll.data ? (
              <div className="form form-narrow">
                <p>
                  Status: <Badge tone="warn">MFA not enabled</Badge>
                </p>
                <p className="muted">Protect your account with an authenticator app (e.g. Google Authenticator, Microsoft Authenticator).</p>
                <button type="button" className="btn btn-primary" onClick={() => enroll.mutate()} disabled={enroll.isPending}>
                  {enroll.isPending ? 'Starting…' : 'Set up MFA'}
                </button>
                {enroll.isError && <div className="alert alert-error" role="alert">{errorMessage(enroll.error)}</div>}
              </div>
            ) : (
              <form className="form form-narrow" onSubmit={(e) => { e.preventDefault(); verify.mutate(); }}>
                <p>1. Add this account to your authenticator app using the setup key or link below.</p>
                <div className="secret-box">
                  <code className="mono" aria-label="TOTP setup key">{enroll.data.secret}</code>
                  <CopyButton text={enroll.data.secret} />
                </div>
                <p className="small">
                  <a href={enroll.data.otpauth_url}>Open in authenticator app</a> (on this device)
                </p>
                <p>2. Enter the 6-digit code it shows to confirm.</p>
                <Field label="Authentication code">
                  {(id) => <input id={id} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />}
                </Field>
                <button type="submit" className="btn btn-primary" disabled={!codeOk || verify.isPending}>Confirm and enable</button>
                {verify.isError && <div className="alert alert-error" role="alert">{errorMessage(verify.error)}</div>}
              </form>
            )
          }
        </QueryView>
      </Card>
    </>
  );
}
