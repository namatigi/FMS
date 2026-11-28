import { render, screen } from '@testing-library/react-native';
import React from 'react';
import type { Pump } from '../src/api/types';
import { PumpCard } from '../src/components/charts';
import { SettingsProvider } from '../src/settings/SettingsProvider';

const nozzle = {
  configured: true,
  pts_grade_id: 1,
  price: 31.85,
  last_sale_at: new Date().toISOString(),
  today_amount: 0,
  today_tx: 0,
};

const pump: Pump = {
  pump_no: 3,
  configured: false,
  status: 'offline',
  status_at: new Date().toISOString(),
  last_sale_at: new Date().toISOString(),
  today_volume_l: 412.5,
  today_amount: 13138.13,
  today_tx: 17,
  nozzles: [
    { ...nozzle, nozzle_no: 2, grade_name: 'Diesel LSD', product_code: 'DIESEL', tank_no: 2, total_volume_l: 798874.26, total_amount: 23926284.26, today_volume_l: 200 },
    { ...nozzle, nozzle_no: 1, grade_name: 'Unleaded Petrol', product_code: 'PETROL', tank_no: 1, total_volume_l: 280084.2, total_amount: 8920682.08, today_volume_l: 212.5 },
  ],
};

describe('PumpCard', () => {
  it('shows the pump number, its tanks and each nozzle totalizer', async () => {
    await render(
      <SettingsProvider initial={{}}>
        <PumpCard pump={pump} testID="pump-3" />
      </SettingsProvider>,
    );
    expect(screen.getByText('Pump 3 · Tanks 1, 2')).toBeTruthy();
    expect(screen.getByText('NOT CONFIGURED')).toBeTruthy();
    expect(screen.getByText('OFFLINE')).toBeTruthy();
    expect(screen.getByText('Nozzle 1 · Unleaded Petrol · Tank 1')).toBeTruthy();
    expect(screen.getAllByText('Volume totalizer')).toHaveLength(2);
    expect(screen.getByText('280,084.20 L')).toBeTruthy();
    expect(screen.getByText('K 8,920,682.08')).toBeTruthy();
    // nozzles are listed in order regardless of API order
    const ids = screen.getAllByTestId(/^pump-3-nozzle-/).map((n) => n.props.testID);
    expect(ids).toEqual(['pump-3-nozzle-1', 'pump-3-nozzle-2']);
  });
});
