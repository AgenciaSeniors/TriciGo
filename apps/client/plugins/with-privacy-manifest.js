/**
 * Expo config plugin — inject PrivacyInfo.xcprivacy into the iOS bundle.
 *
 * Apple requires apps to ship a Privacy Manifest declaring data collection,
 * Required Reason API usage, and tracking domains (mandatory since May 2024).
 * SDK 50+ ships a base manifest, but it does not declare app-level data
 * collection — that's our responsibility.
 *
 * What this plugin does:
 *   1. Copies `apps/<app>/PrivacyInfo.xcprivacy` to
 *      `ios/<ProjectName>/PrivacyInfo.xcprivacy` during prebuild.
 *   2. Adds the file as a resource in the Xcode project so it ends up in
 *      the .app bundle root (where Apple looks for it during App Review).
 *
 * Source of truth for the manifest content lives at the workspace root of
 * the app (sibling of app.json). Edit the .xcprivacy file directly when
 * data collection or Required Reason API usage changes.
 */

const { withDangerousMod, withXcodeProject, IOSConfig } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MANIFEST_FILENAME = 'PrivacyInfo.xcprivacy';

function withPrivacyManifestCopy(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const sourcePath = path.join(config.modRequest.projectRoot, MANIFEST_FILENAME);
      if (!fs.existsSync(sourcePath)) {
        throw new Error(
          `[with-privacy-manifest] Source file not found: ${sourcePath}. ` +
            `Create it at the app root before running prebuild.`
        );
      }
      const projectName = config.modRequest.projectName;
      const destDir = path.join(config.modRequest.platformProjectRoot, projectName);
      const destPath = path.join(destDir, MANIFEST_FILENAME);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(sourcePath, destPath);
      return config;
    },
  ]);
}

function withPrivacyManifestPbxResource(config) {
  return withXcodeProject(config, async (config) => {
    const xcodeProject = config.modResults;
    const projectName = config.modRequest.projectName;
    // Path as it appears inside the Xcode project group (e.g. "TriciGo/PrivacyInfo.xcprivacy").
    const filePath = `${projectName}/${MANIFEST_FILENAME}`;

    // Skip if already added (idempotent).
    if (xcodeProject.hasFile(filePath)) {
      return config;
    }

    // Use the Expo-supported helper (the same one `setGoogleServicesFile` uses to add
    // GoogleService-Info.plist to the main group). It resolves the group with
    // pbxGroupByPathOrAssert, which falls back to the project's mainGroup when the group
    // can't be found by path — so it never crashes. The raw node-xcode
    // `addResourceFile` instead does `pbxGroupByName(projectName).path`, which is null on
    // the SDK 55 Xcode template (main group is keyed by path, not name) → TypeError.
    IOSConfig.XcodeUtils.addResourceFileToGroup({
      filepath: filePath,
      groupName: projectName,
      project: xcodeProject,
      isBuildFile: true,
      verbose: true,
    });

    return config;
  });
}

module.exports = function withPrivacyManifest(config) {
  config = withPrivacyManifestCopy(config);
  config = withPrivacyManifestPbxResource(config);
  return config;
};
