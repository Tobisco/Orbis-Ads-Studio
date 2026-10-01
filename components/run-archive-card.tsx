"use client";

import { useState } from "react";

import {
  downloadRunFile,
  type AdTab,
  type RunArchive,
} from "@/hooks/use-run-archive";

export function RunArchiveCard({
  activeTab,
  archive,
  isRecording,
  canGenerateAgain,
  onGenerateAgain,
}: {
  activeTab: AdTab;
  archive: RunArchive | null;
  isRecording: boolean;
  canGenerateAgain: boolean;
  onGenerateAgain: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  if (!archive) return null;

  return (
    <section className="last-run-card" aria-label={`${activeTab} last run`}>
      <strong>Last run</strong>
      {archive.frameUrl && (
        <img src={archive.frameUrl} alt="Saved frame from the last run" />
      )}
      <small>
        {new Date(archive.frameAt || archive.startedAt).toLocaleString()}
      </small>
      {archive.clipUrl && (
        <small>
          Format: {archive.extension?.toUpperCase()} · Audio track: {archive.hasAudio ? "yes" : "no"} · {Math.floor(archive.recordedMs / 1_000)}s
        </small>
      )}
      <div className="last-run-actions">
        <button
          type="button"
          disabled={!archive.clipUrl || isRecording}
          onClick={() => setPlaying((current) => !current)}
        >
          {playing ? "Stop" : "Play"}
        </button>
        {(archive.clipUrl || isRecording) && (
          <button
            type="button"
            disabled={!archive.clipUrl || archive.recordedMs < 2_000}
            onClick={() => downloadRunFile(activeTab, archive, "video")}
          >
            Download video
          </button>
        )}
        <button
          type="button"
          disabled={!archive.frameUrl}
          onClick={() => downloadRunFile(activeTab, archive, "frame")}
        >
          Download frame (PNG)
        </button>
        <button
          type="button"
          disabled={!canGenerateAgain}
          onClick={onGenerateAgain}
        >
          Generate again
        </button>
      </div>
      {playing && archive.clipUrl && (
        <video
          className="last-run-playback"
          src={archive.clipUrl}
          controls
          autoPlay
          onEnded={() => setPlaying(false)}
        />
      )}
    </section>
  );
}