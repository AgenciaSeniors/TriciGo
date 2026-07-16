// Local Expo module (Android): floating bubble over other apps + relaunch of
// MainActivity from the background when a ride offer arrives, both gated on
// the user-granted SYSTEM_ALERT_WINDOW permission. iOS/web are no-op stubs.
export { default, isDriverOverlayAvailable } from './src/DriverOverlayModule';
