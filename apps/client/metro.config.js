const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');
const rootNodeModules = path.resolve(monorepoRoot, 'node_modules');

const config = getDefaultConfig(projectRoot);

// Watch all packages in the monorepo
config.watchFolders = [monorepoRoot];

// Resolve modules from both app and monorepo root node_modules
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  rootNodeModules,
];

// Force single React copy — intercept ALL react imports (including subpaths)
// to prevent nested node_modules from resolving to React 19
const singletonPrefixes = ['react', 'react-dom', 'react-native-web'];

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Check if the import matches a singleton package (exact or subpath like react/jsx-runtime)
  for (const prefix of singletonPrefixes) {
    if (moduleName === prefix || moduleName.startsWith(prefix + '/')) {
      // Resolve from the root node_modules only
      const resolvedPath = require.resolve(moduleName, { paths: [rootNodeModules] });
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

// Enable package.json "exports" field resolution
config.resolver.unstable_enablePackageExports = true;

module.exports = withNativeWind(config, { input: './global.css' });
