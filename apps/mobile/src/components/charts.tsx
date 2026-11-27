import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, View } from 'react-native';
import Svg, { G, Rect, Text as SvgText } from 'react-native-svg';
import { clampPct, formatDaysOfCover, formatLitres, formatMm, formatPct, formatRelative, formatTemp, productLabel, toNum } from '../lib/format';
import type { Tank } from '../api/types';
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
