/**
 * Deterministic invoice number (DESIGN §7):
 *   <station_code>-P<pump>-<pts_transaction_no>-<yyyyMMddHHmmss of ended_at in Africa/Lusaka>
 * No zero padding (e.g. LUS-0001-P3-1234-20261127100130), identical to buildInvoiceNo() in
 * packages/zra-client so the edge and the cloud fiscal-worker derive the same number for a sale.
 * (Candidate for a shared helper in @fms/shared.)
 */
const LUSAKA_OFFSET_MS = 2 * 3600_000; // Africa/Lusaka = UTC+02:00 all year, no DST

export function lusakaStamp(iso: string | Date): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  if (!Number.isFinite(t)) throw new Error(`invalid timestamp ${String(iso)}`);
  return new Date(t + LUSAKA_OFFSET_MS).toISOString().slice(0, 19).replace(/[-T:]/g, '');
}

export function invoiceNo(stationCode: string, pumpNo: number, ptsTransactionNo: number, endedAt: string | Date): string {
  return `${stationCode}-P${pumpNo}-${ptsTransactionNo}-${lusakaStamp(endedAt)}`;
}
