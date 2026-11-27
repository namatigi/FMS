import { Redirect } from 'expo-router';
import React from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Loading, Screen } from '../components/ui';
import LoginScreen from '../screens/LoginScreen';

export default function LoginRoute() {
  const { status } = useAuth();
  if (status === 'signedIn') return <Redirect href="/" />;
  if (status === 'loading') return <Screen><Loading /></Screen>;
  return <LoginScreen />;
}
