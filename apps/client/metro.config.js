const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');
const rootNodeModules = path.resolve(monorepoRoot, 'node_modules');

const config = getDefaultConfig(projectRoot);

// Preserve Expo defaults and add monorepo paths
const defaultWatchFolders = config.watchFolders || [];
config.watchFolders = [
  ...defaultWatchFolders,
  path.resolve(monorepoRoot, 'packages'),
  rootNodeModules,
];

// Resolve modules from both app and monorepo root node_modules
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  rootNodeModules,
];

// Enable package.json "exports" field resolution
config.resolver.unstable_enablePackageExports = true;

// Stub @rnmapbox/maps on web (requires mapbox-gl which is not installed)
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && (moduleName === '@rnmapbox/maps' || moduleName.startsWith('@rnmapbox/maps/'))) {
    return { type: 'empty' };
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: './global.css' });
