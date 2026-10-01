import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.marocto.messenger',
  appName: 'Marocto Messenger',
  webDir: '../web/out',
  android: { allowMixedContent: process.env.ANDROID_BUILD_TYPE !== 'release', webContentsDebuggingEnabled: process.env.ANDROID_BUILD_TYPE !== 'release' },
  server: { androidScheme: 'https' },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] }
  }
};
export default config;
