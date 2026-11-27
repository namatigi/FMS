import type { FastifyRequest } from 'fastify';
import type { Queryable } from './types.js';
import type { Principal } from './scope.js';

export interface AuditEntry {
  action: string;
  entity?: string | null;
  entity_id?: string | number | null;
  details?: Record<string, unknown> | null;
  actor_type?: 'user' | 'api_client' | 'system' | 'anonymous';
  actor_id?: string | null;
}

/** Insert a row into fms.audit_log. Pass the transaction client for writes so audit commits atomically. */
export async function audit(db: Queryable, req: FastifyRequest | null, e: AuditEntry): Promise<void> {
  const pr: Principal | undefined = req?.principal;
  const actorType = e.actor_type ?? (pr ? pr.kind : 'anonymous');
  const actorId = e.actor_id ?? pr?.id ?? null;
  const details = { ...(e.details ?? {}), ...(req ? { ip: req.ip, request_id: req.id } : {}) };
  await db.query(
    `INSERT INTO fms.audit_log (actor_type, actor_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5,$6)`,
    [actorType, actorId, e.action, e.entity ?? null, e.entity_id != null ? String(e.entity_id) : null, JSON.stringify(details)],
  );
}
