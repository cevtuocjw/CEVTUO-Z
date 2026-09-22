export default definePageConfig({
  navigationBarTitleText: 'CNSR',
  // Deliberately NOT using the skyline renderer: it supports only DarkMode
  // media queries, so the width queries the foldable layout depends on would
  // silently stop matching.
});
