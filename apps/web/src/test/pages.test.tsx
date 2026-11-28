import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { handlers } from '../mocks/handlers';
import { AuthProvider } from '../auth/AuthContext';
import { tokenStore } from '../auth/tokenStore';
import { api } from '../api/endpoints';
import Dashboard from '../pages/owner/Dashboard';
import Login from '../pages/Login';
import Compliance from '../pages/erb/Compliance';
import { ProvinceStations } from '../pages/erb/Provinces';
import PumpsTab from '../pages/station/PumpsTab';
import App from '../App';

const server = setupServer(...handlers);
beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterAll(() => server.close());
afterEach(() => tokenStore.clear());

function wrap(ui: ReactNode, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>{ui}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function loginAs(email: string) {
  tokenStore.setSession(await api.login(email, 'ChangeMe123!'));
}

describe('pages with MSW mocks', () => {
  it('owner dashboard renders KPIs and sales by product', async () => {
    await loginAs('owner@zambezi.local');
    wrap(<Dashboard />);
    expect(await screen.findByText('Sales today (amount)')).toBeInTheDocument();
    expect(screen.getByText('Stations online')).toBeInTheDocument();
    // owner sees only Zambezi stations (5 in fixtures)
    expect(screen.getByText(/\/ 5$/)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Sales today by product' });
    expect(within(table).getByText('Petrol')).toBeInTheDocument();
    expect(within(table).getAllByText(/^K [\d,]+\.\d{2}$/).length).toBeGreaterThan(0);
  });

  it('login page signs in and routes the ERB provincial user to the regulator portal', async () => {
    wrap(
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={<App />} />
      </Routes>,
      '/login',
    );
    await userEvent.type(screen.getByLabelText('Email'), 'erb.cop@erb.local');
    await userEvent.type(screen.getByLabelText('Password'), 'ChangeMe123!');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByRole('heading', { name: 'Copperbelt overview' }, { timeout: 5000 })).toBeInTheDocument();
  });

  it('shows an error for wrong credentials', async () => {
    wrap(<Login />, '/login');
    await userEvent.type(screen.getByLabelText('Email'), 'owner@zambezi.local');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password');
  });

  it('asks for a TOTP code when the API answers mfa_required', async () => {
    let sentTotp: string | undefined;
    server.use(
      http.post('*/api/v1/auth/login', async ({ request }) => {
        const b = (await request.json()) as { totp_code?: string };
        sentTotp = b.totp_code;
        if (!b.totp_code) return HttpResponse.json({ error: { code: 'mfa_required', message: 'TOTP code required' } }, { status: 401 });
        return HttpResponse.json({ error: { code: 'invalid_mfa_code', message: 'invalid TOTP code' } }, { status: 401 });
      }),
    );
    wrap(<Login />, '/login');
    await userEvent.type(screen.getByLabelText('Email'), 'erb@erb.local');
    await userEvent.type(screen.getByLabelText('Password'), 'ChangeMe123!');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    const totp = await screen.findByLabelText('Authentication code');
    await userEvent.type(totp, '654321');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect authentication code');
    expect(sentTotp).toBe('654321');
    server.resetHandlers();
  });

  it('erb_provincial compliance hides the province selector', async () => {
    await loginAs('erb.cop@erb.local');
    wrap(<Compliance />);
    expect(await screen.findByText('Price violations')).toBeInTheDocument();
    expect(screen.getByText('Province: Copperbelt')).toBeInTheDocument();
    expect(screen.queryByLabelText('Province')).not.toBeInTheDocument();
    // Copperbelt fixture has an offline station (Ndola)
    const offline = screen.getByRole('table', { name: 'Offline stations' });
    expect(within(offline).getByText('Copper Fuels Ndola Broadway')).toBeInTheDocument();
  });

  it('province stations link code and name to the station page', async () => {
    await loginAs('erb@erb.local');
    wrap(
      <Routes>
        <Route path="/erb/provinces/:id" element={<ProvinceStations />} />
      </Routes>,
      '/erb/provinces/2',
    );
    const table = await screen.findByRole('table', { name: 'Stations in Copperbelt' });
    const code = within(table).getByRole('link', { name: 'COP-0002' });
    const name = within(table).getByRole('link', { name: 'Copper Fuels Ndola Broadway' });
    expect(code.getAttribute('href')).toMatch(/^\/stations\/[^/]+$/);
    expect(name.getAttribute('href')).toBe(code.getAttribute('href'));
  });

  it('pumps tab shows each pump with its number and nozzle totalizers', async () => {
    await loginAs('owner@zambezi.local');
    const stations = await api.stations();
    wrap(<PumpsTab stationId={stations[0].id} refetchInterval={0} />);
    const pump1 = await screen.findByRole('article', { name: 'Pump 1' });
    expect(within(pump1).getByText('Idle')).toBeInTheDocument();
    expect(within(await screen.findByRole('article', { name: 'Pump 2' })).getByText('Offline')).toBeInTheDocument();
    expect(within(pump1).getByRole('img', { name: /Pump 1 with \d nozzles?/ })).toBeInTheDocument();
    const totals = within(pump1).getByRole('table', { name: 'Pump 1 totalizers' });
    expect(within(totals).getByText('Volume totalizer')).toBeInTheDocument();
    expect(within(totals).getAllByText(/^[\d,]+\.\d{2} L$/).length).toBeGreaterThan(0);
    expect(within(totals).getAllByText(/^K [\d,]+\.\d{2}$/).length).toBeGreaterThan(0);
  });
});
