"use client";

import { forwardRef } from "react";
import type { Analysis, Shot } from "@/lib/types";

/**
 * The export: a moodboard rather than a report.
 *
 * Screenshots are scattered across a dotted canvas at varied sizes and slight
 * angles, the way you would pin them to a board, with the red threads drawn
 * between the ones that share a theme. The left column carries the reading —
 * the summary, the palette and the full list of themes — so the picture still
 * says what the analysis found.
 *
 * Laid out at a fixed size so the exported PNG is predictable, and the preview
 * shows this very element, so what you see is what downloads.
 */

const WIDTH = 1040;
const COL_W = 330; // Left column, kept clear of the scatter.
const TILE_X = 368;
const TILE_TOP = 112;
const COLS = 3;
const COL_STEP = 212;
const ROW_STEP = 186;
const MAX_TILES = 15;
const MAX_PILLS = 3;
const KEY_THEMES = 3;

/** Stable pseudo-random in 0..1 — the same batch always scatters the same way. */
function wobble(index: number, salt: number) {
  const n = Math.sin((index + 1) * 127.1 + salt * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

type Placed = {
  shot: Shot;
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
};

function layout(shots: Shot[]): Placed[] {
  return shots.map((shot, i) => {
    // Three repeating sizes keep it from reading as a grid.
    const variant = i % 4;
    const w = variant === 0 ? 206 : variant === 2 ? 162 : 184;
    const h = Math.round(w * 0.74);

    return {
      shot,
      x: TILE_X + (i % COLS) * COL_STEP + (wobble(i, 1) - 0.5) * 26,
      y: TILE_TOP + Math.floor(i / COLS) * ROW_STEP + (wobble(i, 2) - 0.5) * 24,
      w,
      h,
      angle: (wobble(i, 3) - 0.5) * 7,
    };
  });
}

/** Keeps a sticky note the size of a note, whatever the model wrote. */
function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : max).trimEnd()}…`;
}

function sourceLabel(source: Analysis["source"]) {
  if (source === "claude") return "read by Claude";
  if (source === "ollama") return "read on this machine";
  return "keyword pass";
}

export const MoodboardPoster = forwardRef<
  HTMLDivElement,
  { shots: Shot[]; analysis: Analysis }
>(function MoodboardPoster({ shots, analysis }, ref) {
  const done = shots.filter((s) => s.status === "done");
  const shown = done.slice(0, MAX_TILES);
  const placed = layout(shown);
  const byId = new Map(placed.map((p) => [p.shot.id, p]));

  const rows = Math.max(1, Math.ceil(shown.length / COLS));
  const height = Math.max(880, TILE_TOP + rows * ROW_STEP + 70);

  const centre = (p: Placed) => ({ x: p.x + p.w / 2, y: p.y + p.h / 2 });

  // Only threads between screenshots that both made it onto the board.
  const threads = analysis.links
    .map((l) => ({ a: byId.get(l.source), b: byId.get(l.target), weight: l.weight }))
    .filter((t): t is { a: Placed; b: Placed; weight: number } => !!t.a && !!t.b);

  // A pill sits over the cluster it names, like a label pinned to the board.
  const pills = analysis.themes
    .slice(0, MAX_PILLS)
    .map((theme) => {
      const members = theme.shotIds.map((id) => byId.get(id)).filter((p): p is Placed => !!p);
      if (!members.length) return null;
      const cx = members.reduce((a, p) => a + centre(p).x, 0) / members.length;
      const top = Math.min(...members.map((p) => p.y));
      return { theme, x: cx, y: top - 16 };
    })
    .filter((p): p is { theme: Analysis["themes"][number]; x: number; y: number } => !!p);

  const stickies = analysis.themes.filter((t) => t.rationale).slice(0, 2);

  const date = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div className="board" ref={ref} style={{ width: WIDTH, height }}>
      {/* Threads sit under the tiles, so they read as running behind them. */}
      <svg className="board-threads" viewBox={`0 0 ${WIDTH} ${height}`} width={WIDTH} height={height}>
        {threads.map((t, i) => {
          const a = centre(t.a);
          const b = centre(t.b);
          const span = Math.hypot(b.x - a.x, b.y - a.y);
          const sag = Math.min(44, span * 0.16);
          return (
            <path
              key={i}
              d={`M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${(a.y + b.y) / 2 + sag} ${b.x} ${b.y}`}
              fill="none"
              stroke="#c81e3c"
              strokeLinecap="round"
              strokeWidth={2 + t.weight * 3}
              opacity={0.62 + t.weight * 0.38}
            />
          );
        })}
      </svg>

      <div className="board-col" style={{ width: COL_W }}>
        <h1>Screenshot Threads</h1>
        <p className="board-meta">
          {done.length} screenshots · {analysis.themes.length} themes ·{" "}
          {analysis.links.length} connections
        </p>

        {analysis.summary && <p className="board-summary">{analysis.summary}</p>}

        {analysis.themes.length > 0 && (
          <>
            {/* The few that carry the batch, set large enough to be the first
                thing read after the title. */}
            <ol className="board-key">
              {analysis.themes.slice(0, KEY_THEMES).map((theme) => (
                <li key={theme.id}>
                  <i style={{ background: theme.color }} />
                  <span>{theme.label}</span>
                  <b>{theme.shotIds.length}</b>
                </li>
              ))}
            </ol>

            {analysis.themes.length > KEY_THEMES && (
              <p className="board-rest">
                also{" "}
                {analysis.themes
                  .slice(KEY_THEMES)
                  .map((t) => t.label)
                  .join(" · ")}
              </p>
            )}
          </>
        )}

        {stickies.map((theme, i) => (
          <div
            key={theme.id}
            className="board-sticky"
            style={{
              background: i === 0 ? "#ffd9dd" : "#c9f2ea",
              transform: `rotate(${i === 0 ? -1.8 : 1.6}deg)`,
            }}
          >
            <strong>{theme.label}</strong>
            {truncate(theme.rationale ?? "", 165)}
          </div>
        ))}

        <p className="board-date">{date} · {sourceLabel(analysis.source)}</p>
      </div>

      {placed.map((p) => (
        <div
          key={p.shot.id}
          className="board-tile"
          style={{
            left: p.x,
            top: p.y,
            width: p.w,
            height: p.h,
            transform: `rotate(${p.angle}deg)`,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.shot.thumb} alt={p.shot.name} />
        </div>
      ))}

      {pills.map(({ theme, x, y }) => (
        <div key={theme.id} className="board-pill" style={{ left: x, top: y }}>
          <span style={{ background: theme.color }}>{theme.label}</span>
        </div>
      ))}

      {done.length > shown.length && (
        <div className="board-more">+{done.length - shown.length} more screenshots</div>
      )}
    </div>
  );
});
