export interface CsvColumn {
  key: string;
  label?: string;
}

export function toCsv(rows: Record<string, unknown>[], columns?: CsvColumn[]): string {
  const cols = columns ?? Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).map((key) => ({ key, label: key }));
  const esc = (v: unknown) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map((c) => esc(c.label ?? c.key)).join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c.key])).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function downloadBlob(content: BlobPart, filename: string, type = 'text/csv;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
