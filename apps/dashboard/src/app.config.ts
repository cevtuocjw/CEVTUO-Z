/**
 * Mini-program global config.
 *
 * ⚠️ `darkmode: true` + `themeLocation` is what makes WXSS variables follow the
 * system theme inside the WeChat renderer. On H5 the equivalent is the
 * `prefers-color-scheme` block emitted by app.scss.
 *
 * ⚠️ `renderer` is deliberately NOT set to 'skyline'. Skyline supports only
 * DarkMode media queries, so every `min-width` query in breakpoints.scss would
 * silently stop matching and the foldable layout would collapse to one column
 * on the unfolded inner screen.
 */
export default defineAppConfig({
  pages: [
    'pages/home/index',
    'pages/coof/index',
    'pages/cnsr/index',
    'pages/paperr/index',
    'pages/chealth/index',
  ],
  window: {
    /*
     * ⚠️⚠️ **这四个值用 `@` 引用 `theme.json`，不是写死的颜色。**
     *
     * 原来它们是 `'#0a0b0f'` / `'white'` / `'dark'` 这样的字面量 ——
     * 而 `themeLocation: 'theme.json'` 却指着**一个并不存在的文件**。
     *
     * 后果不是"少了个文件"，是**编译直接失败**，而且报错在构建流程之外：
     *
     *     ✖ compile_start
     *     Error: app.json: 未找到 dist/theme.json 文件，或者文件读取失败
     *
     * ⚠️ 它拖到 `cli preview` 那一步才炸 —— **Taro 构建是成功的**（0 报错、
     *    产物齐全），因为 `themeLocation` 在 Taro 眼里只是一行配置。
     *    这个坑和这个项目其他坑同形：**"构建通过"什么都没说明。**
     *
     * ⇒ 补上 `src/theme.json`，并且让这四个值**真的去引用它** ——
     *    否则那个文件只是为了让编译器闭嘴的摆设，而"能编译"和"用上了"是两回事。
     */
    backgroundTextStyle: '@bgTxtStyle',
    navigationBarBackgroundColor: '@navBgColor',
    navigationBarTitleText: 'CEVTUO-Z',
    navigationBarTextStyle: '@navTxtStyle',
    // The app draws its own glass nav bar, so the native one is hidden.
    navigationStyle: 'custom',
    backgroundColor: '@bgColor',
  },
  darkmode: true,
  themeLocation: 'theme.json',
  // The foldable layout depends on width media queries, which need the WebView
  // renderer. See the note above.
  lazyCodeLoading: 'requiredComponents',
});
