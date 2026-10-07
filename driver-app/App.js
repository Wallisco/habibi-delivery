import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View, ActivityIndicator } from 'react-native';

import { AppProvider, useApp } from './src/state/store';
import SignInScreen from './src/screens/SignInScreen';
import ShiftScreen from './src/screens/ShiftScreen';
import RunScreen from './src/screens/RunScreen';
import EarningsScreen from './src/screens/EarningsScreen';
import JobsScreen from './src/screens/JobsScreen';
import JobDetailScreen from './src/screens/JobDetailScreen';
import MessagesScreen from './src/screens/MessagesScreen';
import { C } from './src/theme';

const Stack = createNativeStackNavigator();
const navigationRef = createNavigationContainerRef();

/** The office ended the run: back to Home, where the message is shown. */
function goHome() {
  if (navigationRef.isReady() && navigationRef.getCurrentRoute()?.name !== 'Shift') {
    navigationRef.reset({ index: 0, routes: [{ name: 'Shift' }] });
  }
}

const navTheme = {
  dark: false,
  colors: {
    primary: C.green, background: C.mist, card: C.white,
    text: C.ink, border: C.line, notification: C.live,
  },
  fonts: {
    regular: { fontFamily: 'System', fontWeight: '400' },
    medium: { fontFamily: 'System', fontWeight: '500' },
    bold: { fontFamily: 'System', fontWeight: '700' },
    heavy: { fontFamily: 'System', fontWeight: '800' },
  },
};

function Root() {
  const { ready, token, checkNow } = useApp();

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: C.white, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={C.live} size="large" />
      </View>
    );
  }

  return (
    // Every screen change asks dispatch what we are carrying (never stuck).
    <NavigationContainer theme={navTheme} ref={navigationRef} onStateChange={() => checkNow()}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: C.mist },
          headerShadowVisible: false,
          headerTitleStyle: { fontWeight: '800', color: C.ink },
          contentStyle: { backgroundColor: C.mist },
        }}>
        {!token ? (
          <Stack.Screen name="SignIn" component={SignInScreen} options={{ headerShown: false }} />
        ) : (
          <>
            <Stack.Screen name="Shift" component={ShiftScreen} options={{ title: 'Your shift' }} />
            <Stack.Screen name="ActiveJob" component={RunScreen}
              options={{ title: 'Delivery', gestureEnabled: false }} />
            <Stack.Screen name="Jobs" component={JobsScreen} options={{ title: 'Your trips' }} />
            <Stack.Screen name="JobDetail" component={JobDetailScreen}
              options={{ title: 'Trip detail' }} />
            <Stack.Screen name="Messages" component={MessagesScreen}
              options={{ title: 'Office' }} />
            <Stack.Screen name="Earnings" component={EarningsScreen} options={{ title: 'Earnings' }} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppProvider onJobEnded={goHome}>
        <StatusBar style="dark" />
        <Root />
      </AppProvider>
    </SafeAreaProvider>
  );
}
