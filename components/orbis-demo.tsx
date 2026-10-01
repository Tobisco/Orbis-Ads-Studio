"use client";

import { ReactorProvider } from "@reactor-team/js-sdk";
import { useCallback, useRef, useState } from "react";

import { NanoBananaExample } from "@/components/nano-banana-example";
import { OrbisControls } from "@/components/orbis-controls";
import { OrbisPlayer } from "@/components/orbis-player";
import { useOrbisSession } from "@/hooks/use-orbis-session";
import { useRunArchive, type AdTab } from "@/hooks/use-run-archive";
import { ORBIS_MODEL_NAME, ORBIS_TRACKS, requestReactorJwt } from "@/lib/orbis";

export function OrbisDemo() {
  const jwtPromise = useRef<Promise<string> | null>(null);
  const currentJwt = useRef<string | null>(null);
  const getJwt = useCallback(async () => {
    const pending = (jwtPromise.current ??= requestReactorJwt());
    try {
      const jwt = await pending;
      currentJwt.current = jwt;
      return jwt;
    } catch (error) {
      // Do not permanently cache a failed token request.
      if (jwtPromise.current === pending) jwtPromise.current = null;
      throw error;
    }
  }, []);
  const getCurrentJwt = useCallback(() => currentJwt.current, []);
  const clearJwt = useCallback(() => {
    jwtPromise.current = null;
    currentJwt.current = null;
  }, []);

  return (
    <section className="demo-shell">
      <ReactorProvider
        apiUrl="https://api.reactor.inc"
        modelName={ORBIS_MODEL_NAME}
        modelTracks={[...ORBIS_TRACKS]}
        connectOptions={{ autoConnect: false }}
        jwtToken={getJwt}
      >
        <OrbisSession
          clearJwt={clearJwt}
          getCurrentJwt={getCurrentJwt}
        />
      </ReactorProvider>
    </section>
  );
}

function OrbisSession({
  clearJwt,
  getCurrentJwt,
}: {
  clearJwt: () => void;
  getCurrentJwt: () => string | null;
}) {
  const session = useOrbisSession(clearJwt, getCurrentJwt);
  const [activeTab, setActiveTab] = useState<AdTab>("video");
  const switchingTab = useRef(false);
  const runStartedRef = useRef(session.runStarted);
  runStartedRef.current = session.runStarted;
  const runArchive = useRunArchive(activeTab, session.runStarted);

  const waitForResetCompletion = () => new Promise<boolean>((resolve) => {
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (completed: boolean) => {
      clearTimeout(timeout);
      if (pollTimer) clearTimeout(pollTimer);
      resolve(completed);
    };
    const timeout = setTimeout(() => finish(false), 15_000);
    const check = () => {
      if (!runStartedRef.current) {
        finish(true);
      } else {
        pollTimer = setTimeout(check, 50);
      }
    };
    check();
  });

  const switchTab = async (nextTab: AdTab) => {
    if (nextTab === activeTab || switchingTab.current) return;
    switchingTab.current = true;
    try {
      if (session.runStarted) {
        await runArchive.captureFrame(activeTab);
        if (!(await session.reset())) return;
        if (!(await waitForResetCompletion())) return;
      }
      setActiveTab(nextTab);
    } finally {
      switchingTab.current = false;
    }
  };

  return (
    <>
      <div className="session-grid">
        <OrbisPlayer
          connected={session.connected}
          muted={session.muted}
          runStarted={session.runStarted}
          status={session.status}
          activeTab={activeTab}
          archive={runArchive.archives[activeTab]}
          recording={runArchive.recording && runArchive.recordingTab === activeTab}
        />
        <OrbisControls
          session={session}
          activeTab={activeTab}
          onTabChange={switchTab}
          archive={runArchive.archives[activeTab]}
          isRecording={runArchive.recording && runArchive.recordingTab === activeTab}
        />
      </div>

      <NanoBananaExample
        disabled={
          !session.connected || session.runStarted || session.controlsBusy
        }
        onActivityChange={session.setNanoBusy}
        onReady={session.startFromNanoOutput}
      />
    </>
  );
}
