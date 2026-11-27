import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { PRODUCT_CODES, PROVINCES, productLabel, provinceName } from '../../types';
import { Field } from '../../components/ui';

/**
 * Province scope for regulator pages. erb_provincial users are locked to their province
 * (the selector is hidden); national users and admins can choose "All provinces" or one.
 */
export function useProvinceScope(initial = '') {
  const { user } = useAuth();
  const locked = user?.role === 'erb_provincial';
  const [sel, setSel] = useState(initial);
  const provinceId = locked ? String(user?.province_id ?? '') : sel;
  return { provinceId, setProvinceId: setSel, locked, label: provinceId ? provinceName(Number(provinceId)) : 'All provinces' };
}

export function ProvinceSelect({ scope, allowAll = true }: { scope: ReturnType<typeof useProvinceScope>; allowAll?: boolean }) {
  if (scope.locked) return <span className="badge badge-info scope-chip">Province: {scope.label}</span>;
  return (
    <Field label="Province">
      {(id) => (
        <select id={id} value={scope.provinceId} onChange={(e) => scope.setProvinceId(e.target.value)}>
          {allowAll && <option value="">All provinces</option>}
          {PROVINCES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function ProductSelect({ value, onChange, allowAll = true, label = 'Product' }: { value: string; onChange: (v: string) => void; allowAll?: boolean; label?: string }) {
  return (
    <Field label={label}>
      {(id) => (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {allowAll && <option value="">All products</option>}
          {PRODUCT_CODES.map((p) => (
            <option key={p} value={p}>
              {productLabel(p)}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** Risk band from days of cover (ERB reserve policy placeholder: <7 high, <15 medium). */
export function docRisk(days: number | null | undefined): 'high' | 'medium' | 'low' | 'n/a' {
  if (days == null || !Number.isFinite(days)) return 'n/a';
  if (days < 7) return 'high';
  if (days < 15) return 'medium';
  return 'low';
}
