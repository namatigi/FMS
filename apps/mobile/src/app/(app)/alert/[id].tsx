import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { AlertDetailScreen } from '../../../screens/AlertsScreen';

export default function AlertRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AlertDetailScreen id={String(id)} />;
}
