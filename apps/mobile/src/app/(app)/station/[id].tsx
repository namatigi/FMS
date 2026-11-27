import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import StationDetailScreen from '../../../screens/StationDetailScreen';

export default function StationRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <StationDetailScreen id={String(id)} />;
}
