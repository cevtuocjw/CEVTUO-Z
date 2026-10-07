import { useLaunch, useDidShow } from '@tarojs/taro';
import type { PropsWithChildren } from 'react';

import { applyRootClasses } from './components/glass/tier';
import { initRefraction } from './components/glass/refract';

import './app.scss';

/**
 * App shell.
 *
 * Three jobs, all one-time:
 *   1. Detect the glass capability tier and stamp `tier-a|b|c` + `theme-*` onto
 *      the root, so the SCSS degradation ladder in glass.scss can match.
 *   2. Add the refraction tier on top of tier A, where Chromium can render it.
 *      This is a no-op everywhere else — see the header of glass/refract.ts for
 *      why the fallback deliberately does nothing rather than something weaker.
 *   3. Nothing else. Data fetching is per-page and per-block so the cover screen
 *      never pays for payloads it will not render.
 */
export default function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    applyRootClasses();
    // After applyRootClasses: the rig reads each surface's computed radius, and
    // the tier class affects the material those surfaces are drawn with.
    initRefraction();
  });

  useDidShow(() => {
    // The system theme can change while the app is backgrounded; re-stamping on
    // show is cheaper than subscribing to onThemeChange for a value we only use
    // for a root class.
    applyRootClasses();
    // Cheap when the surfaces are already refracted (the sweep skips anything
    // carrying data-lg); this is what catches a surface that first mounted while
    // it was still 0×0, e.g. a sheet opened before its content laid out.
    initRefraction();
  });

  return <>{children}</>;
}
