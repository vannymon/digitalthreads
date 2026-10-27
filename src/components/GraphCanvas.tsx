"use client";

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from "d3-force";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Analysis, Shot } from "@/lib/types";

type SimNode = SimulationNodeDatum & {
  id: string;
  shot: Shot;
  color: string;
  r: number;
};

type SimLink = {
  source: string | SimNode;
  target: string | SimNode;
  weight: number;
};

const WIDTH = 1000;
const HEIGHT = 700;

export function GraphCanvas({
  shots,
  analysis,
  selectedId,
  onSelect,
  highlightThemeId,
  onExport,
}: {
  shots: Shot[];
  analysis: Analysis;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  highlightThemeId: string | null;
  onExport: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<SimNode, undefined> | null>(null);
  const [, forceRender] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ node: SimNode | null; pointerId: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  // A node's colour is its strongest theme; themes are already sorted.
  const nodes = useMemo<SimNode[]>(() => {
    const linked = new Set(analysis.links.flatMap((l) => [l.source, l.target]));
    return shots
      .filter((s) => s.status === "done")
      .map((shot) => {
        const theme = analysis.themes.find((t) => t.shotIds.includes(shot.id));
        const degree = analysis.links.filter(
          (l) => l.source === shot.id || l.target === shot.id,
        ).length;
        return {
          id: shot.id,
          shot,
          color: theme?.color ?? "#64748b",
          // Well-connected screenshots read as bigger — the eye finds the hubs.
          r: 22 + Math.min(14, degree * 3) + (linked.has(shot.id) ? 0 : -6),
        };
      });
  }, [shots, analysis]);

  const links = useMemo<SimLink[]>(
    () =>
      analysis.links.map((l) => ({
        source: l.source,
        target: l.target,
        weight: l.weight,
      })),
    [analysis.links],
  );

  useEffect(() => {
    if (!nodes.length) return;

    const sim = forceSimulation<SimNode>(nodes)
      .force("charge", forceManyBody<SimNode>().strength(-520))
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((l) => 220 - 110 * l.weight)
          .strength((l) => 0.15 + 0.6 * l.weight),
      )
      .force("center", forceCenter(WIDTH / 2, HEIGHT / 2))
      // Without this, a screenshot that shares no themes has nothing holding
      // it in and drifts until it hits the clamp at the edge.
      .force("x", forceX<SimNode>(WIDTH / 2).strength(0.06))
      .force("y", forceY<SimNode>(HEIGHT / 2).strength(0.06))
      .force("collide", forceCollide<SimNode>((d) => d.r + 10));

    simRef.current = sim;

    // One render per animation frame rather than one per tick — the
    // simulation ticks far faster than the screen refreshes.
    let queued = false;
    sim.on("tick", () => {
      // Charge pushes loosely-connected nodes past the edge of the canvas,
      // where they're invisible and unclickable. Keep everyone in frame.
      for (const node of nodes) {
        node.x = Math.max(node.r + 6, Math.min(WIDTH - node.r - 6, node.x ?? WIDTH / 2));
        node.y = Math.max(node.r + 6, Math.min(HEIGHT - node.r - 6, node.y ?? HEIGHT / 2));
      }
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        forceRender((v) => v + 1);
      });
    });

    return () => {
      sim.stop();
      simRef.current = null;
    };
  }, [nodes, links]);

  const toGraph = useCallback(
    (clientX: number, clientY: number) => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      const scale = rect.width / WIDTH;
      return {
        x: ((clientX - rect.left) / scale - view.x) / view.k,
        y: ((clientY - rect.top) / scale - view.y) / view.k,
      };
    },
    [view],
  );

  const onNodePointerDown = (event: React.PointerEvent, node: SimNode) => {
    event.stopPropagation();
    (event.target as Element).setPointerCapture(event.pointerId);
    dragRef.current = { node, pointerId: event.pointerId };
    simRef.current?.alphaTarget(0.3).restart();
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag?.node) {
      const { x, y } = toGraph(event.clientX, event.clientY);
      drag.node.fx = x;
      drag.node.fy = y;
      return;
    }
    const pan = panRef.current;
    if (pan) {
      const rect = stageRef.current?.getBoundingClientRect();
      const scale = rect ? rect.width / WIDTH : 1;
      setView((v) => ({
        ...v,
        x: pan.vx + (event.clientX - pan.x) / scale,
        y: pan.vy + (event.clientY - pan.y) / scale,
      }));
    }
  };

  const endPointer = () => {
    const drag = dragRef.current;
    if (drag?.node) {
      drag.node.fx = null;
      drag.node.fy = null;
      simRef.current?.alphaTarget(0);
    }
    dragRef.current = null;
    panRef.current = null;
  };

  const onWheel = (event: React.WheelEvent) => {
    const next = Math.min(3, Math.max(0.35, view.k * (event.deltaY < 0 ? 1.12 : 0.89)));
    setView((v) => ({ ...v, k: next }));
  };

  const dimmed = (id: string) =>
    highlightThemeId
      ? !analysis.themes.find((t) => t.id === highlightThemeId)?.shotIds.includes(id)
      : false;

  if (!nodes.length) {
    return (
      <div className="graph-empty">
        <p>No connections yet — drop in a batch of screenshots to see the threads.</p>
      </div>
    );
  }

  return (
    <div className="graph-wrap">
      <div className="graph-toolbar">
        <button type="button" onClick={() => setView({ x: 0, y: 0, k: 1 })}>
          Reset view
        </button>
        <button type="button" onClick={onExport}>
          Export image
        </button>
      </div>

      <div ref={stageRef} className="graph-stage">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerLeave={endPointer}
          onWheel={onWheel}
          onPointerDown={(e) => {
            panRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
            onSelect(null);
          }}
        >
          <defs>
            {nodes.map((n) => (
              <clipPath key={n.id} id={`clip-${n.id}`}>
                <circle r={n.r} />
              </clipPath>
            ))}
            {/* The same two-light trick the CSS uses, so a node reads as
                pressed out of the page rather than pasted onto it. */}
            <filter id="puck" x="-60%" y="-60%" width="220%" height="220%">
              <feDropShadow dx="3" dy="3" stdDeviation="3.5" floodColor="#c2c6ce" floodOpacity="0.95" />
              <feDropShadow dx="-3" dy="-3" stdDeviation="3.5" floodColor="#ffffff" floodOpacity="0.95" />
            </filter>
          </defs>

          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {links.map((l, i) => {
              const s = l.source as SimNode;
              const t = l.target as SimNode;
              if (typeof s === "string" || typeof t === "string") return null;
              const faded = dimmed(s.id) && dimmed(t.id);

              // A thread hangs rather than running straight: the control point
              // sits below the midpoint, in proportion to the span.
              const x1 = s.x ?? 0;
              const y1 = s.y ?? 0;
              const x2 = t.x ?? 0;
              const y2 = t.y ?? 0;
              const span = Math.hypot(x2 - x1, y2 - y1);
              const sag = Math.min(46, span * 0.16);

              return (
                <path
                  key={i}
                  d={`M ${x1} ${y1} Q ${(x1 + x2) / 2} ${(y1 + y2) / 2 + sag} ${x2} ${y2}`}
                  className="graph-link"
                  // The canvas is drawn at 1000px wide and displayed far
                  // smaller, so a hairline here disappears entirely.
                  strokeWidth={2 + l.weight * 3}
                  opacity={faded ? 0.08 : 0.6 + l.weight * 0.4}
                />
              );
            })}

            {nodes.map((n) => (
              <g
                key={n.id}
                transform={`translate(${n.x ?? 0} ${n.y ?? 0})`}
                className="graph-node"
                opacity={dimmed(n.id) ? 0.2 : 1}
                onPointerDown={(e) => onNodePointerDown(e, n)}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(n.id);
                }}
              >
                {/* Backing disc carries the shadow; the image sits on top. */}
                <circle r={n.r} fill="#eceef2" filter="url(#puck)" />
                <image
                  href={n.shot.thumb}
                  x={-n.r}
                  y={-n.r}
                  width={n.r * 2}
                  height={n.r * 2}
                  preserveAspectRatio="xMidYMid slice"
                  clipPath={`url(#clip-${n.id})`}
                />
                <circle
                  r={n.r}
                  fill="none"
                  stroke={selectedId === n.id ? "#c81e3c" : n.color}
                  strokeWidth={selectedId === n.id ? 3.5 : 2}
                  opacity={selectedId === n.id ? 1 : 0.75}
                />
                {selectedId === n.id && (
                  <circle
                    r={n.r + 7}
                    fill="none"
                    stroke="#c81e3c"
                    strokeWidth={1}
                    opacity={0.35}
                  />
                )}
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}
