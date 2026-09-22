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
    backgroundTextStyle: 'dark',
    navigationBarBackgroundColor: '#0a0b0f',
    navigationBarTitleText: 'CEVTUO-Z',
    navigationBarTextStyle: 'white',
    // The app draws its own glass nav bar, so the native one is hidden.
    navigationStyle: 'custom',
    backgroundColor: '#0a0b0f',
  },
  darkmode: true,
  themeLocation: 'theme.json',
  // The foldable layout depends on width media queries, which need the WebView
  // renderer. See the note above.
  lazyCodeLoading: 'requiredComponents',
});
