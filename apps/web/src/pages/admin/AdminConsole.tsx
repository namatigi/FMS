import { useMemo, useState } from 'react';
import { NavLink, Navigate, useParams } from 'react-router-dom';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { autoFormat } from '../../components/AutoTable';
import { DataTable, type Column } from '../../components/DataTable';
import { Card, CopyButton, Empty, Field, Modal, PageHeader, QueryView } from '../../components/ui';
import { humanize } from '../../lib/format';
import { ENTITIES, entityById, extractSecret, toPayload, validate, type EntityDef, type FieldDef, type FormValues, type Opt } from './entities';

type Row = Record<string, unknown>;

function useRefData(def: EntityDef) {
  const refs = Array.from(new Set(def.fields.map((f) => f.ref?.entity).filter(Boolean) as string[]));
  const results = useQueries({
    queries: refs.map((e) => ({ queryKey: ['admin', e], queryFn: () => api.adminList(e), staleTime: 60_000 })),
  });
  return Object.fromEntries(refs.map((e, i) => [e, (results[i].data ?? []) as Row[]]));
}

function optionsFor(f: FieldDef, refData: Record<string, Row[]>, form: FormValues): Opt[] {
  if (f.options) return f.options;
  if (!f.ref) return [];
  return (refData[f.ref.entity] ?? []).filter((r) => !f.ref!.filter || f.ref!.filter(r, form)).map((r) => ({ value: String(r.id), label: f.ref!.label(r) }));
}

function FieldInput({ f, value, onChange, opts, error, disabled }: { f: FieldDef; value: unknown; onChange: (v: unknown) => void; opts: Opt[]; error?: string; disabled?: boolean }) {
  if (f.type === 'checkbox')
    return (
      <div className="field field-check">
        <label>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {f.label}
        </label>
      </div>
    );
  if (f.type === 'multi') {
    const arr = Array.isArray(value) ? (value as string[]).map(String) : [];
    return (
      <fieldset className={`field fieldset ${error ? 'field-error' : ''}`}>
        <legend>
          {f.label}
          {f.required && ' *'}
        </legend>
        <div className="check-grid">
          {opts.length === 0 && <span className="muted">No options</span>}
          {opts.map((o) => (
            <label key={o.value}>
              <input type="checkbox" checked={arr.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))} /> {o.label}
            </label>
          ))}
        </div>
        {error && <small className="error-text">{error}</small>}
      </fieldset>
    );
  }
  return (
    <Field label={`${f.label}${f.required ? ' *' : ''}`} hint={f.hint} error={error}>
      {(id) =>
        f.type === 'select' ? (
          <select id={id} value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} disabled={disabled}>
            <option value="">{f.required ? 'Select…' : '— none —'}</option>
            {opts.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={id}
            type={f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : 'text'}
            step={f.step ?? (f.type === 'number' ? 'any' : undefined)}
            autoComplete={f.type === 'password' ? 'new-password' : 'off'}
            placeholder={f.placeholder}
            value={value == null ? '' : String(value)}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={!!error}
          />
        )
      }
    </Field>
  );
}

function EditForm({ def, initial, onClose, onCreated }: { def: EntityDef; initial: Row | null; onClose: () => void; onCreated: (res: Row) => void }) {
  const qc = useQueryClient();
  const isCreate = !initial;
  const refData = useRefData(def);
  const [form, setForm] = useState<FormValues>(() => {
    const base: FormValues = {};
    for (const f of def.fields) {
      const v = initial?.[f.name];
      base[f.name] = f.type === 'password' ? '' : f.type === 'checkbox' ? (v ?? true) : f.type === 'multi' ? (Array.isArray(v) ? v.map(String) : []) : v == null ? '' : String(v);
    }
    return base;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const m = useMutation({
    mutationFn: (payload: FormValues) => (isCreate ? api.adminCreate(def.path, payload) : api.adminUpdate(def.path, initial!.id as string, payload)),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['admin', def.id] });
      if (isCreate) onCreated(res ?? {});
      onClose();
    },
  });
  return (
    <Modal
      title={`${isCreate ? 'New' : 'Edit'} ${def.singular}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="admin-form" className="btn btn-primary" disabled={m.isPending}>{m.isPending ? 'Saving…' : isCreate ? 'Create' : 'Save'}</button>
        </>
      }
    >
      <form
        id="admin-form"
        className="form form-grid"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const errs = validate(def, form, isCreate);
          setErrors(errs);
          if (Object.keys(errs).length) return;
          m.mutate(toPayload(def, form, isCreate));
        }}
      >
        {def.fields
          .filter((f) => (!f.show || f.show(form)) && (!f.createOnly || isCreate))
          .map((f) => (
            <FieldInput key={f.name} f={f} disabled={!isCreate && f.immutable} value={form[f.name]} opts={optionsFor(f, refData, form)} error={errors[f.name]} onChange={(v) => setForm((s) => ({ ...s, [f.name]: v }))} />
          ))}
        {m.isError && <div className="alert alert-error span-all" role="alert">{errorMessage(m.error)}</div>}
      </form>
    </Modal>
  );
}

function SecretOnce({ secret, def, onClose }: { secret: { label: string; value: string }; def: EntityDef; onClose: () => void }) {
  return (
    <Modal title={`${def.singular[0].toUpperCase()}${def.singular.slice(1)} created`} onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>I have stored it securely</button>}>
      <div className="alert alert-warn" role="alert">
        <strong>Copy this {humanize(secret.label).toLowerCase()} now.</strong> It is shown only once and cannot be retrieved later. Store it in a secrets vault; if lost, create a new one and revoke this.
      </div>
      <div className="secret-box">
        <code className="mono" aria-label="Generated key">{secret.value}</code>
        <CopyButton text={secret.value} />
      </div>
    </Modal>
  );
}

function EntityPanel({ def }: { def: EntityDef }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', def.id], queryFn: () => api.adminList(def.path) });
  const refData = useRefData(def);
  const [editing, setEditing] = useState<Row | null | undefined>(undefined);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [filter, setFilter] = useState('');
  const rotate = useMutation({
    mutationFn: (id: string) => api.adminRotate(def.path, id),
    onSuccess: (res) => {
      const s = extractSecret(res);
      if (s) setSecret(s);
      qc.invalidateQueries({ queryKey: ['admin', def.id] });
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.adminDelete(def.path, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', def.id] }),
  });

  const refLabel = (f: FieldDef | undefined, v: unknown) => {
    if (!f?.ref || v == null) return null;
    const r = (refData[f.ref.entity] ?? []).find((x) => String(x.id) === String(v));
    return r ? f.ref.label(r) : String(v).slice(0, 8);
  };

  const cols: Column<Row>[] = useMemo(
    () => [
      ...def.columns.map((k) => {
        const f = def.fields.find((x) => x.name === k);
        return {
          key: k,
          header: f?.label ?? humanize(k),
          render: (r: Row) => {
            if (f?.ref) return refLabel(f, r[k]) ?? '—';
            if (f?.options && f.type === 'select') return f.options.find((o) => o.value === String(r[k]))?.label ?? autoFormat(k, r[k]);
            if (typeof r[k] === 'boolean') return r[k] ? 'Yes' : 'No';
            return autoFormat(k, r[k]);
          },
        };
      }),
      {
        key: '_actions', header: '', sortable: false,
        render: (r: Row) => (
          <span className="row-actions">
            {!def.noEdit && <button type="button" className="btn btn-sm" onClick={() => setEditing(r)}>Edit</button>}
            {def.rotatable && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={rotate.isPending}
                onClick={() => {
                  if (window.confirm(`Rotate the secret for this ${def.singular}? The current one stops working immediately.`)) rotate.mutate(String(r.id));
                }}
              >
                Rotate key
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => {
                if (window.confirm(`Delete this ${def.singular}? This cannot be undone.`)) del.mutate(String(r.id));
              }}
            >
              Delete
            </button>
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [def, refData, rotate.isPending],
  );

  const rows = (q.data ?? []).filter((r) => !filter || JSON.stringify(r).toLowerCase().includes(filter.toLowerCase()));

  return (
    <Card
      title={def.label}
      actions={
        <>
          <input type="search" aria-label={`Filter ${def.label}`} placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button type="button" className="btn btn-primary" onClick={() => setEditing(null)}>New {def.singular}</button>
        </>
      }
    >
      {del.isError && <div className="alert alert-error" role="alert">{errorMessage(del.error)}</div>}
      {rotate.isError && <div className="alert alert-error" role="alert">{errorMessage(rotate.error)}</div>}
      <QueryView q={q} isEmpty={() => false}>
        {() => <DataTable dense caption={def.label} rows={rows} rowKey={(r, i) => String(r.id ?? i)} columns={cols} emptyTitle={`No ${def.label.toLowerCase()}`} />}
      </QueryView>
      {editing !== undefined && (
        <EditForm
          def={def}
          initial={editing}
          onClose={() => setEditing(undefined)}
          onCreated={(res) => {
            const s = def.secretOnCreate ? extractSecret(res) : null;
            if (s) setSecret(s);
          }}
        />
      )}
      {secret && <SecretOnce secret={secret} def={def} onClose={() => setSecret(null)} />}
    </Card>
  );
}

function AuditLog() {
  const [action, setAction] = useState('');
  const [entity, setEntity] = useState('');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const q = useQuery({
    queryKey: ['admin', 'audit-log', action, entity, cursor],
    queryFn: () => api.auditLog({ action: action || undefined, entity: entity || undefined, limit: 100, cursor }),
    placeholderData: (p) => p,
  });
  return (
    <Card title="Audit log" subtitle="Every write, price change, export and login (newest first)">
      <div className="toolbar">
        <Field label="Action">{(id) => <input id={id} value={action} placeholder="e.g. auth.login" onChange={(e) => { setAction(e.target.value); setCursors([undefined]); }} />}</Field>
        <Field label="Entity">{(id) => <input id={id} value={entity} placeholder="e.g. station" onChange={(e) => { setEntity(e.target.value); setCursors([undefined]); }} />}</Field>
      </div>
      <QueryView q={q} isEmpty={() => false}>
        {(page) => (
          <>
            <DataTable
              dense
              caption="Audit log"
              rows={page.items ?? []}
              rowKey={(r, i) => String(r.id ?? i)}
              emptyTitle="No audit entries"
              columns={[
                { key: 'occurred_at', header: 'When', render: (r) => autoFormat('occurred_at', r.occurred_at) },
                { key: 'actor_type', header: 'Actor', render: (r) => `${r.actor_type ?? ''}${r.actor_id ? ` · ${String(r.actor_id).slice(0, 12)}` : ''}` },
                { key: 'action', header: 'Action', render: (r) => <span className="mono">{String(r.action)}</span> },
                { key: 'entity', header: 'Entity', render: (r) => `${r.entity ?? '—'}${r.entity_id ? ` · ${String(r.entity_id).slice(0, 12)}` : ''}` },
                { key: 'details', header: 'Details', sortable: false, render: (r) => (r.details ? <code className="mono small">{JSON.stringify(r.details).slice(0, 120)}</code> : '—') },
              ]}
            />
            <div className="pager">
              <button type="button" className="btn btn-sm" disabled={cursors.length <= 1} onClick={() => setCursors((c) => c.slice(0, -1))}>← Previous</button>
              <button type="button" className="btn btn-sm" disabled={!page.next_cursor} onClick={() => setCursors((c) => [...c, page.next_cursor ?? undefined])}>Next →</button>
            </div>
          </>
        )}
      </QueryView>
    </Card>
  );
}

export default function AdminConsole() {
  const { entity } = useParams();
  if (!entity) return <Navigate to="/admin/companies" replace />;
  const def = entityById(entity);
  return (
    <>
      <PageHeader title="Admin console" subtitle="Reference data, devices, users and integrations" />
      <div className="admin-layout">
        <nav className="subnav" aria-label="Admin sections">
          {ENTITIES.map((e) => (
            <NavLink key={e.id} to={`/admin/${e.id}`}>
              {e.label}
            </NavLink>
          ))}
          <NavLink to="/admin/audit-log">Audit log</NavLink>
        </nav>
        <div>{entity === 'audit-log' ? <AuditLog /> : def ? <EntityPanel key={def.id} def={def} /> : <Empty title="Unknown section" />}</div>
      </div>
    </>
  );
}
