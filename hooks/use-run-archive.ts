"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type AdTab = "video" | "url";

export type RunArchive = {
  startedAt: number;
  frameAt: number | null;
  frameUrl: string | null;
  clipUrl: string | null;
  extension: "mp4" | "webm" | null;
  mimeType: string | null;
  recordedMs: number;
  hasAudio: boolean;
};

type RunArchives = Record<AdTab, RunArchive | null>;

const EMPTY_ARCHIVES: RunArchives = { video: null, url: null };
const RECORDING_TYPES = [
  { mimeType: "video/mp4", extension: "mp4" as const },
  { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" as const },
  { mimeType: "video/webm", extension: "webm" as const },
];

export function runFileName(
  tab: AdTab,
  archive: RunArchive,
  extension: "mp4" | "webm" | "png",
) {
  const date = new Date(archive.startedAt);
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "-",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
  ].join("");
  return `orbis-ad-${tab}-${stamp}.${extension}`;
}

export function downloadRunFile(
  tab: AdTab,
  archive: RunArchive,
  kind: "video" | "frame",
) {
  const url = kind === "video" ? archive.clipUrl : archive.frameUrl;
  if (!url) return;
  const extension = kind === "frame" ? "png" : archive.extension;
  if (!extension) return;
  const link = document.createElement("a");
  link.href = url;
  link.download = runFileName(tab, archive, extension);
  link.click();
}

export function useRunArchive(activeTab: AdTab, runStarted: boolean) {
  const [archives, setArchives] = useState<RunArchives>(EMPTY_ARCHIVES);
  const [recording, setRecording] = useState(false);
  const [recordingTab, setRecordingTab] = useState<AdTab | null>(null);
  const activeTabRef = useRef(activeTab);
  const recorderRef = useRef<{
    recorder: MediaRecorder;
    tab: AdTab;
    captureStream: MediaStream;
    stopTimer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const objectUrlsRef = useRef(new Set<string>());
  const frameUrlsRef = useRef<Record<AdTab, string | null>>({ video: null, url: null });
  const clipUrlsRef = useRef<Record<AdTab, string | null>>({ video: null, url: null });

  activeTabRef.current = activeTab;

  const revokeUrl = useCallback((url: string | null) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    objectUrlsRef.current.delete(url);
  }, []);

  const makeUrl = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.add(url);
    return url;
  }, []);

  const captureFrame = useCallback(async (tab: AdTab) => {
    const video = document.querySelector<HTMLVideoElement>(".player video");
    if (!video || !video.videoWidth || !video.videoHeight) return false;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return false;
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {
      return false;
    }
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) return false;

    const frameUrl = makeUrl(blob);
    const previousUrl = frameUrlsRef.current[tab];
    frameUrlsRef.current[tab] = frameUrl;
    revokeUrl(previousUrl);
    const frameAt = Date.now();
    setArchives((current) => ({
      ...current,
      [tab]: current[tab]
        ? { ...current[tab]!, frameUrl, frameAt }
        : {
            startedAt: frameAt,
            frameAt,
            frameUrl,
            clipUrl: null,
            extension: null,
            mimeType: null,
            recordedMs: 0,
            hasAudio: false,
          },
    }));
    return true;
  }, [makeUrl, revokeUrl]);

  const stopRecording = useCallback(() => {
    const current = recorderRef.current;
    if (!current) return;
    clearTimeout(current.stopTimer);
    try {
      if (current.recorder.state !== "inactive") current.recorder.stop();
    } catch {
      // Recording can already have stopped when the stream closes.
    }
  }, []);

  useEffect(() => {
    if (!runStarted) {
      stopRecording();
      return;
    }

    const tab = activeTabRef.current;
    const startedAt = Date.now();
    revokeUrl(frameUrlsRef.current[tab]);
    revokeUrl(clipUrlsRef.current[tab]);
    frameUrlsRef.current[tab] = null;
    clipUrlsRef.current[tab] = null;
    setArchives((current) => ({
      ...current,
      [tab]: {
        startedAt,
        frameAt: null,
        frameUrl: null,
        clipUrl: null,
        extension: null,
        mimeType: null,
        recordedMs: 0,
        hasAudio: false,
      },
    }));

    let cancelled = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout>;
    const attachRecorder = () => {
      if (cancelled) return;
      const video = document.querySelector<HTMLVideoElement>(".player video") as
        | (HTMLVideoElement & {
            captureStream?: () => MediaStream;
            mozCaptureStream?: () => MediaStream;
          })
        | null;
      if (!video || !video.videoWidth || !video.videoHeight) {
        attempts += 1;
        if (attempts < 100) retryTimer = setTimeout(attachRecorder, 100);
        return;
      }

      void captureFrame(tab);
      if (typeof MediaRecorder === "undefined") return;

      let capturedStream: MediaStream | null = null;
      try {
        const capture = video.captureStream || video.mozCaptureStream;
        if (!capture) return;
        capturedStream = capture.call(video);
        const sourceStream = video.srcObject instanceof MediaStream
          ? video.srcObject
          : null;
        const videoTracks = capturedStream.getVideoTracks();
        const sourceAudioTracks = sourceStream?.getAudioTracks().filter(
          (track) => track.readyState === "live",
        ) ?? [];
        const audioTracks = sourceAudioTracks.length
          ? sourceAudioTracks
          : capturedStream.getAudioTracks();
        if (!videoTracks.length) {
          capturedStream.getTracks().forEach((track) => track.stop());
          return;
        }
        const recordingStream = new MediaStream([...videoTracks, ...audioTracks]);

        let recorder: MediaRecorder | null = null;
        let selectedType: (typeof RECORDING_TYPES)[number] | null = null;
        for (const type of RECORDING_TYPES) {
          if (!MediaRecorder.isTypeSupported(type.mimeType)) continue;
          try {
            recorder = new MediaRecorder(recordingStream, { mimeType: type.mimeType });
            selectedType = type;
            break;
          } catch {
            continue;
          }
        }
        if (!recorder || !selectedType) {
          capturedStream.getTracks().forEach((track) => track.stop());
          return;
        }

        const chunks: Blob[] = [];
        const hasAudio = audioTracks.some((track) => track.readyState === "live");
        const chosenType = selectedType;
        const runRecorder = recorder;
        const captureForCleanup = capturedStream;
        runRecorder.ondataavailable = (event) => {
          if (!event.data.size) return;
          chunks.push(event.data);
          const mimeType = runRecorder.mimeType || chosenType.mimeType;
          const clipUrl = makeUrl(new Blob(chunks, { type: mimeType }));
          const previousUrl = clipUrlsRef.current[tab];
          clipUrlsRef.current[tab] = clipUrl;
          revokeUrl(previousUrl);
          setArchives((current) => ({
            ...current,
            [tab]: current[tab]
              ? {
                  ...current[tab]!,
                  clipUrl,
                  extension: chosenType.extension,
                  mimeType,
                  recordedMs: Math.min(Date.now() - startedAt, 60_000),
                  hasAudio,
                }
              : null,
          }));
          void captureFrame(tab);
        };
        runRecorder.onstop = () => {
          const current = recorderRef.current;
          captureForCleanup.getTracks().forEach((track) => track.stop());
          if (current?.recorder !== runRecorder) return;
          clearTimeout(current.stopTimer);
          recorderRef.current = null;
          setRecording(false);
          setRecordingTab(null);
        };
        runRecorder.onerror = () => stopRecording();
        runRecorder.start(1_000);
        recorderRef.current = {
          recorder: runRecorder,
          tab,
          captureStream: capturedStream,
          stopTimer: setTimeout(() => {
            if (runRecorder.state !== "inactive") runRecorder.stop();
          }, 60_000),
        };
        setRecording(true);
        setRecordingTab(tab);
      } catch {
        capturedStream?.getTracks().forEach((track) => track.stop());
        // Capture may be blocked by the browser; the still frame remains available.
      }
    };

    attachRecorder();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      if (recorderRef.current?.tab === tab) stopRecording();
    };
  }, [captureFrame, makeUrl, revokeUrl, runStarted, stopRecording]);

  useEffect(() => () => {
    stopRecording();
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current.clear();
  }, [stopRecording]);

  return { archives, recording, recordingTab, captureFrame };
}