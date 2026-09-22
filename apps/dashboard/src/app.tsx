import { useLaunch, useDidShow } from '@tarojs/taro';
import type { PropsWithChildren } from 'react';

import { applyRootClasses } from './components/glass/tier';

import './app.scss';

/**
 * App shell.
 *
 * Two jobs, both one-time:
 *   1. Detect the glass capability tier and stamp `tier-a|b|c` + `theme-*` onto
 *      the root, so the SCSS degradation ladder in glass.scss can match.
 *   2. Nothing else. Data fetching is per-page and per-block so the cover screen
 *      never pays for payloads it will not render.
 */
export default function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    applyRootClasses();
  });

  useDidShow(() => {
    // The system theme can change while the app is backgrounded; re-stamping on
    // show is cheaper than subscribing to onThemeChange for a value we only use
    // for a root class.
    applyRootClasses();
  });

  return <>{children}</>;
}
