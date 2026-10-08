/**
 * Wraps app.json. Two optional environment variables, set by the EAS build
 * profile (eas.json) or on the command line:
 *
 *   API_BASE_URL  the dispatch server this build talks to
 *   APP_VARIANT   "staging": a separate app, "Driver (staging)" with ".staging"
 *                 on its ids, so it installs beside the real one on a phone
 *
 * Without them the build is exactly app.json.
 *   APP_VARIANT=staging API_BASE_URL=https://habibi-staging.quikr.co.za npx expo start
 */
module.exports = ({ config }) => {
  const staging = process.env.APP_VARIANT === 'staging';
  const suffix = staging ? '.staging' : '';
  return {
    ...config,
    name: staging ? `${config.name} (staging)` : config.name,
    scheme: staging ? `${config.scheme}-staging` : config.scheme,
    ios: { ...config.ios, bundleIdentifier: `${config.ios.bundleIdentifier}${suffix}` },
    android: { ...config.android, package: `${config.android.package}${suffix}` },
    extra: { ...config.extra, apiBaseUrl: process.env.API_BASE_URL || config.extra.apiBaseUrl },
  };
};
