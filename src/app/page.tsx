"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExportPreview } from "@/components/ExportPreview";
import { GraphCanvas } from "@/components/GraphCanvas";
import { disposeOcr, makeThumb, runOcr } from "@/lib/ocr";
import { PALETTE, analyseLocally, buildLinks } from "@/lib/themes";
import { clearBatch, loadBatch, saveBatch } from "@/lib/store";
import {
  EMPTY_ANALYSIS,
  type Analysis,
  type Provider,
  type Shot,
  type Theme,
} from "@/lib/types";

/** Models reach for markdown; nothing here renders it, so take it back out. */
function stripEmphasis(text: string) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1");
}

type KeyedProvider = "gemini" | "claude";

const KEY_STORAGE: Record<KeyedProvider, string> = {
  gemini: "digitalthreads.geminiKey",
  claude: "digitalthreads.anthropicKey",
};

/** Storage can throw in private windows; the key field just starts empty. */
function readKey(provider: KeyedProvider) {
  try {
    return localStorage.getItem(KEY_STORAGE[provider]) ?? "";
  } catch {
    return "";
  }
}

function writeKey(provider: KeyedProvider, value: string) {
  try {
    if (value) localStorage.setItem(KEY_STORAGE[provider], value);
    else localStorage.removeItem(KEY_STORAGE[provider]);
  } catch {
    // Not remembered, but still used for this visit.
  }
}

const KEY_FIELD: Record<
  KeyedProvider,
  { label: string; placeholder: string; note: React.ReactNode }
> = {
  gemini: {
    label: "Gemini API key",
    placeholder: "AIza…",
    note: (
      <>
        Free from{" "}
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
          Google AI Studio
        </a>
        . Kept in this browser only and sent straight to Google.
      </>
    ),
  },
  claude: {
    label: "Anthropic API key",
    placeholder: "sk-ant-…",
    note: "Kept in this browser only and sent straight to Anthropic.",
  },
};

type JobState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "error"; message: string };

export default function Home() {
  const [shots, setShots] = useState<Shot[]>([]);
  const [analysis, setAnalysis] = useState<Analysis>(EMPTY_ANALYSIS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Hovering previews a theme; clicking pins it so you can move the mouse
  // away and still read the cluster.
  const [pinnedThemeId, setPinnedThemeId] = useState<string | null>(null);
  const [hoverThemeId, setHoverThemeId] = useState<string | null>(null);
  const highlightThemeId = pinnedThemeId ?? hoverThemeId;
  const [job, setJob] = useState<JobState>({ kind: "idle" });
  // Local model by default: free, offline, and already on this machine.
  const [provider, setProvider] = useState<Provider>("ollama");
  const [keys, setKeys] = useState<Record<KeyedProvider, string>>({
    gemini: "",
    claude: "",
  });
  const [exporting, setExporting] = useState(false);
  const [restored, setRestored] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadBatch().then((saved) => {
      if (saved.length) setShots(saved);
      setRestored(true);
    });
    // Opened from anywhere but the laptop itself, the local model is almost
    // certainly not reachable, so start on the free option that can work.
    if (!/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) {
      setProvider("gemini");
    }
    setKeys({ gemini: readKey("gemini"), claude: readKey("claude") });
    return () => void disposeOcr();
  }, []);

  useEffect(() => {
    if (restored) void saveBatch(shots);
  }, [shots, restored]);

  // The theme list re-renders under the pointer, which can unmount the row the
  // browser thinks is hovered — then no mouseleave ever fires and the graph
  // stays dimmed with nothing to show why. Watching the document is the only
  // reliable way back out.
  useEffect(() => {
    if (!hoverThemeId) return;
    const clearIfOutside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.(".themes")) setHoverThemeId(null);
    };
    document.addEventListener("pointermove", clearIfOutside);
    return () => document.removeEventListener("pointermove", clearIfOutside);
  }, [hoverThemeId]);

  const reading = shots.some((s) => s.status === "reading" || s.status === "pending");
  /** Claude sees the picture, so a wordless screenshot is still worth sending. */
  const analysable = shots.filter((s) => s.status === "done");

  // The local pass is cheap, so it just re-runs whenever the batch settles.
  useEffect(() => {
    if (reading) return;
    // A model's analysis is better than the keyword pass — don't overwrite it.
    setAnalysis((current) =>
      current.source === "local" ? analyseLocally(shots) : current,
    );
  }, [shots, reading]);

  const addFiles = useCallback(async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;

    const entries: { shot: Shot; file: File }[] = [];
    for (const file of images) {
      const id = crypto.randomUUID();
      try {
        const { thumb, width, height } = await makeThumb(file);
        entries.push({
          file,
          shot: {
            id,
            name: file.name,
            thumb,
            width,
            height,
            text: "",
            status: "reading",
            addedAt: Date.now(),
          },
        });
      } catch {
        // A file the browser can't decode isn't worth a slot in the batch.
      }
    }

    setShots((prev) => [...prev, ...entries.map((e) => e.shot)]);
    setAnalysis(EMPTY_ANALYSIS);
    setJob({ kind: "idle" });

    await runOcr(
      entries.map((e) => ({ id: e.shot.id, file: e.file })),
      ({ id, text, error }) => {
        setShots((prev) =>
          prev.map((s) =>
            s.id === id
              ? { ...s, text, error, status: error ? "error" : "done" }
              : s,
          ),
        );
      },
    );
  }, []);

  const runAnalysis = async () => {
    setJob({ kind: "working" });
    try {
      // Loaded on first use: the Anthropic SDK is most of its weight, and most
      // visits never get this far.
      const { analyse } = await import("@/lib/analyze");
      const data = await analyse(
        provider,
        analysable.map((s) => ({
          id: s.id,
          name: s.name,
          text: s.text,
          image: s.thumb,
        })),
        provider === "ollama" ? undefined : keys[provider],
      );

      const themes: Theme[] = data.themes.map((t, i) => ({
        id: `theme-${i}`,
        label: t.label,
        weight: 1 - i / Math.max(data.themes.length, 1),
        shotIds: t.shotIds.filter((id) => analysable.some((s) => s.id === id)),
        color: PALETTE[i % PALETTE.length],
        rationale: t.rationale,
      }));

      setAnalysis({
        themes,
        links: buildLinks(analysable, themes),
        summary: stripEmphasis(data.summary),
        source: provider,
      });
      setJob({ kind: "idle" });
    } catch (error) {
      setJob({
        kind: "error",
        message: error instanceof Error ? error.message : "The analysis failed.",
      });
    }
  };

  const reset = async () => {
    await clearBatch();
    setShots([]);
    setAnalysis(EMPTY_ANALYSIS);
    setSelectedId(null);
    setPinnedThemeId(null);
    setHoverThemeId(null);
    setJob({ kind: "idle" });
  };

  const selected = useMemo(
    () => shots.find((s) => s.id === selectedId) ?? null,
    [shots, selectedId],
  );

  const selectedThemes = analysis.themes.filter((t) =>
    selectedId ? t.shotIds.includes(selectedId) : false,
  );

  const done = shots.filter((s) => s.status === "done").length;
  const failed = shots.filter((s) => s.status === "error").length;

  return (
    <main className="layout">
      <header className="masthead">
        <div>
          <h1>Digital Threads</h1>
          <p className="sub">
            Drop a batch of saved screenshots. It reads them, finds what keeps
            coming up, and draws the connections.
          </p>
        </div>
        {shots.length > 0 && (
          <button type="button" className="ghost" onClick={reset}>
            Clear batch
          </button>
        )}
      </header>

      <section
        className="dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles([...e.dataTransfer.files]);
        }}
        onClick={() => fileInput.current?.click()}
      >
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <strong>Drop screenshots here</strong>
        <span>or click to choose — 10 to 50 works best</span>
      </section>

      {shots.length > 0 && (
        <p className="status">
          {reading
            ? `Reading ${done} of ${shots.length}…`
            : `${done} read · ${analysis.themes.length} themes · ${analysis.links.length} connections`}
          {!reading && failed > 0 && ` · ${failed} couldn't be read`}
          {analysis.source === "ollama" && " · analysed locally"}
          {analysis.source === "gemini" && " · analysed by Gemini"}
          {analysis.source === "claude" && " · analysed by Claude"}
        </p>
      )}

      <div className="columns">
        <div className="main-col">
          <GraphCanvas
            shots={shots}
            analysis={analysis}
            selectedId={selectedId}
            onSelect={setSelectedId}
            highlightThemeId={highlightThemeId}
            onExport={() => {
              // A highlighted theme dims most of the canvas; the exported
              // picture should show the whole batch.
              setPinnedThemeId(null);
              setHoverThemeId(null);
              setExporting(true);
            }}
          />
        </div>

        <aside className="side-col">
          {analysis.themes.length > 0 && (
            <section className="panel">
              <h2>Themes</h2>
              {/* Leaving the list as a whole is the reliable signal — a
                  per-row mouseleave can be missed when the list re-renders
                  under the pointer, which strands the graph dimmed. */}
              <ul className="themes" onMouseLeave={() => setHoverThemeId(null)}>
                {analysis.themes.map((theme) => (
                  <li key={theme.id}>
                    <button
                      type="button"
                      className={pinnedThemeId === theme.id ? "theme on" : "theme"}
                      onMouseEnter={() => setHoverThemeId(theme.id)}
                      onFocus={() => setHoverThemeId(theme.id)}
                      onBlur={() => setHoverThemeId(null)}
                      onClick={() =>
                        setPinnedThemeId((v) => (v === theme.id ? null : theme.id))
                      }
                    >
                      <span className="swatch" style={{ background: theme.color }} />
                      <span className="label">{theme.label}</span>
                      <span className="count">{theme.shotIds.length}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel">
            <h2>Summary</h2>
            {analysis.summary ? (
              <p className="summary">{analysis.summary}</p>
            ) : (
              <p className="muted">
                The keyword pass only reads text. A vision model looks at the
                screenshots themselves, so the ones that are mostly picture
                count too.
              </p>
            )}

            {/* Always available, so you can run the other model on the same
                batch and compare the two readings. */}
            <div className={analysis.summary ? "rerun" : undefined}>
              <div className="segmented" role="group" aria-label="Analyser">
                  <button
                    type="button"
                    className={provider === "ollama" ? "seg on" : "seg"}
                    aria-pressed={provider === "ollama"}
                    onClick={() => setProvider("ollama")}
                  >
                    On this machine
                    <small>free · private · slower</small>
                  </button>
                  <button
                    type="button"
                    className={provider === "gemini" ? "seg on" : "seg"}
                    aria-pressed={provider === "gemini"}
                    onClick={() => setProvider("gemini")}
                  >
                    Gemini
                    <small>free key · rate limited</small>
                  </button>
                  <button
                    type="button"
                    className={provider === "claude" ? "seg on" : "seg"}
                    aria-pressed={provider === "claude"}
                    onClick={() => setProvider("claude")}
                  >
                    Claude
                    <small>sharper · costs tokens</small>
                  </button>
                </div>

                {provider !== "ollama" && (
                  <label className="key">
                    <span>{KEY_FIELD[provider].label}</span>
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={KEY_FIELD[provider].placeholder}
                      value={keys[provider]}
                      onChange={(e) => {
                        const value = e.target.value;
                        setKeys((current) => ({ ...current, [provider]: value }));
                        writeKey(provider, value);
                      }}
                    />
                    <small className="muted">{KEY_FIELD[provider].note}</small>
                  </label>
                )}

                <button
                  type="button"
                  disabled={analysable.length < 2 || job.kind === "working"}
                  onClick={runAnalysis}
                >
                  {job.kind === "working"
                    ? `Looking at ${analysable.length} screenshots…`
                    : analysis.summary
                      ? "Re-analyse"
                      : "Analyse"}
                </button>
                {analysable.length < 2 && shots.length > 0 && (
                  <p className="muted hint">
                    Needs at least two screenshots that were read successfully.
                  </p>
                )}
                {provider === "ollama" && job.kind === "working" && (
                  <p className="muted hint">
                    Running locally — a big batch can take a few minutes.
                  </p>
                )}
            </div>
            {job.kind === "error" && <p className="error">{job.message}</p>}
          </section>

          {selected && (
            <section className="panel">
              <h2>Screenshot</h2>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="preview" src={selected.thumb} alt={selected.name} />
              <p className="filename">{selected.name}</p>
              {selectedThemes.length > 0 && (
                <p className="chips">
                  {selectedThemes.map((t) => (
                    <span key={t.id} className="chip">
                      <span className="swatch" style={{ background: t.color }} />
                      {t.label}
                    </span>
                  ))}
                </p>
              )}
              <pre className="ocr">{selected.text || "No text found in this one."}</pre>
            </section>
          )}
        </aside>
      </div>

      {exporting && (
        <ExportPreview
          shots={shots}
          analysis={analysis}
          onClose={() => setExporting(false)}
        />
      )}
    </main>
  );
}
