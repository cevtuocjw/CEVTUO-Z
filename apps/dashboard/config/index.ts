import { defineConfig } from '@tarojs/cli';
import path from 'node:path';

/**
 * Taro build config.
 *
 * ⚠️ Compiler is webpack5, not Vite, and deliberately so: Taro does not support
 * a per-platform compiler, and webpack5 is the path with the broadest plugin
 * coverage for `weapp`. Picking Vite for H5 alone would mean two toolchains.
 *
 * ⚠️ `@cevtuo/schema` is aliased to SOURCE rather than to a build output. The
 * app must only ever `import type` from it — zod's runtime is ~60KB and the
 * mini-program package budget is 2MB. `import type` is erased at compile time,
 * so nothing from that package reaches the bundle.
 */
export default defineConfig(async (merge, { command, mode }) => {
  const baseConfig = {
    projectName: 'cevtuo-z',
    date: '2026-9-22',
    designWidth: 750,
    deviceRatio: {
      640: 2.34 / 2,
      750: 1,
      375: 2,
      828: 1.81 / 2,
    },
    sourceRoot: 'src',
    outputRoot: 'dist',
    plugins: [],
    defineConstants: {},
    alias: {
      '@': path.resolve(__dirname, '..', 'src'),
      '@cevtuo/schema': path.resolve(__dirname, '..', '..', '..', 'packages', 'schema', 'src', 'index.ts'),
    },
    copy: {
      patterns: [],
      options: {},
    },
    framework: 'react',
    compiler: {
      type: 'webpack5' as const,
      prebundle: { enable: false },
    },
    cache: { enable: false },
    sass: {
      // Styles use `@use '...' as x`, which requires the modern API.
      api: 'modern-compiler' as const,
      data: '',
    },
    mini: {
      postcss: {
        // ⚠️ px→rpx conversion is OFF, deliberately.
        //
        // rpx scales with screen WIDTH, which makes it unusable for breakpoints:
        // `@media (min-width: 600px)` compiled to `600rpx`, and on the Fold 5's
        // 361dp cover screen 600rpx resolves to ~289 CSS px — so the query matched
        // on the COVER screen and the unfolded layout was never reachable.
        //
        // Layout here is governed by device-independent CSS px (see
        // styles/tokens.scss), and device px is what a WebView media query
        // evaluates. Enabling this transform silently breaks the foldable tiers,
        // which is exactly the bug it took a build-output inspection to catch.
        pxtransform: { enable: false, config: {} },
        cssModules: { enable: false },
      },
      // The app must NOT enable Skyline: Skyline supports only DarkMode media
      // queries, so width media queries — which the entire foldable layout
      // depends on — would silently stop matching.
      // (Skyline is opted into per-page via `renderer: 'skyline'`; we never set it.)
    },
    h5: {
      publicPath: '/',
      staticDirectory: 'static',
      output: {
        filename: 'js/[name].[hash:8].js',
        chunkFilename: 'js/[name].[chunkhash:8].js',
      },
      miniCssExtractPluginOption: {
        ignoreOrder: true,
        filename: 'css/[name].[hash].css',
        chunkFilename: 'css/[name].[chunkhash].css',
      },
      postcss: {
        autoprefixer: { enable: true, config: {} },
        // Same reasoning as the mini target: this converted breakpoints to
        // `15rem`, which is derived from a JS-set root font size and therefore
        // does not correspond to the device width the layout is designed around.
        pxtransform: { enable: false, config: {} },
        cssModules: { enable: false },
      },
    },
  };

  if (process.env.NODE_ENV === 'development') {
    return merge({}, baseConfig, {
      mini: {},
      h5: {},
    });
  }
  return merge({}, baseConfig, {
    mini: {},
    h5: {},
  });
});
