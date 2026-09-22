// Taro's React preset. Kept minimal — the framework preset already handles JSX,
// TypeScript and the `@cevtuo/schema` type-only imports (which are erased, so
// zod's runtime never reaches either bundle).
module.exports = {
  presets: [
    [
      'taro',
      {
        framework: 'react',
        ts: true,
        compiler: 'webpack5',
        useBuiltIns: process.env.TARO_ENV === 'h5' ? 'usage' : false,
      },
    ],
  ],
};
