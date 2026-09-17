"use client";

import type { CSSProperties, ReactNode } from "react";
import styles from "./robot-face.module.css";

export type FaceActivity = "idle" | "listening" | "thinking" | "speaking" | "offline";

export function RobotFace({ activity, audioLevel, paused, title, caption, children }: {
  activity: FaceActivity;
  audioLevel: number;
  paused: boolean;
  title: string;
  caption: string;
  children?: ReactNode;
}) {
  const level = Number.isFinite(audioLevel) ? Math.max(0, Math.min(1, audioLevel)) : 0;
  const speaking = activity === "speaking" && level > 0.015;
  const mouthStyle: CSSProperties = { transform: `scale(${0.86 + level * 0.14}, ${0.24 + level * 0.76})` };
  return (
    <section className={styles.host} aria-label="Showroom robot" data-speaking={speaking}
      data-motion-paused={paused} data-activity={activity}>
      <div className={styles.face} role="img" aria-label={speaking ? "Smiling robot speaking" : "Friendly smiling robot"}>
        <svg className={styles.portrait} viewBox="0 0 600 420" aria-hidden="true">
          <g className={styles.eyes}>
            <path d="M130 185 Q160 115 195 185" fill="none" stroke="currentColor" strokeWidth="23" strokeLinecap="round" />
            <path d="M405 185 Q440 115 470 185" fill="none" stroke="currentColor" strokeWidth="23" strokeLinecap="round" />
          </g>
          <g fill="currentColor" opacity=".45">
            <ellipse cx="105" cy="240" rx="27" ry="12" /><ellipse cx="495" cy="240" rx="27" ry="12" />
          </g>
          <path className={styles.smile} d="M205 258 Q300 370 395 258" fill="none" stroke="currentColor" strokeWidth="22" strokeLinecap="round" />
          <g className={styles.talkingMouth} style={mouthStyle}>
            <ellipse cx="300" cy="296" rx="84" ry="56" fill="currentColor" />
            <path d="M252 317 Q300 287 348 317 Q300 346 252 317" fill="#202a25" />
          </g>
        </svg>
      </div>
      <div className={styles.conversation}>
        <h1>{title}</h1>
        <p className={styles.caption} role="status" aria-live="polite" aria-atomic="true">{caption}</p>
        {children}
      </div>
    </section>
  );
}
