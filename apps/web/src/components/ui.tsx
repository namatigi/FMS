import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { errorMessage } from '../api/client';
import { formatDateTime, freshness, timeAgo } from '../lib/format';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function FullPageLoader({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="fullpage-center" role="status" aria-live="polite">
      <Spinner size={28} />
      <span>{label}</span>
    </div>
  );
}

export function Loading({ label = 'Loading…', rows = 0 }: { label?: string; rows?: number }) {
  if (rows > 0)
    return (
      <div role="status" aria-label={label} className="skeleton-list">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="skeleton" />
        ))}
      </div>
    );
  return (
    <div className="state" role="status" aria-live="polite">
      <Spinner /> <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Could not load data' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div className="state state-error" role="alert">
      <strong>{title}</strong>
      <span>{errorMessage(error)}</span>
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ title = 'Nothing to show', children }: { title?: string; children?: ReactNode }) {
  return (
    <div className="state state-empty">
      <strong>{title}</strong>
      {children && <span>{children}</span>}
    </div>
  );
}

/** Renders loading / error / empty states for a query, otherwise the children with data. */
export function QueryView<T>({
  q, children, empty, isEmpty, loadingRows = 3,
}: {
  q: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  empty?: ReactNode;
  isEmpty?: (d: T) => boolean;
  loadingRows?: number;
}) {
  if (q.isPending) return <Loading rows={loadingRows} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data as T;
  const emptyNow = isEmpty ? isEmpty(d) : Array.isArray(d) && d.length === 0;
  if (emptyNow) return <>{empty ?? <Empty />}</>;
  return <>{children(d)}</>;
}

export function Card({ title, actions, children, className, subtitle }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'warn' | 'bad' | 'info' }) {
  return (
    <div className={cx('kpi', tone && `kpi-${tone}`)}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';
export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function ConnectivityBadge({ value }: { value: string | null | undefined }) {
  const v = value || 'unknown';
  const tone: Tone = v === 'online' ? 'good' : v === 'degraded' ? 'warn' : v === 'offline' ? 'bad' : 'neutral';
  return (
    <Badge tone={tone}>
      <span className={`dot dot-${tone}`} aria-hidden="true" />
      {v}
    </Badge>
  );
}

export function FiscalBadge({ value }: { value: string | null | undefined }) {
  const v = value || 'unknown';
  const tone: Tone = v === 'signed' || v === 'printed' ? 'good' : v === 'pending' ? 'warn' : v === 'failed' ? 'bad' : 'neutral';
  return <Badge tone={tone}>{v}</Badge>;
}

export function SeverityBadge({ value }: { value: string }) {
  const tone: Tone = value === 'critical' ? 'bad' : value === 'warning' ? 'warn' : 'info';
  return <Badge tone={tone}>{value}</Badge>;
}

export function RiskBadge({ value }: { value: string | null | undefined }) {
  const v = value || 'n/a';
  const tone: Tone = v === 'high' || v === 'critical' ? 'bad' : v === 'medium' ? 'warn' : v === 'low' ? 'good' : 'neutral';
  return <Badge tone={tone}>{v}</Badge>;
}

export function riskTone(v: string | null | undefined): Tone {
  return v === 'high' || v === 'critical' ? 'bad' : v === 'medium' ? 'warn' : v === 'low' ? 'good' : 'neutral';
}

/** "Last reading 3 min ago" with colour by age; re-renders every 30 s. */
export function Freshness({ at, label = 'Last reading' }: { at: string | null | undefined; label?: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const f = freshness(at);
  return (
    <span className={`freshness freshness-${f}`} title={at ? formatDateTime(at) : 'No data received'}>
      <span className={`dot dot-${f === 'fresh' ? 'good' : f === 'stale' ? 'warn' : 'bad'}`} aria-hidden="true" />
      {label} {timeAgo(at)}
    </span>
  );
}

export function Field({ label, children, hint, error }: { label: string; children: (id: string) => ReactNode; hint?: string; error?: string | null }) {
  const id = useId();
  return (
    <div className={cx('field', error && 'field-error')}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && !error && <small className="muted">{hint}</small>}
      {error && <small className="error-text">{error}</small>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('input, select, textarea, button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && el) {
        const f = Array.from(el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea')).filter((x) => !x.hasAttribute('disabled'));
        if (!f.length) return;
        const [a, b] = [f[0], f[f.length - 1]];
        if (e.shiftKey && document.activeElement === a) {
          b.focus();
          e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === b) {
          a.focus();
          e.preventDefault();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 2000);
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  );
}

export function DateRange({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  return (
    <div className="date-range" role="group" aria-label="Date range">
      <label>
        <span className="sr-only">From</span>
        <input type="date" value={from} max={to} onChange={(e) => onChange(e.target.value, to)} aria-label="From date" />
      </label>
      <span aria-hidden="true">→</span>
      <label>
        <span className="sr-only">To</span>
        <input type="date" value={to} min={from} onChange={(e) => onChange(from, e.target.value)} aria-label="To date" />
      </label>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={cx(value === o.value && 'active')} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function FillBar({ pct, tone }: { pct: number | null | undefined; tone?: Tone }) {
  const p = Math.max(0, Math.min(100, pct ?? 0));
  const t: Tone = tone ?? (p < 20 ? 'bad' : p < 35 ? 'warn' : 'good');
  return (
    <div className="fillbar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)} aria-label="Fill level">
      <div className={`fillbar-in fill-${t}`} style={{ width: `${p}%` }} />
    </div>
  );
}
