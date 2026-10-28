"use client";

import { toPng } from "html-to-image";
import { useEffect, useRef, useState } from "react";
import { MoodboardPoster } from "./MoodboardPoster";
import type { Analysis, Shot } from "@/lib/types";

/**
 * Shows the poster before it is saved. The node on screen is the node that
 * gets captured, so there is no gap between the preview and the file.
 */
export function ExportPreview({
  shots,
  analysis,
  onClose,
}: {
  shots: Shot[];
  analysis: Analysis;
  onClose: () => void;
}) {
  const posterRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const download = async () => {
    if (!posterRef.current) return;
    setSaving(true);
    setFailed(null);
    try {
      const dataUrl = await toPng(posterRef.current, {
        pixelRatio: 2,
        backgroundColor: "#f3f4f7",
      });
      const link = document.createElement("a");
      link.download = `digital-threads-${new Date().toISOString().slice(0, 10)}.png`;
      link.href = dataUrl;
      link.click();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "Could not render the image.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Export preview">
      <div className="overlay-panel">
        <div className="overlay-bar">
          <span className="overlay-title">Export preview</span>
          <div className="overlay-actions">
            <button type="button" onClick={download} disabled={saving}>
              {saving ? "Rendering…" : "Download PNG"}
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {failed && <p className="error overlay-error">{failed}</p>}

        <div className="overlay-scroll">
          <MoodboardPoster ref={posterRef} shots={shots} analysis={analysis} />
        </div>
      </div>
    </div>
  );
}
