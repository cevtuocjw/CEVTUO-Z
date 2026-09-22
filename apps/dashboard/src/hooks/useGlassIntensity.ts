/**
 * Glass intensity — the user-adjustable 0…1 slider.
 *
 * Writes to the `--gi` custom property on the root. Every derived value
 * (blur, saturation, tint alpha, border alpha, highlight) is a `calc()` off it
 * in tokens.scss, so one number re-tunes the whole material.
 *
 * Persisted with Taro storage so the setting survives a relaunch.
 */

import Taro from '@tarojs/taro';
import { useCallback, useEffect, useState } from 'react';

export const GLASS_INTENSITY_KEY = 'cevtuo.gi';
export const DEFAULT_GLASS_INTENSITY = 0.65;

const MIN = 0;
const MAX = 1;

function clamp(v: number): number {
  if (Number.isNaN(v)) return DEFAULT_GLASS_INTENSITY;
  return Math.min(MAX, Math.max(MIN, v));
}

function readStored(): number {
  try {
    const raw = Taro.getStorageSync(GLASS_INTENSITY_KEY);
    if (raw === '' || raw === null || raw === undefined) return DEFAULT_GLASS_INTENSITY;
    return clamp(Number(raw));
  } catch {
    return DEFAULT_GLASS_INTENSITY;
  }
}

function writeRoot(value: number): void {
  try {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.style.setProperty('--gi', String(value));
    }
  } catch {
    /* H5 only; the mini program gets it via page data */
  }
}

export interface GlassIntensity {
  intensity: number;
  setIntensity: (value: number) => void;
  /** 0…100 for rendering a slider without float noise. */
  percent: number;
  setPercent: (value: number) => void;
}

export function useGlassIntensity(): GlassIntensity {
  const [intensity, setState] = useState(DEFAULT_GLASS_INTENSITY);

  // Read storage after mount so the first paint is never blocked by I/O.
  useEffect(() => {
    const stored = readStored();
    setState(stored);
    writeRoot(stored);
  }, []);

  const setIntensity = useCallback((value: number) => {
    const next = clamp(value);
    setState(next);
    writeRoot(next);
    try {
      Taro.setStorageSync(GLASS_INTENSITY_KEY, next);
    } catch {
      /* storage full or unavailable — the setting just won't persist */
    }
  }, []);

  return {
    intensity,
    setIntensity,
    percent: Math.round(intensity * 100),
    setPercent: useCallback((p: number) => setIntensity(p / 100), [setIntensity]),
  };
}
