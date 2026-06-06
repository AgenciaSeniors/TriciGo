// Dynamic Expo config. app.json stays the source of truth (passed in as
// `config`); we only resolve android.googleServicesFile from the
// GOOGLE_SERVICES_JSON env var so EAS Build can inject the gitignored
// google-services.json via an EAS file environment variable (the file stays
// OUT of git, matching the CI GH-secret convention). Falls back to the local
// ./google-services.json for local dev / prebuild.
module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? config.android?.googleServicesFile,
  },
});
