import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { ApiProvider } from '../src/api/ApiContext';
import { ApiClient } from '../src/api/client';
import type { DashboardOverview } from '../src/api/types';
import HomeScreen from '../src/screens/HomeScreen';
import { SettingsProvider } from '../src/settings/SettingsProvider';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const overview: DashboardOverview = {
  stations_total: 2,
  stations_online: 1,
  stations_offline: 1,
  sales_today: { volume_l: 12345.6, amount: 391234.56, tx_count: 812 },
  by_product: [
    { product_code: 'PETROL', sales_today_l: 7000, sales_today_amount: 222950, stock_l: 21000, capacity_l: 60000 },
    { product_code: 'DIESEL', sales_today_l: 5345.6, sales_today_amount: 168284.56, stock_l: 60000, capacity_l: 80000 },
  ],
  low_stock_tanks: [
    { station_id: 's2', station_name: 'Zambezi Kabwe North', tank_no: 1, product_code: 'PETROL', product_volume_l: 4500, capacity_l: 30000, fill_pct: 15 },
  ],
  open_alerts: { critical: 2, warning: 3 },
};

function setup(fetchImpl: typeof fetch) {
  const api = new ApiClient({
    getBaseUrl: () => 'http://api.test',
    refreshStore: { get: async () => 'r', set: async () => {}, clear: async () => {} },
    fetchImpl,
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
  return render(
    <SettingsProvider initial={{}}>
      <QueryClientProvider client={qc}>
        <ApiProvider client={api} user={{ id: 'u1', email: 'o@x', full_name: 'Zambezi Owner', role: 'owner', company_id: 'c1', province_id: null }}>
          <HomeScreen />
        </ApiProvider>
      </QueryClientProvider>
    </SettingsProvider>,
  );
}

describe('HomeScreen', () => {
  it('renders dashboard figures from /dashboard/overview', async () => {
    const fetchMock = jest.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('http://api.test/api/v1/dashboard/overview');
      return new Response(JSON.stringify(overview), { status: 200 });
    }) as unknown as typeof fetch;

    await setup(fetchMock);

    expect(await screen.findByTestId('sales-amount')).toHaveTextContent('K 391,234.56');
    expect(screen.getByTestId('sales-volume')).toHaveTextContent('12,346 L');
    expect(screen.getByTestId('sales-tx')).toHaveTextContent('812 sales');
    expect(screen.getByText('1/2')).toBeTruthy();
    expect(screen.getByText('1 offline / degraded')).toBeTruthy();
    expect(screen.getByText('2 critical')).toBeTruthy();
    expect(screen.getByText('Zambezi Kabwe North')).toBeTruthy();
    expect(screen.getByText('15%')).toBeTruthy();
    expect(screen.getByText('Welcome, Zambezi Owner')).toBeTruthy();
  });

  it('shows an error with retry when the API fails and nothing is cached', async () => {
    const fetchMock = jest.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'internal', message: 'Database unavailable' } }), { status: 503 }),
    ) as unknown as typeof fetch;
    await setup(fetchMock);
    await waitFor(() => expect(screen.getByText('Database unavailable')).toBeTruthy());
    expect(screen.getByText('Try again')).toBeTruthy();
  });
});
