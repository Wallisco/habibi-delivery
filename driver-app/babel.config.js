module.exports = function (api) {
  // Tests only: yoga-layout (the layout test's flexbox engine) uses import.meta.
  // App builds get exactly the preset they had before.
  const test = api.env('test');
  return { presets: [['babel-preset-expo', test ? { unstable_transformImportMeta: true } : {}]] };
};
