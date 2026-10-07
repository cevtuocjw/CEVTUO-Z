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
    /*
     * ⚠️⚠️ **小程序和 h5 必须分开输出（2026-10-07）。**
     *
     * 原来两者都写 `dist` ⇒ **每次重建 h5 都会把小程序产物冲掉**，
     * 而 DevTools 那边报的是：
     *     `dist/app.json: … 在该目录下未找到 app.json` ⇒ simulator launch failed
     * —— 看起来像「小程序又坏了」，其实是被 h5 顶掉了。
     * 本次会话为了部署重建了好几次 h5，于是这个错**反复出现**，
     * 而每次的表现都是"白屏/打不开"，和真正的 wxss 故障长得一样。
     *
     * ⚠️ 修法不是"记得先构建哪个"——那要靠人记，一定会忘 ——
     *    而是让**两者根本不共用目录**。
     * ⚠️ 改名要同步三处：这里、`project.config.json` 的 `miniprogramRoot`、
     *    以及 `package.json` 里 `build:weapp` 传给 strip 脚本的路径。
     * ⚠️ `process.env.TARO_ENV` 在**配置文件**（Node 侧）是可读的；
     *    只能读 `process` 的是**打进包的运行时代码**，两件事别混。
     */
    outputRoot: process.env.TARO_ENV === 'weapp' ? 'dist-weapp' : 'dist',
    plugins: [],
    defineConstants: {},
    alias: {
      '@': path.resolve(__dirname, '..', 'src'),
      '@cevtuo/schema': path.resolve(__dirname, '..', '..', '..', 'packages', 'schema', 'src', 'index.ts'),
    },
    // ⚠️ The wallpaper is NOT copied via `copy.patterns`. Taro 4's webpack5
    // runner accepts the option but does not wire it up for H5 — a
    // `patterns: [{ from: 'static/', to: 'static/' }]` here copied nothing and
    // failed silently, leaving the template pointing at a file that was never
    // emitted.
    //
    // It is copied by the `build:h5` script instead (see package.json). That is
    // more explicit and does not depend on undocumented plugin behaviour.
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
      /**
       * ⚠️⚠️ **`ignoreOrder` 在 mini 这边一直缺着**（h5 有、mini 没有）。
       *
       * 缺它的症状不是"少了一行配置"，是**构建报一串 `Conflicting order` 错误**：
       *
       *     Error: chunk common [mini-css-extract-plugin]
       *     Conflicting order. Following module has been added:
       *      * …/PaperrCharts.scss
       *     despite it was not able to fulfill desired ordering with these modules:
       *      * …/GalleryFrame.scss
       *
       * ⚠️ 而它**不是致命的** —— 实测产物是好的（`app.json` / `app.js` /
       *    五个页面全都在，1.4M）。但**任何按退出码判成功的地方都会把它当成失败**
       *    （CI、脚本、人眼扫日志），于是"能出包"和"报错了"同时成立。
       *
       * ⚠️⚠️ 而且这个坑在这个项目里有前科：**同特异型的规则谁赢取决于顺序**
       *    （已经栽过六次，见 `.bgif--gone` 和 `.section__head` 那两处）。
       *    ⇒ `ignoreOrder` **不是"把错误藏起来"**：它承认"这两条顺序无所谓"。
       *      只有当**确实无所谓**时才该长这样；如果哪天两条规则真的打架，
       *      要改的是**选择器特异性**，不是再调这个开关。
       */
      miniCssExtractPluginOption: {
        ignoreOrder: true,
        filename: 'css/[name].wxss',
        chunkFilename: 'css/[name].wxss',
      },
      // The app must NOT enable Skyline: Skyline supports only DarkMode media
      // queries, so width media queries — which the entire foldable layout
      // depends on — would silently stop matching.
      // (Skyline is opted into per-page via `renderer: 'skyline'`; we never set it.)
    },
    h5: {
      // ⚠️ Relative, NOT '/'. With '/', every emitted asset URL is absolute
      // (`/js/app.js`, `/static/images/assets/wallpaper.jpg`) and the app 404s
      // into a blank screen anywhere except a true domain root. That silently
      // ruled out serving it from a subdirectory, which is how it is tested
      // locally and how it will sit behind nginx next to other projects.
      //
      // This is safe because the H5 router is hash-based: routes live in the
      // fragment (`#/pages/coof/index`), so `location.pathname` stays at the
      // mount point and a relative base never resolves somewhere else mid-route.
      // ⚠️ If a non-hash router mode is ever adopted, switch this to a computed
      // absolute base instead — relative paths break on nested history routes.
      /**
       * ⚠️⚠️ **必须是绝对根 `/`，不能再是 `'./'`** —— 这就是上面那段注释
       *    「若改用非 hash 模式，要换成算出来的绝对基准」说的情况，现在真发生了。
       *
       * 为什么非改不可：browser 模式下 **Taro 自己生成的 URL 是页面原名**
       * （`/pages/coof/index`，多段）。而相对基准取的是"当前地址的目录" ——
       * 在 `/pages/coof/index` 上 `./js/app.js` 会请求 `/pages/coof/js/app.js`，
       * **404**，表现是**那一页整屏空白**。实测：站内从 COOF 返回主页时，
       * 主页的惰性 chunk 就是这么 404 掉的。
       *
       * ⚠️ 代价：**子路径部署不再成立**。三处生产入口全是根挂载
       *    （`z.cevtuo.com` / `z.cevtuogrnd.com` / 国内镜像的 `ROOT`），所以没事；
       *    但本地预览不能在 `/z/` 下了 —— 改成**根挂载**跑
       *    （`ROOT=/tmp/sv/z` 起一个服务器，和生产的形状一模一样）。
       */
      publicPath: '/',
      staticDirectory: 'static',
      /**
       * ── 路由改成 **browser**，URL 变干净（读者 2026-10-07）─────────────
       *
       * 「把网站链接改好……例如这个只成为 z.cevtuo.com/chealth，主页就只是
       *   z.cevtuo.com」。
       *
       * `renamePagename` 把 `pages/coof/index` 折成 `coof` ⇒ URL 就是 `/coof`；
       * 主页折成**空串** ⇒ `/`，正好是读者要的「主页就只是 z.cevtuo.com」。
       *
       * ⚠️ 上面 `publicPath: './'` 之所以还能留，是靠**所有路由都是单段**这一条：
       *    `/coof` 的基准目录就是 `/`，`./js/app.js` 解析成 `/js/app.js` ✓；
       *    本地预览挂在子路径（`/z/coof` → `/z/js/…`）也照样成立 ✓。
       *    ⚠️ 唯一的例外是**带尾斜杠**的 `/coof/`（基准变成 `/coof/`）——
       *    那一条由 `index.html` 里那段内联脚本 `replaceState` 掉，见那里。
       *
       * ⚠️⚠️ browser 模式**必须**有服务端/静态托管的 SPA 回落，否则 `/coof`
       *    直连会真的 404。三处都已经落实：
       *      · 国内镜像 `mirror-server.mjs` —— 本来就有（无扩展名回落 index.html）
       *      · GitHub Pages —— 靠 `deploy-pages.sh` 发布的 `404.html`
       *      · 本地预览 —— 和镜像同一个服务器
       */
      router: {
        /*
         * ⚠️⚠️ **改这一块之前先读 `docs/routing.md`。**
         *
         * 这套方案踩过七个坑，**每一个都满足「地址栏对、零 404、构建全绿、
         * 控制台零报错」，而页面是空的或者点了不动**。那一页记的是每个坑的
         * 实测证据和判据，改路由之前过一遍能省一整轮。
         *
         * 常驻检查：`bun scripts/verify-routes.mjs [base]`（29 条，可打线上）。
         */
        mode: 'browser',
        /**
         * ⚠️⚠️ **`renamePagename` 不干这件事 —— 实测过了，别再用它。**
         *
         * 先写的是 `renamePagename: (p) => p.replace(/^pages\//, '')…`。
         * 构建后量出来：`/coof` 地址栏保持不动、**零 404**、而 `#app` 是**空的**、
         * 控制台**零报错**；主页那条被写成**页面原名** `/pages/home/index`。
         *
         * ⇒ 它根本不动路由表 ⇒ 表里没有 `/coof` ⇒ 匹配不上就什么都不渲染，
         *    而且**静默**（Taro 把"没有匹配的路由"当成"这一页没内容"）。
         *    ⇒ 这种事只能靠"**页面真的渲染出来了吗**"来判，不能靠构建成功。
         *
         * ⇒ 换成 `customRoutes` —— 它才是"给页面挂一个自定义路径"的那个开关。
         *
         * ⚠️ 它的**键方向**在类型定义里确认不了（`IOption` 就是
         *    `Record<string, any>`，两种写法都过类型检查）。所以**两个方向都写**，
         *    错的那个不会匹配、也就没有副作用。
         *    ⚠️⚠️ **构建后量出哪个生效，就把不生效的那一半删掉** ——
         *       留着一半"猜的"配置，等于给下一个人埋一个"改了没反应"的谜。
         */
        customRoutes: {
          /*
           * ⚠️ 主页写 `'/home'`，**不是 `'/'`**。实测：五个键里只有 `'/'` 那一条
           *    不生效 —— Taro 在 `/` 上走的是"没有匹配的路由就回落到入口页"那条路，
           *    而**回落时用的是页面原名**（`/pages/home/index`）⇒ 那个地址的基准目录
           *    成了 `/pages/home/`，主页自己的惰性 chunk 变成
           *    `/pages/home/js/423.xxx.js` ⇒ **404** ⇒ 主页整屏空白（其余四页都好好的）。
           *
           *    ⇒ 让它有一条**真路由** `/home`，再由 `index.html` 把它归一成 `/`
           *      显示给读者（读者要的是「主页就只是 z.cevtuo.com」）。见那边。
           */
          '/home': 'pages/home/index',
          '/coof': 'pages/coof/index',
          '/cnsr': 'pages/cnsr/index',
          '/paperr': 'pages/paperr/index',
          '/chealth': 'pages/chealth/index',
          /*
           * ⚠️⚠️ **反方向那一半是真管用的 —— 删过一次，四页当场全白。**
           *
           * 我一度以为它不生效（证据：站内从内页返回主页时地址栏写的是页面原名
           * `/pages/home/index`），就把它删了。构建后实测：主页照旧 1288 字，
           * 而 `/coof` `/cnsr` `/paperr` `/chealth` `/home` **全部 0 字**，
           * 并且**零 404** —— 也就是资源都加载了、就是**匹配不上路由、什么都不渲染**。
           *
           * ⇒ 结论来自数据不是来自推理：**两条都要**。
           *   正向（路径 → 页面）管"进来的 URL 认不认得"，
           *   反向（页面 → 路径）管"**Taro 自己生成/解析页面时**认不认得" ——
           *   后者少了，`/coof` 这条 URL 依然收得到请求，但解析不出页面。
           *
           * ⚠️ 而"反方向没生效"那个观察本身是**对的**、只是**不完整**：
           *    站内回主页确实写的是 `/pages/home/index`，那是另一件事
           *    （Taro 生成 URL 时用的是页面原名），由 `index.html` 里那段
           *    归一处理掉（它认 `/home` 和 `/pages/home/index` 两种写法）。
           */
          'pages/home/index': '/home',
          'pages/coof/index': '/coof',
          'pages/cnsr/index': '/cnsr',
          'pages/paperr/index': '/paperr',
          'pages/chealth/index': '/chealth',
        },
      },
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
