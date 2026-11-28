import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, View } from 'react-native';
import Svg, { G, Path, Rect, Text as SvgText } from 'react-native-svg';
import {
  clampPct,
  formatDaysOfCover,
  formatLitres,
  formatMm,
  formatNumber,
  formatPct,
  formatRelative,
  formatTemp,
  formatZmw,
  productLabel,
  toNum,
} from '../lib/format';
import type { Pump, Tank } from '../api/types';
import { font, fuelColor, radius, space, useTheme } from '../theme';
import { Badge, Card, KV, Row, T } from './ui';

export interface BarDatum {
  key: string;
  label: string;
  value: number;
  display: string;
  color?: string;
}

/** Horizontal bar chart (react-native-svg); width adapts to the container. */
export function HBarChart({ data, testID }: { data: BarDatum[]; testID?: string }) {
  const t = useTheme();
  const [width, setWidth] = useState(300);
  const barH = 26;
  const gap = 18;
  const labelH = 18;
  const rowH = labelH + barH + gap;
  const max = Math.max(1, ...data.map((d) => d.value));
  const height = Math.max(rowH, data.length * rowH);
  return (
    <View testID={testID} onLayout={(e) => setWidth(e.nativeEvent.layout.width)} accessibilityRole="image"
      accessibilityLabel={data.map((d) => `${d.label} ${d.display}`).join(', ')}>
      <Svg width={width} height={height}>
        {data.map((d, i) => {
          const y = i * rowH;
          const w = Math.max(4, (d.value / max) * width);
          return (
            <G key={d.key}>
              <SvgText x={0} y={y + 14} fill={t.text} fontSize={font.sm} fontWeight="700">
                {d.label}
              </SvgText>
              <SvgText x={width} y={y + 14} fill={t.text} fontSize={font.sm} fontWeight="700" textAnchor="end">
                {d.display}
              </SvgText>
              <Rect x={0} y={y + labelH} width={width} height={barH} rx={6} fill={t.surfaceAlt} />
              <Rect x={0} y={y + labelH} width={w} height={barH} rx={6} fill={d.color ?? t.primary} />
            </G>
          );
        })}
      </Svg>
    </View>
  );
}

/** Thin progress bar for fill levels in lists. */
export function FillBar({ pct, color }: { pct: number; color: string }) {
  const t = useTheme();
  return (
    <View style={{ height: 10, backgroundColor: t.surfaceAlt, borderRadius: 5, overflow: 'hidden' }}>
      <View style={{ width: `${clampPct(pct)}%`, height: '100%', backgroundColor: color }} />
    </View>
  );
}

/** Tank card with an animated vertical fill and water layer. */
export function TankCard({ tank, testID }: { tank: Partial<Tank>; testID?: string }) {
  const t = useTheme();
  const pct = clampPct(
    tank.fill_pct ?? (tank.capacity_l ? ((toNum(tank.product_volume_l) ?? 0) / Number(tank.capacity_l)) * 100 : 0),
  );
  const waterMm = toNum(tank.water_height_mm) ?? 0;
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: pct, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [pct, anim]);
  const color = fuelColor(t, tank.product_code);
  const low = pct < 20;
  const alarms = (tank.alarms ?? []).filter(Boolean);
  const gaugeH = 140;
  // Water shown as a band at the bottom: ~1 % of the gauge per 10 mm, min 3 px when present.
  const waterPx = waterMm > 0 ? Math.max(3, Math.min(gaugeH * 0.3, (waterMm / 10) * (gaugeH / 100))) : 0;

  return (
    <Card testID={testID} accessibilityLabel={`Tank ${tank.tank_no} ${productLabel(tank.product_code)} ${pct.toFixed(0)} percent`}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T variant="h2">
          Tank {tank.tank_no} · {productLabel(tank.product_code)}
        </T>
        {low ? <Badge label="LOW" color={t.danger} /> : null}
      </Row>
      <Row gap={space.lg} style={{ alignItems: 'stretch' }}>
        <View
          style={{
            width: 64,
            height: gaugeH,
            borderRadius: radius.md,
            borderWidth: 2,
            borderColor: t.border,
            backgroundColor: t.surfaceAlt,
            overflow: 'hidden',
            justifyContent: 'flex-end',
          }}
        >
          <Animated.View
            style={{
              height: anim.interpolate({ inputRange: [0, 100], outputRange: [0, gaugeH - 4] }),
              backgroundColor: low ? t.danger : color,
              justifyContent: 'flex-end',
            }}
          >
            {waterPx > 0 ? <View style={{ height: waterPx, backgroundColor: t.water }} /> : null}
          </Animated.View>
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <T variant="big" style={{ fontSize: 28 }} color={low ? t.danger : undefined}>
            {formatPct(pct)}
          </T>
          <KV k="Product" v={formatLitres(tank.product_volume_l)} />
          <KV k="Capacity" v={formatLitres(tank.capacity_l)} />
          <KV k="Ullage" v={formatLitres(tank.ullage_l)} />
          <KV k="Water" v={formatMm(tank.water_height_mm)} vColor={waterMm > 50 ? t.danger : undefined} />
          <KV k="Temperature" v={formatTemp(tank.temperature_c)} />
          <KV
            k="Days of cover"
            v={formatDaysOfCover(tank.days_of_cover)}
            vColor={(toNum(tank.days_of_cover) ?? 99) < 2 ? t.danger : undefined}
          />
        </View>
      </Row>
      {alarms.length ? (
        <Row style={{ flexWrap: 'wrap' }}>
          {alarms.map((a) => (
            <Badge key={a} label={a} color={t.danger} />
          ))}
        </Row>
      ) : null}
      <T variant="small">
        Probe {tank.probe_status ?? 'unknown'} · measured {formatRelative(tank.measured_at)}
      </T>
    </Card>
  );
}

/** Fuel dispenser drawing: the pump number on its display and one holster per nozzle, coloured by product. */
export function PumpIllustration({ pump, width = 64 }: { pump: Pump; width?: number }) {
  const t = useTheme();
  const nozzles = [...pump.nozzles].sort((a, b) => a.nozzle_no - b.nozzle_no);
  const slots = Math.max(1, nozzles.length);
  const w = 52 / slots;
  return (
    <Svg width={width} height={(width * 150) / 96} viewBox="0 0 96 150" accessibilityLabel={`Pump ${pump.pump_no} illustration`}>
      <Rect x={10} y={4} width={76} height={12} rx={4} fill="#F59E0B" />
      <Rect x={14} y={16} width={68} height={120} rx={6} fill={t.surfaceAlt} stroke={t.border} strokeWidth={2} />
      <Rect x={22} y={24} width={52} height={30} rx={4} fill="#0F172A" />
      <SvgText x={48} y={46} fontSize={20} fontWeight="700" fill="#FBBF24" textAnchor="middle">
        {String(pump.pump_no)}
      </SvgText>
      {nozzles.map((n, i) => {
        const x = 22 + i * w + w / 2;
        return (
          <G key={n.nozzle_no}>
            <Rect x={x - 6} y={66} width={12} height={30} rx={3} fill={fuelColor(t, n.product_code ?? undefined)} />
            <SvgText x={x} y={108} fontSize={10} fontWeight="600" fill={t.textMuted} textAnchor="middle">
              {String(n.nozzle_no)}
            </SvgText>
          </G>
        );
      })}
      <Path d="M82 70 q 12 10 6 40" stroke={t.textMuted} strokeWidth={3} strokeLinecap="round" fill="none" />
      <Rect x={6} y={136} width={84} height={10} rx={3} fill={t.border} />
    </Svg>
  );
}

/** Badge colour and label for a PTS-2 pump state. */
export function pumpStatusStyle(t: ReturnType<typeof useTheme>, status?: string): { label: string; color: string } {
  switch (status ?? 'unknown') {
    case 'idle':
      return { label: 'IDLE', color: t.success };
    case 'filling':
      return { label: 'FILLING', color: t.info };
    case 'offline':
      return { label: 'OFFLINE', color: t.danger };
    case 'unknown':
      return { label: 'STATUS UNKNOWN', color: t.textMuted };
    default:
      return { label: String(status).toUpperCase(), color: t.warning };
  }
}

/** Pump card: drawing, tanks it draws from, and each nozzle's volume and amount totalizers. */
export function PumpCard({ pump, testID }: { pump: Pump; testID?: string }) {
  const t = useTheme();
  const nozzles = [...pump.nozzles].sort((a, b) => a.nozzle_no - b.nozzle_no);
  const tanks = [...new Set(nozzles.map((n) => n.tank_no).filter((x): x is number => x != null))].sort((a, b) => a - b);
  const st = pumpStatusStyle(t, pump.status);
  return (
    <Card testID={testID} accessibilityLabel={`Pump ${pump.pump_no}, ${st.label.toLowerCase()}`}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T variant="h2">
          Pump {pump.pump_no}
          {tanks.length ? ` · Tank${tanks.length > 1 ? 's' : ''} ${tanks.join(', ')}` : ''}
        </T>
        <Badge label={st.label} color={st.color} testID={testID ? `${testID}-status` : undefined} />
      </Row>
      {!pump.configured ? <Badge label="NOT CONFIGURED" color={t.warning} /> : null}
      <Row gap={space.lg} style={{ alignItems: 'flex-start' }}>
        <PumpIllustration pump={pump} />
        <View style={{ flex: 1, gap: space.sm }}>
          {nozzles.map((n) => (
            <View key={n.nozzle_no} testID={testID ? `${testID}-nozzle-${n.nozzle_no}` : undefined} style={{ gap: 2 }}>
              <Row>
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: fuelColor(t, n.product_code ?? undefined) }} />
                <T style={{ fontWeight: '700', flex: 1 }}>
                  Nozzle {n.nozzle_no} · {n.grade_name ?? (n.product_code ? productLabel(n.product_code) : '—')}
                  {n.tank_no != null ? ` · Tank ${n.tank_no}` : ''}
                </T>
              </Row>
              <KV k="Volume totalizer" v={n.total_volume_l == null ? '—' : `${formatNumber(n.total_volume_l, 2)} L`} />
              <KV k="Amount totalizer" v={formatZmw(n.total_amount)} />
              <KV k="Today" v={formatLitres(n.today_volume_l)} />
            </View>
          ))}
        </View>
      </Row>
      <T variant="muted">
        Today {formatLitres(pump.today_volume_l)} · {formatZmw(pump.today_amount)} · {formatNumber(pump.today_tx)} tx · last sale{' '}
        {formatRelative(pump.last_sale_at)}
      </T>
    </Card>
  );
}
