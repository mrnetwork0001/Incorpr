import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { clamp, expo } from "./motion";

/** A figure that counts up to its real value between frames `at` and `at + dur`. */
export const Count: React.FC<{ to: number; at: number; dur?: number; decimals?: number; prefix?: string; suffix?: string; style?: React.CSSProperties }> = ({ to, at, dur = 36, decimals = 0, prefix = "", suffix = "", style }) => {
  const f = useCurrentFrame();
  const v = interpolate(f, [at, at + dur], [0, to], { ...clamp, easing: expo });
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return <span style={{ fontVariantNumeric: "tabular-nums", ...style }}>{prefix}{v < 0 ? "−" : ""}{s}{suffix}</span>;
};
