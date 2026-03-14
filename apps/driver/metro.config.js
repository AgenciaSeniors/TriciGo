const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');
const appNodeModules = path.resolve(projectRoot, 'node_modules');
const rootNodeModules = path.resolve(monorepoRoot, 'node_modules');

const config = getDefaultConfig(projectRoot);

// Watch shared packages and root node_modules — NOT the entire monorepo
// to avoid cross-contamination with other apps' route files
config.watchFolders = [
  path.resolve(monorepoRoot, 'packages'),
  rootNodeModules,
];
config.resolver.nodeModulesPaths = [
  appNodeModules,
  rootNodeModules,
];
config.resolver.unstable_enablePackageExports = true;

// Force single React copy — resolve from app node_modules first (React 18),
// then fall back to root. This prevents the hoisted React 19 react-dom
// (from Next.js) from being picked up by the Expo app.
const singletonPrefixes = ['react', 'react-dom', 'react-native-web'];

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  for (const prefix of singletonPrefixes) {
    if (moduleName === prefix || moduleName.startsWith(prefix + '/')) {
      const resolvedPath = require.resolve(moduleName, {
        paths: [appNodeModules, rootNodeModules],
      });
      return {
        filePath: resolvedPath,
        type: 'sourceFile',
      };
    }
  }

  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: './global.css' });
