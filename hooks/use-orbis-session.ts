"use client";

import { useReactor, useReactorMessage } from "@reactor-team/js-sdk";
import { useEffect, useRef, useState } from "react";

import {
  DOCUMENTED_RESOLUTIONS,
  type OrbisMessage,
  unwrapOrbisMessage,
} from "@/lib/orbis";

const MAX_REFERENCE_SIDE = 1024;
const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

type ConditioningImagePreview = {
  url: string;
  name: string;
  width: number;
  height: number;
  sizeBytes: number;
};

function logCommandTimeline(event: string) {
  console.info("[Orbis] command timeline", {
    timestamp: new Date().toISOString(),
    event,
  });
}

async function resizeReferenceImage(file: File) {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`Could not decode reference image "${file.name}".`);
  }

  try {
    const scale = Math.min(
      1,
      MAX_REFERENCE_SIDE / Math.max(bitmap.width, bitmap.height),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the reference image.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const outputType = SUPPORTED_IMAGE_TYPES.includes(file.type)
      ? file.type
      : "image/webp";
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) =>
          result ? resolve(result) : reject(new Error("Image conversion failed.")),
        outputType,
        0.9,
      );
    });
    if (!SUPPORTED_IMAGE_TYPES.includes(blob.type)) {
      throw new Error(`Unsupported converted image type: ${blob.type || "unknown"}.`);
    }

    const baseName = file.name.replace(/\.[^.]+$/, "") || "reference-image";
    const extension = blob.type === "image/jpeg" ? "jpg" : blob.type.split("/")[1];
    return new File([blob], `${baseName}.${extension}`, {
      type: blob.type,
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}

async function prepareConditioningImage(referenceImages: File[]) {
  if (!referenceImages.length) return null;
  if (referenceImages.length > 2) {
    throw new Error("Orbis supports at most two reference images in this studio.");
  }

  const preparedImages = await Promise.all(
    referenceImages.map(resizeReferenceImage),
  );
  if (preparedImages.length === 1) return preparedImages[0];

  const bitmaps = await Promise.all(
    preparedImages.map((file) => createImageBitmap(file)),
  );
  try {
    const canvas = document.createElement("canvas");
    canvas.width = MAX_REFERENCE_SIDE;
    canvas.height = 576;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not compose the reference images.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    const margin = 24;
    const gap = 16;
    const cellWidth = (canvas.width - margin * 2 - gap) / 2;
    const cellHeight = canvas.height - margin * 2;
    bitmaps.forEach((bitmap, index) => {
      const scale = Math.min(cellWidth / bitmap.width, cellHeight / bitmap.height);
      const width = bitmap.width * scale;
      const height = bitmap.height * scale;
      const x = margin + index * (cellWidth + gap) + (cellWidth - width) / 2;
      const y = margin + (cellHeight - height) / 2;
      context.drawImage(bitmap, x, y, width, height);
    });

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) =>
          result ? resolve(result) : reject(new Error("Could not compose the reference images.")),
        "image/jpeg",
        0.92,
      );
    });
    return new File([blob], "orbis-reference-composite.jpg", {
      type: "image/jpeg",
    });
  } finally {
    bitmaps.forEach((bitmap) => bitmap.close());
  }
}

export function useOrbisSession(
  clearJwt: () => void,
  getCurrentJwt: () => string | null,
) {
  const { status, sessionId, connect, disconnect, sendCommand, uploadFile } =
    useReactor((state) => ({
      status: state.status,
      sessionId: state.sessionId,
      connect: state.connect,
      disconnect: state.disconnect,
      sendCommand: state.sendCommand,
      uploadFile: state.uploadFile,
    }));

  const [prompt, setPrompt] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [resolution, setResolution] = useState("2k");
  const [availableResolutions, setAvailableResolutions] = useState<string[]>(
    DOCUMENTED_RESOLUTIONS,
  );
  const [muted, setMuted] = useState(true);
  const [busy, setBusy] = useState(false);
  const [nanoBusy, setNanoBusy] = useState(false);
  const [runStarted, setRunStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [imageStatus, setImageStatus] = useState("");
  const [conditioningImagePreview, setConditioningImagePreview] =
    useState<ConditioningImagePreview | null>(null);
  const [error, setError] = useState("");
  const [events, setEvents] = useState<string[]>([]);

  const previousStatus = useRef(status);
  const disconnecting = useRef(false);
  const conditionsReadyResolver = useRef<(() => void) | null>(null);
  const imageReadyResolver = useRef<(() => void) | null>(null);
  const resetReadyResolver = useRef<(() => void) | null>(null);
  const conditioningImageUrl = useRef<string | null>(null);
  const expectsImageForRun = useRef(false);

  const connected = status === "ready";
  const controlsBusy = busy || nanoBusy;

  useEffect(() => () => {
    if (conditioningImageUrl.current) {
      URL.revokeObjectURL(conditioningImageUrl.current);
    }
  }, []);

  useEffect(() => {
    if (
      status === "disconnected" &&
      previousStatus.current !== "disconnected"
    ) {
      setRunStarted(false);
      setPaused(false);
      setImageStatus("");
    }
    previousStatus.current = status;
  }, [status]);

  useEffect(() => {
    const handlePageHide = (event: PageTransitionEvent) => {
      // A page entering the back-forward cache is suspended, not closed.
      if (event.persisted || !sessionId) return;

      const jwt = getCurrentJwt();
      if (!jwt) return;

      // keepalive asks the browser to finish uploading this small request even
      // after the document starts unloading. The server then terminates only
      // the session owned by this session-scoped JWT.
      void fetch("/api/session-cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, jwt }),
        keepalive: true,
      }).catch(() => {
        // The page is leaving, so there is nowhere useful to surface failure.
      });
    };

    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [getCurrentJwt, sessionId]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development" || !sessionId) {
      return;
    }

    const jwt = getCurrentJwt();
    if (!jwt) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const register = async (attempt: number) => {
      try {
        const response = await fetch("/api/session-registry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, jwt }),
        });
        if (!response.ok) {
          const result = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(
            result?.error ?? `registry returned ${response.status}`,
          );
        }
      } catch (caught) {
        if (cancelled) return;
        if (attempt < 5) {
          retryTimer = setTimeout(
            () => void register(attempt + 1),
            attempt * 1_000,
          );
          return;
        }
        setError(
          `Could not register Reactor session for development cleanup: ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        );
      }
    };

    void register(1);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [getCurrentJwt, sessionId]);

  const runAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const updateRunState = (message: OrbisMessage) => {
    if (message.type === "state") {
      if (typeof message.started === "boolean") setRunStarted(message.started);
      if (typeof message.paused === "boolean") setPaused(message.paused);
      if (message.has_image === false && !message.started) setImageStatus("");
    } else if (message.type === "generation_started") {
      setRunStarted(true);
      setPaused(false);
      if (message.image_conditioned === true) {
        setImageStatus("Orbis started from this image");
      } else if (
        message.image_conditioned === false &&
        expectsImageForRun.current
      ) {
        setImageStatus("Orbis started without image conditioning");
        setError("Orbis started without the uploaded image.");
      }
    } else if (message.type === "generation_paused") {
      setPaused(true);
    } else if (message.type === "generation_resumed") {
      setPaused(false);
    } else if (
      message.type === "generation_complete" ||
      message.type === "generation_reset"
    ) {
      setRunStarted(false);
      setPaused(false);
    }
  };

  useReactorMessage((raw: unknown) => {
    const message = unwrapOrbisMessage(raw);

    if (message.type === "conditions_ready") {
      conditionsReadyResolver.current?.();
      conditionsReadyResolver.current = null;
    }

    if (message.type === "state" && message.has_image === true) {
      imageReadyResolver.current?.();
      imageReadyResolver.current = null;
    }

    if (message.type === "state" && message.available_resolutions) {
      const reported = message.available_resolutions.map(String);
      if (reported.length) {
        setAvailableResolutions(reported);
        setResolution((current) =>
          reported.includes(current) ? current : reported.includes("2k") ? "2k" : reported[0],
        );
      }
    }

    if (!disconnecting.current) updateRunState(message);
    if (message.type === "generation_reset") {
      resetReadyResolver.current?.();
      resetReadyResolver.current = null;
    }

    if (message.type === "command_error") {
      setError(
        `${message.command || "command"}: ${message.reason || "rejected"}`,
      );
      if (message.command === "start") setRunStarted(false);
    }

    if (message.type) {
      setEvents((current) => [message.type!, ...current].slice(0, 8));
    }
  });

  const waitForSignal = (
    resolver: { current: (() => void) | null },
    signalName: string,
  ) => {
    let timeout: ReturnType<typeof setTimeout>;
    const promise = new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => {
        resolver.current = null;
        reject(new Error(`Timed out waiting for Orbis ${signalName}.`));
      }, 15_000);
      resolver.current = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    return {
      promise,
      cancel: () => {
        clearTimeout(timeout);
        resolver.current = null;
      },
    };
  };

  // Shared by the regular form and the Nano Banana one-click example.
  const startGeneration = async (
    referenceImages: File[],
    runPrompt: string,
  ) => {
    if (!runPrompt.trim()) throw new Error("Enter a prompt before starting.");
    if (conditioningImageUrl.current) {
      URL.revokeObjectURL(conditioningImageUrl.current);
      conditioningImageUrl.current = null;
    }
    setConditioningImagePreview(null);
    if (runStarted) {
      const resetReady = waitForSignal(resetReadyResolver, "generation_reset");
      logCommandTimeline("reset");
      console.info("[Orbis] sendCommand payload", { command: "reset", data: {} });
      const resetReply = await sendCommand("reset", {});
      if (!resetReply) {
        resetReady.cancel();
        throw new Error("Orbis did not confirm the active run reset.");
      }
      const resetMessage = unwrapOrbisMessage(resetReply);
      if (resetMessage.type === "command_error") {
        resetReady.cancel();
        throw new Error(`reset: ${resetMessage.reason || "rejected"}`);
      }
      if (resetMessage.type === "generation_reset") {
        resetReady.cancel();
      } else {
        await resetReady.promise;
      }
      logCommandTimeline("reset-complete");
      setRunStarted(false);
      setPaused(false);
    }
    expectsImageForRun.current = referenceImages.length > 0;
    console.info("[Orbis] Generate input", {
      mode: referenceImages.length ? "image-to-video" : "text-to-video",
      referenceCount: referenceImages.length,
      references: referenceImages.map((file) => ({
        name: file.name,
        type: file.type || "unknown",
        sizeBytes: file.size,
      })),
    });

    if (referenceImages.length) {
      const conditioningImage = await prepareConditioningImage(referenceImages);
      if (!conditioningImage) {
        throw new Error("Reference image preparation produced no image.");
      }
      const bitmap = await createImageBitmap(conditioningImage);
      const imageDimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      if (conditioningImageUrl.current) {
        URL.revokeObjectURL(conditioningImageUrl.current);
      }
      const previewUrl = URL.createObjectURL(conditioningImage);
      conditioningImageUrl.current = previewUrl;
      setConditioningImagePreview({
        url: previewUrl,
        name: conditioningImage.name,
        ...imageDimensions,
        sizeBytes: conditioningImage.size,
      });
      console.info("[Orbis] uploadFile request", {
        name: conditioningImage.name,
        type: conditioningImage.type,
        sizeBytes: conditioningImage.size,
      });
      const uploaded = await uploadFile(conditioningImage, {
        name: conditioningImage.name,
      });
      const imageReady = waitForSignal(imageReadyResolver, "state.has_image");
      const imagePayload = { image: uploaded };
      console.info("[Orbis] sendCommand payload", {
        command: "set_image",
        data: imagePayload,
      });
      logCommandTimeline("set_image");
      const rawReply = await sendCommand("set_image", imagePayload);
      if (!rawReply) {
        imageReady.cancel();
        throw new Error("Orbis did not accept the uploaded start image.");
      }

      const reply = unwrapOrbisMessage(rawReply);
      if (reply.type === "command_error") {
        imageReady.cancel();
        throw new Error(`set_image: ${reply.reason || "rejected"}`);
      }
      if (reply.type !== "image_accepted") {
        imageReady.cancel();
        throw new Error(
          `Expected image_accepted from Orbis, received ${reply.type || "an unknown reply"}.`,
        );
      }

      await imageReady.promise;
      logCommandTimeline("set_image-ack");

      const dimensions =
        reply.width && reply.height ? ` (${reply.width}×${reply.height})` : "";
      setImageStatus(`Orbis accepted image${dimensions}`);
      setEvents((current) => ["image_accepted", ...current].slice(0, 8));
    }

    if (resolution) {
      console.info("[Orbis] sendCommand payload", {
        command: "set_resolution",
        data: { resolution },
      });
      await sendCommand("set_resolution", { resolution });
    }

    const conditionsReady = waitForSignal(
      conditionsReadyResolver,
      "conditions_ready",
    );
    const promptPayload = {
      prompt: runPrompt.trim(),
    };
    logCommandTimeline("prompt");
    console.info("[Orbis] sendCommand payload", {
      command: "set_prompt",
      data: promptPayload,
    });
    const promptReply = await sendCommand("set_prompt", promptPayload);
    if (!promptReply) {
      conditionsReady.cancel();
      throw new Error("Orbis did not accept the prompt.");
    }

    const promptMessage = unwrapOrbisMessage(promptReply);
    if (promptMessage.type === "command_error") {
      conditionsReady.cancel();
      throw new Error(`set_prompt: ${promptMessage.reason || "rejected"}`);
    }

    await conditionsReady.promise;
    setEvents((current) => ["conditions_ready", ...current].slice(0, 8));
    logCommandTimeline("start");
    console.info("[Orbis] sendCommand payload", { command: "start", data: {} });
    await sendCommand("start", {});
    setRunStarted(true);
    setPaused(false);
  };

  const selectImage = (nextImage: File | null) => {
    setImage(nextImage);
    setImageStatus("");
    if (conditioningImageUrl.current) {
      URL.revokeObjectURL(conditioningImageUrl.current);
      conditioningImageUrl.current = null;
    }
    setConditioningImagePreview(null);
  };

  const startRun = (runPrompt = prompt, referenceImages?: File[]) =>
    runAction(() =>
      startGeneration(
        referenceImages ?? (image ? [image] : []),
        runPrompt,
      ),
    );

  const startFromNanoOutput = async (
    editedImage: File,
    groundedPrompt: string,
  ) => {
    setImage(editedImage);
    setPrompt(groundedPrompt);
    await runAction(() => startGeneration([editedImage], groundedPrompt));
  };

  const steerWithPrompt = (nextPrompt: string) =>
    runAction(async () => {
      if (!nextPrompt.trim()) throw new Error("Enter a prompt before steering.");
      await sendCommand("set_prompt", { prompt: nextPrompt.trim() });
    });

  const steer = () => steerWithPrompt(prompt);

  const disconnectSession = async () => {
    disconnecting.current = true;
    setRunStarted(false);
    setPaused(false);

    // Remove ReactorView before closing the WebRTC tracks it is playing.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    try {
      const disconnected = await runAction(() => disconnect());
      if (disconnected) {
        if (process.env.NODE_ENV === "development" && sessionId) {
          try {
            await fetch("/api/session-registry", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId }),
            });
          } catch {
            // A stale registry entry is harmless: the next sweep gets a 404
            // from Reactor and removes it.
          }
        }
        clearJwt();
      }
    } finally {
      disconnecting.current = false;
    }
  };

  return {
    status,
    connected,
    controlsBusy,
    runStarted,
    paused,
    muted,
    prompt,
    image,
    imageStatus,
    conditioningImagePreview,
    resolution,
    availableResolutions,
    error,
    events,
    connectSession: () => runAction(() => connect()),
    disconnectSession,
    toggleMuted: () => setMuted((current) => !current),
    setPrompt,
    selectImage,
    setResolution,
    startRun,
    startFromNanoOutput,
    setNanoBusy,
    steer,
    steerWithPrompt,
    pause: () => runAction(() => sendCommand("pause", {})),
    resume: () => runAction(() => sendCommand("resume", {})),
    reset: () => runAction(() => sendCommand("reset", {})),
  };
}

export type OrbisSession = ReturnType<typeof useOrbisSession>;
