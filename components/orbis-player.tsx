"use client";

import { ReactorView } from "@reactor-team/js-sdk";
import { downloadRunFile, type AdTab, type RunArchive } from "@/hooks/use-run-archive";

type OrbisPlayerProps = {
  connected: boolean;
  muted: boolean;
  runStarted: boolean;
  status: string;
  activeTab: AdTab;
  archive: RunArchive | null;
  recording: boolean;
};

export function OrbisPlayer({
  connected,
  muted,
  runStarted,
  status,
  activeTab,
  archive,
  recording,
}: OrbisPlayerProps) {
  return (
    <div className="player-column">
      <div className="player">
        {runStarted ? (
          <ReactorView
            track="main_video"
            audioTrack="main_audio"
            muted={muted}
            videoObjectFit="contain"
          />
        ) : (
          <div className="player-placeholder">
            {connected ? "Configure and start a run" : "Connect to Orbis Stable"}
          </div>
        )}
        <span className={`status status-${status}`}>{status}</span>
        {recording && <span className="recording-indicator">Recording</span>}
      </div>
      {(runStarted || archive) && (
        <div className="player-downloads">
          {(recording || archive?.clipUrl) && archive && (
            <button
              type="button"
              disabled={!archive.clipUrl || archive.recordedMs < 2_000}
              onClick={() => downloadRunFile(activeTab, archive, "video")}
            >
              Download video
            </button>
          )}
          {archive?.frameUrl && (
            <button
              type="button"
              onClick={() => downloadRunFile(activeTab, archive, "frame")}
            >
              Download frame (PNG)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
