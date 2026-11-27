import { useCallback, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const KEY = 'fms.theme';

function initial(): Theme {
  try {
    const s = localStorage.getItem(KEY);
    if (s === 'light' || s === 'dark') return s;
  } catch {
    /* ignore */
  }
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const n = t === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(KEY, n);
      } catch {
        /* ignore */
      }
      return n;
    });
  }, []);
  return { theme, toggle };
}

export function applyInitialTheme() {
  document.documentElement.dataset.theme = initial();
}

/** Chart colours per product (mid-tone hues legible on light and dark surfaces). */
export const PRODUCT_COLORS: Record<string, string> = {
  PETROL: '#16a34a',
  DIESEL: '#2563eb',
  KEROSENE: '#d97706',
  JETA1: '#9333ea',
  LPG: '#db2777',
};
export const productColor = (c: string | null | undefined) => PRODUCT_COLORS[c ?? ''] ?? '#64748b';
export const SERIES = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#db2777', '#0891b2', '#dc2626', '#65a30d', '#7c3aed', '#ea580c'];
