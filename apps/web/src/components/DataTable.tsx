import { useMemo, useState, type ReactNode } from 'react';
import { cx, Empty } from './ui';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render?: (row: T) => ReactNode;
  /** value used for sorting (defaults to row[key]) */
  sortValue?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  className?: string;
}

export function DataTable<T>({
  rows, columns, rowKey, emptyTitle = 'No records', emptyText, caption, rowClassName, onRowClick, dense,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T, i: number) => string | number;
  emptyTitle?: string;
  emptyText?: ReactNode;
  caption?: string;
  rowClassName?: (row: T) => string | undefined;
  onRowClick?: (row: T) => void;
  dense?: boolean;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const get = col.sortValue ?? ((r: T) => (r as Record<string, unknown>)[col.key] as string | number | null | undefined);
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const na = Number(va);
      const nb = Number(vb);
      const cmp = !Number.isNaN(na) && !Number.isNaN(nb) && va !== '' && vb !== '' ? na - nb : String(va).localeCompare(String(vb));
      return cmp * sort.dir;
    });
  }, [rows, columns, sort]);

  if (!rows.length) return <Empty title={emptyTitle}>{emptyText}</Empty>;

  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={caption ?? 'Data table'}>
      <table className={cx('table', dense && 'table-dense')}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const canSort = c.sortable !== false;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={cx(c.align && `ta-${c.align}`, c.className)}
                  aria-sort={active ? (sort!.dir === 1 ? 'ascending' : 'descending') : undefined}
                >
                  {canSort ? (
                    <button
                      type="button"
                      className="th-sort"
                      onClick={() => setSort(active ? (sort!.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 })}
                    >
                      {c.header}
                      <span aria-hidden="true" className="sort-ind">
                        {active ? (sort!.dir === 1 ? '▲' : '▼') : ''}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr
              key={rowKey(r, i)}
              className={cx(rowClassName?.(r), onRowClick && 'row-click')}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={onRowClick ? (e) => (e.key === 'Enter' ? onRowClick(r) : undefined) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className={cx(c.align && `ta-${c.align}`, c.className)}>
                  {c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
