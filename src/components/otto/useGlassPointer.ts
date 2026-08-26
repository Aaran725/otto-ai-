"use client";

import { useRef } from "react";

/** Pointer-reactive Liquid Glass — moves the highlight in .otto-glass via
 * CSS custom properties instead of a static gradient position. Shared
 * across every card surface (compact cards, comparison columns, the
 * expanded sheet) so the spotlight is the app's signature, not a
 * one-off on the landing hero mockup. */
export function useGlassPointer<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  return {
    ref,
    onMouseMove: (e: React.MouseEvent<T>) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${((e.clientX - rect.left) / rect.width) * 100}%`);
      el.style.setProperty("--my", `${((e.clientY - rect.top) / rect.height) * 100}%`);
    },
  };
}
