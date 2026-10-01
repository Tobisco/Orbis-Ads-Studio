"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

import type { OrbisSession } from "@/hooks/use-orbis-session";
import { RunArchiveCard } from "@/components/run-archive-card";
import type { AdTab, RunArchive } from "@/hooks/use-run-archive";

const moodPrompts = {
  Energetic:
    "Bright high-contrast light, vivid backdrop; upbeat electronic audio, sharp percussion.",
  Calm: "Soft diffused light, warm muted backdrop; quiet acoustic ambience.",
  Luxury:
    "Low-key light, deep shadows, warm rim light; dark backdrop, low ambient tone, single chime.",
};

const FRAME_LOCK_INSTRUCTION =
  "The whole product stays centered, large and in focus in every frame, never cropped or far away. No text, no logos.";
const FRAME_LOCK_SIMILARITY_THRESHOLD = 0.18;
const FRAME_LOCK_REQUIRED_LOW_SAMPLES = 3;
const FRAME_SAMPLE_WIDTH = 64;
const FRAME_SAMPLE_HEIGHT = 36;

const framingPrompts = {
  "Close-up": "Close-up: product fills at least 70% of frame.",
  Medium: "Medium: product ~55% frame.",
  Wide: "Wide: product fills about 45% of frame; no open scene.",
};

const cameraPrompts = {
  Static: "Camera stays fixed.",
  "Slow orbit": "Small, slow orbit of about 30 degrees at a constant distance.",
  "Slow push-in": "Very slow push-in; stop fully framed.",
  "Slow pull-back": "Very slow pull-back; stop above 40% product size.",
};

type ImageRelationship = "same-product" | "separate-products";
type ProductExtraction = {
  title: string;
  description: string;
  finalUrl: string;
  file: File;
  preview: string;
};

type VideoGenerateDiagnostic = {
  mode: string;
  referenceCount: number;
  descriptionSource: string;
  promptChars: number;
  imageCommandStatus: "pending" | "sent+acked" | "failed" | "not-needed";
  runId: string;
};

function buildFinalPrompt(
  basePrompt: string,
  referenceCount: number,
  relationship: ImageRelationship,
  presetPrompt = "",
) {
  const identityInstruction =
    "Use the exact product in the reference image. Keep its shape, proportions, color, finish, materials and design unchanged in every frame. Lighting and background may change, but the product itself must not change color, material or form. Do not substitute another product.";
  const imageRelationship = referenceCount === 2
    ? relationship === "same-product"
      ? "Image 1 and Image 2 are different angles of the same product."
      : "Image 1 and Image 2 show two separate products; preserve both product identities."
    : "";
  return [
    identityInstruction,
    presetPrompt.trim(),
    basePrompt.trim(),
    imageRelationship,
  ]
    .filter(Boolean)
    .join(" ");
}

const VIDEO_IDENTITY_INSTRUCTION =
  "Keep this exact product from the reference image unchanged in shape, color, finish and design in every frame.";

function trimProductDescription(description: string) {
  return description.trim().split(/\s+/).filter(Boolean).slice(0, 20).join(" ");
}

function buildVideoFinalPrompt(
  userText: string,
  referenceCount: number,
  productDescription: string,
  framingPrompt: string,
  cameraPrompt: string,
  presetPrompt: string,
) {
  if (!referenceCount) return userText.trim();
  const textareaContainsPreset = Boolean(presetPrompt && userText.includes(presetPrompt));
  const customText = textareaContainsPreset
    ? userText.replace(presetPrompt, "").trim()
    : userText.trim();
  return [
    VIDEO_IDENTITY_INSTRUCTION,
    productDescription.trim()
      ? `Product: ${trimProductDescription(productDescription)}`
      : "",
    framingPrompt,
    cameraPrompt,
    textareaContainsPreset ? presetPrompt.trim() : "",
    customText,
    FRAME_LOCK_INSTRUCTION,
  ]
    .filter(Boolean)
    .join(" ");
}

function removePresetText(prompt: string, preset: string) {
  return prompt
    .replace(preset, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function grayscaleHistogram(imageData: ImageData) {
  const histogram = new Float32Array(16);
  const pixelCount = imageData.data.length / 4;
  for (let index = 0; index < imageData.data.length; index += 4) {
    const luminance = Math.round(
      imageData.data[index] * 0.2126 +
      imageData.data[index + 1] * 0.7152 +
      imageData.data[index + 2] * 0.0722,
    );
    histogram[luminance >> 4] += 1;
  }
  for (let index = 0; index < histogram.length; index += 1) {
    histogram[index] /= pixelCount;
  }
  return histogram;
}

function histogramSimilarity(left: Float32Array, right: Float32Array) {
  let intersection = 0;
  for (let index = 0; index < left.length; index += 1) {
    intersection += Math.min(left[index], right[index]);
  }
  return intersection;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}

function buildUrlPrompt(
  product: ProductExtraction | null,
  additionalDetails: string,
) {
  if (!product) return "";
  return [
    `Product: ${product.title}`,
    product.description ? `Description: ${product.description}` : "",
    additionalDetails.trim()
      ? `Additional details: ${additionalDetails.trim()}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function OrbisControls({
  session,
  activeTab,
  onTabChange,
  archive,
  isRecording,
}: {
  session: OrbisSession;
  activeTab: AdTab;
  onTabChange: (tab: AdTab) => void;
  archive: RunArchive | null;
  isRecording: boolean;
}) {
  const [activeMood, setActiveMood] = useState<string | null>(null);
  const [videoPrompt, setVideoPrompt] = useState("");
  const [framing, setFraming] = useState<keyof typeof framingPrompts>("Medium");
  const [camera, setCamera] = useState<keyof typeof cameraPrompts>("Static");
  const [keepProductInFrame, setKeepProductInFrame] = useState(true);
  const [autoRestartCount, setAutoRestartCount] = useState(0);
  const [frameRecoveryNotice, setFrameRecoveryNotice] = useState("");
  const [manualProductDescription, setManualProductDescription] = useState("");
  const [autoProductDescription, setAutoProductDescription] = useState("");
  const [productDescriptionLoading, setProductDescriptionLoading] = useState(false);
  const [productDescriptionUnavailable, setProductDescriptionUnavailable] = useState(false);
  const [productDescriptionError, setProductDescriptionError] = useState("");
  const [descriptionRetryCount, setDescriptionRetryCount] = useState(0);
  const [productUrl, setProductUrl] = useState("");
  const [manualImageUrl, setManualImageUrl] = useState("");
  const [additionalDetails, setAdditionalDetails] = useState("");
  const [productExtraction, setProductExtraction] =
    useState<ProductExtraction | null>(null);
  const [productLookupError, setProductLookupError] = useState("");
  const [lookingUpProduct, setLookingUpProduct] = useState(false);
  const [referenceImages, setReferenceImages] = useState<File[]>([]);
  const [generateDebug, setGenerateDebug] = useState("");
  const [videoGenerateDiagnostic, setVideoGenerateDiagnostic] =
    useState<VideoGenerateDiagnostic | null>(null);
  const runSequence = useRef(0);
  const [imageRelationship, setImageRelationship] =
    useState<ImageRelationship>("same-product");
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const autoRestartCountRef = useRef(0);
  const lowSimilarityCountRef = useRef(0);
  const recoveryInProgressRef = useRef(false);
  const recoveryRunRef = useRef<{ prompt: string; images: File[] }>({
    prompt: "",
    images: [],
  });
  const recoveryStartRef = useRef(session.startRun);
  recoveryStartRef.current = session.startRun;
  const validProductUrl = isHttpUrl(productUrl);
  const productDescription = manualProductDescription.trim() || autoProductDescription;
  const selectedMoodPrompt = activeMood
    ? moodPrompts[activeMood as keyof typeof moodPrompts]
    : "";
  const descriptionSource = manualProductDescription.trim()
    ? "manual"
    : autoProductDescription
      ? "auto"
      : "none";
  const urlPrompt = buildUrlPrompt(productExtraction, additionalDetails);
  const activePrompt = activeTab === "url" ? urlPrompt : videoPrompt;
  const finalPrompt = activeTab === "url"
    ? buildFinalPrompt(
        activePrompt,
        Number(Boolean(productExtraction)),
        imageRelationship,
        selectedMoodPrompt,
      )
    : buildVideoFinalPrompt(
        videoPrompt,
        referenceImages.length,
        productDescription,
        framingPrompts[framing],
        cameraPrompts[camera],
        selectedMoodPrompt,
      );

  useEffect(() => {
    const referenceImage = referenceImages[0];
    if (activeTab !== "video" || !referenceImage) {
      setAutoProductDescription("");
      setProductDescriptionLoading(false);
      setProductDescriptionUnavailable(false);
      setProductDescriptionError("");
      return;
    }

    const controller = new AbortController();
    const formData = new FormData();
    formData.set("image", referenceImage);
    setAutoProductDescription("");
    setProductDescriptionUnavailable(false);
    setProductDescriptionError("");
    setProductDescriptionLoading(true);
    void fetch("/api/video-product-description", {
      method: "POST",
      body: formData,
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = (await response.json()) as {
          description?: string;
          error?: string;
        };
        if (!response.ok) {
          throw new Error(result.error || `Vision request failed (${response.status}).`);
        }
        if (!controller.signal.aborted) {
          setAutoProductDescription(result.description || "");
          setProductDescriptionUnavailable(!result.description);
          setProductDescriptionError(
            result.description ? "" : "Vision model returned no description.",
          );
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setAutoProductDescription("");
          setProductDescriptionUnavailable(true);
          setProductDescriptionError(
            caught instanceof Error ? caught.message : "Vision request failed.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setProductDescriptionLoading(false);
      });

    return () => controller.abort();
  }, [activeTab, referenceImages, descriptionRetryCount]);

  useEffect(() => {
    const runId = videoGenerateDiagnostic?.runId;
    const referenceImage = referenceImages[0];
    if (
      activeTab !== "video" ||
      !keepProductInFrame ||
      !session.runStarted ||
      !runId ||
      !referenceImage
    ) {
      return;
    }

    let stopped = false;
    let sampling = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    let referenceBitmap: ImageBitmap | null = null;
    let referenceHistogram: Float32Array | null = null;
    const canvas = document.createElement("canvas");
    canvas.width = FRAME_SAMPLE_WIDTH;
    canvas.height = FRAME_SAMPLE_HEIGHT;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;

    const stopMonitoring = () => {
      if (interval) clearInterval(interval);
      interval = undefined;
    };

    const sampleFrame = () => {
      if (stopped || sampling || !referenceHistogram || recoveryInProgressRef.current) return;
      const video = document.querySelector<HTMLVideoElement>(".player video");
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

      sampling = true;
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const currentHistogram = grayscaleHistogram(
          context.getImageData(0, 0, canvas.width, canvas.height),
        );
        const similarity = histogramSimilarity(referenceHistogram, currentHistogram);
        console.info("[Orbis] frame lock check", {
          timestamp: new Date().toISOString(),
          runId,
          similarity: Number(similarity.toFixed(3)),
          threshold: FRAME_LOCK_SIMILARITY_THRESHOLD,
        });
        if (similarity < FRAME_LOCK_SIMILARITY_THRESHOLD) {
          lowSimilarityCountRef.current += 1;
        } else {
          lowSimilarityCountRef.current = 0;
        }
        if (lowSimilarityCountRef.current < FRAME_LOCK_REQUIRED_LOW_SAMPLES) return;

        lowSimilarityCountRef.current = 0;
        if (autoRestartCountRef.current >= 3) {
          setFrameRecoveryNotice(
            "Product keeps drifting. Try a cleaner reference photo or Close-up framing.",
          );
          stopMonitoring();
          return;
        }

        autoRestartCountRef.current += 1;
        setAutoRestartCount(autoRestartCountRef.current);
        setFrameRecoveryNotice("Product left frame, restarted from your image.");
        recoveryInProgressRef.current = true;
        console.warn("[Orbis] frame lock recovery", {
          timestamp: new Date().toISOString(),
          runId,
          restart: autoRestartCountRef.current,
        });
        const recoveryRun = recoveryRunRef.current;
        void recoveryStartRef.current(recoveryRun.prompt, recoveryRun.images)
          .then((started) => {
            if (!started) {
              setFrameRecoveryNotice(
                "Product keeps drifting. Try a cleaner reference photo or Close-up framing.",
              );
            }
          })
          .finally(() => {
            recoveryInProgressRef.current = false;
          });
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "SecurityError") {
          setFrameRecoveryNotice("Long runs drift. Hit Generate to restart from your image.");
          console.warn("[Orbis] frame lock canvas sampling blocked by stream security policy.");
          stopMonitoring();
          return;
        }
        console.error("[Orbis] frame lock sampling failed", caught);
      } finally {
        sampling = false;
      }
    };

    void createImageBitmap(referenceImage)
      .then((bitmap) => {
        if (stopped) {
          bitmap.close();
          return;
        }
        referenceBitmap = bitmap;
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        referenceHistogram = grayscaleHistogram(
          context.getImageData(0, 0, canvas.width, canvas.height),
        );
        sampleFrame();
        interval = setInterval(sampleFrame, 3_000);
      })
      .catch((caught) => {
        console.error("[Orbis] reference image could not be sampled", caught);
        setFrameRecoveryNotice("Long runs drift. Hit Generate to restart from your image.");
      });

    return () => {
      stopped = true;
      stopMonitoring();
      referenceBitmap?.close();
      lowSimilarityCountRef.current = 0;
    };
  }, [
    activeTab,
    keepProductInFrame,
    referenceImages,
    session.runStarted,
    videoGenerateDiagnostic?.runId,
  ]);

  useEffect(() => {
    if (!validProductUrl) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/product-extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: productUrl.trim() }),
          signal: controller.signal,
        });
        const result = (await response.json()) as {
          title?: string;
          description?: string;
          finalUrl?: string;
          mimeType?: string;
          imageBase64?: string;
          error?: string;
        };
        if (!response.ok || !result.imageBase64 || !result.mimeType) {
          throw new Error(result.error || "No product image was found at this URL.");
        }

        const bytes = Uint8Array.from(atob(result.imageBase64), (character) =>
          character.charCodeAt(0),
        );
        const extension = result.mimeType === "image/jpeg"
          ? "jpg"
          : result.mimeType.split("/")[1] || "img";
        const file = new File([bytes], `url-product.${extension}`, {
          type: result.mimeType,
        });
        if (controller.signal.aborted) return;

        setProductExtraction({
          title: result.title || "Product from URL",
          description: result.description || "",
          finalUrl: result.finalUrl || productUrl,
          file,
          preview: `data:${result.mimeType};base64,${result.imageBase64}`,
        });
        setProductLookupError("");
      } catch (caught) {
        if (controller.signal.aborted) return;
        setProductExtraction(null);
        setProductLookupError(
          caught instanceof Error ? caught.message : "Product extraction failed.",
        );
      } finally {
        if (!controller.signal.aborted) setLookingUpProduct(false);
      }
    }, 450);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [productUrl, validProductUrl]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (generateDisabled) return;
    const videoReferences = activeTab === "video" ? referenceImages : [];
    const runReferences = activeTab === "url"
      ? productExtraction
        ? [productExtraction.file]
        : []
      : videoReferences;
    const promptReferences = activeTab === "url"
      ? Number(Boolean(productExtraction))
      : videoReferences.length;
    runSequence.current += 1;
    const runId = `run-${Date.now()}-${runSequence.current}`;
    const mode = activeTab === "url"
      ? "url-to-ad"
      : videoReferences.length
        ? "image-to-video"
        : "text-to-video";
    const prompt = activeTab === "video"
      ? buildVideoFinalPrompt(
          videoPrompt,
          videoReferences.length,
          productDescription,
          framingPrompts[framing],
          cameraPrompts[camera],
          selectedMoodPrompt,
        )
      : buildFinalPrompt(
          activePrompt,
          promptReferences,
          imageRelationship,
          selectedMoodPrompt,
        );
    if (activeTab === "video") {
      autoRestartCountRef.current = 0;
      setAutoRestartCount(0);
      setFrameRecoveryNotice("");
      recoveryRunRef.current = { prompt, images: videoReferences };
      setVideoGenerateDiagnostic({
        mode,
        referenceCount: videoReferences.length,
        descriptionSource: videoReferences.length ? descriptionSource : "none",
        promptChars: prompt.length,
        imageCommandStatus: videoReferences.length ? "pending" : "not-needed",
        runId,
      });
      console.info("[Orbis] Final prompt", prompt);
      void session.startRun(prompt, videoReferences).then((started) => {
        setVideoGenerateDiagnostic((current) => current?.runId === runId
          ? {
              ...current,
              imageCommandStatus: videoReferences.length
                ? started ? "sent+acked" : "failed"
                : "not-needed",
            }
          : current);
      });
      return;
    }
    setGenerateDebug(
      `Mode: ${mode} | Refs: ${runReferences.length} | Prompt chars: ${prompt.length} | set_image sent: ${runReferences.length ? "yes" : "no"} | Run id: ${runId}`,
    );
    console.info("[Orbis] Generate", {
      mode,
      referenceCount: runReferences.length,
      references: runReferences.map((file) => ({
        name: file.name,
        type: file.type || "unknown",
        sizeBytes: file.size,
      })),
      productImage: activeTab === "url" ? "extracted" : undefined,
    });
    console.log("[Orbis] Final prompt", prompt);
    void session.startRun(prompt, runReferences);
  };

  const updateReferenceImages = (files: File[]) => {
    setReferenceImages(files);
    setManualProductDescription("");
    setAutoProductDescription("");
    setProductDescriptionUnavailable(false);
    setProductDescriptionError("");
    setProductDescriptionLoading(files.length > 0);
    session.selectImage(files[0] || null);

    if (referenceInputRef.current) {
      const transfer = new DataTransfer();
      files.forEach((file) => transfer.items.add(file));
      referenceInputRef.current.files = transfer.files;
    }
  };

  const toggleMood = (mood: string) => {
    const preset = moodPrompts[mood as keyof typeof moodPrompts];
    if (activeMood === mood) {
      setActiveMood(null);
      setVideoPrompt((current) => removePresetText(current, preset));
      return;
    }

    setActiveMood(mood);
    setVideoPrompt((current) => {
      const previousPreset = activeMood
        ? moodPrompts[activeMood as keyof typeof moodPrompts]
        : "";
      const withoutPreviousPreset = previousPreset
        ? removePresetText(current, previousPreset)
        : current.trim();
      if (
        !withoutPreviousPreset.trim() ||
        Object.values(moodPrompts).includes(withoutPreviousPreset.trim())
      ) {
        return preset;
      }
      return `${withoutPreviousPreset.trimEnd()}\n${preset}`;
    });
  };

  const useManualImageUrl = async () => {
    if (!isHttpUrl(manualImageUrl) || lookingUpProduct) return;
    setLookingUpProduct(true);
    try {
      const response = await fetch("/api/product-extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: manualImageUrl.trim() }),
      });
      const result = (await response.json()) as {
        title?: string;
        description?: string;
        finalUrl?: string;
        mimeType?: string;
        imageBase64?: string;
        error?: string;
      };
      if (!response.ok || !result.imageBase64 || !result.mimeType) {
        throw new Error(result.error || "Could not load that product image URL.");
      }
      const bytes = Uint8Array.from(atob(result.imageBase64), (character) =>
        character.charCodeAt(0),
      );
      const extension = result.mimeType === "image/jpeg"
        ? "jpg"
        : result.mimeType.split("/")[1] || "img";
      const file = new File([bytes], `url-product.${extension}`, {
        type: result.mimeType,
      });
      setProductExtraction({
        title: result.title || "Product image",
        description: result.description || "",
        finalUrl: result.finalUrl || manualImageUrl,
        file,
        preview: `data:${result.mimeType};base64,${result.imageBase64}`,
      });
      setProductLookupError("");
    } catch (caught) {
      setProductLookupError(
        caught instanceof Error ? caught.message : "Product image extraction failed.",
      );
    } finally {
      setLookingUpProduct(false);
    }
  };

  const generateDisabled =
    !session.connected ||
    session.controlsBusy ||
    (activeTab === "video" && referenceImages.length > 2) ||
    (activeTab === "url" &&
      (!validProductUrl || lookingUpProduct || !productExtraction));
  const generateDisabledReason = !session.connected
    ? "Connect before generating."
    : session.controlsBusy
        ? "Controls are busy."
        : activeTab === "video" && referenceImages.length > 2
          ? "Orbis supports at most two reference images in this studio."
          : activeTab === "url" && !validProductUrl
            ? "Enter a valid http(s) product URL."
            : activeTab === "url" && lookingUpProduct
              ? "Extracting product image…"
              : activeTab === "url" && productLookupError
                ? productLookupError
                : activeTab === "url" && !productExtraction
                  ? "No product image was extracted from this URL."
                  : "";

  return (
    <form ref={formRef} className="controls" onSubmit={submit}>
      <div className="mode-tabs" role="tablist" aria-label="Ad creation mode">
        <button
          id="video-ads-tab"
          type="button"
          role="tab"
          aria-selected={activeTab === "video"}
          aria-controls="video-ads-panel"
          className={activeTab === "video" ? "active" : ""}
          onClick={() => void onTabChange("video")}
        >
          Video Ads
        </button>
        <button
          id="url-to-ad-tab"
          type="button"
          role="tab"
          aria-selected={activeTab === "url"}
          aria-controls="url-to-ad-panel"
          className={activeTab === "url" ? "active" : ""}
          onClick={() => void onTabChange("url")}
        >
          URL to Ad
        </button>
      </div>

      {activeTab === "video" && (
        <fieldset
          className="setup-fieldset"
          disabled={
            !session.connected || session.runStarted || session.controlsBusy
          }
        >
          <legend>Next run setup</legend>
          <div className="setup-fields">
          <label>
            Reference images (optional)
            <input
              ref={referenceInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                updateReferenceImages(files);
              }}
            />
          </label>
        </div>
        <div className="selected-image">
          <span>Reference images: </span>
          {referenceImages.length ? (
            <span className="reference-file-list">
              {referenceImages.map((file, index) => (
                <span
                  className="reference-file"
                  key={`${file.name}-${file.lastModified}-${index}`}
                >
                  {file.name}
                  <button
                    className="remove-reference"
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() =>
                      updateReferenceImages(
                        referenceImages.filter((_, fileIndex) => fileIndex !== index),
                      )
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
              <button
                className="remove-all-references"
                type="button"
                onClick={() => updateReferenceImages([])}
              >
                Remove all
              </button>
            </span>
          ) : (
            "none (text-to-video)"
          )}
          {session.imageStatus ? ` · ${session.imageStatus}` : ""}
        </div>
        <label className="video-product-description">
          Product (name, color, material)
          <input
            type="text"
            value={manualProductDescription}
            onChange={(event) => setManualProductDescription(event.target.value)}
            placeholder={
              autoProductDescription ||
              (productDescriptionLoading ? "Inspecting reference image…" : "Optional product description")
            }
          />
          {productDescriptionUnavailable && (
            <span className="product-description-error">
              <small>{productDescriptionError || "Description unavailable, retry or type details."}</small>
              <button
                type="button"
                disabled={productDescriptionLoading}
                onClick={() => setDescriptionRetryCount((count) => count + 1)}
              >
                Retry description
              </button>
            </span>
          )}
        </label>
        <div className="video-shot-controls">
          <label>
            Framing
            <select
              value={framing}
              onChange={(event) => setFraming(event.target.value as keyof typeof framingPrompts)}
            >
              {Object.keys(framingPrompts).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Camera
            <select
              value={camera}
              onChange={(event) => setCamera(event.target.value as keyof typeof cameraPrompts)}
            >
              {Object.keys(cameraPrompts).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="frame-lock-toggle">
            <input
              type="checkbox"
              checked={keepProductInFrame}
              onChange={(event) => {
                setKeepProductInFrame(event.target.checked);
                if (!event.target.checked) setFrameRecoveryNotice("");
              }}
            />
            Keep product in frame
          </label>
        </div>
        {referenceImages.length === 2 && (
          <div className="image-relationship" role="group" aria-label="Image relationship">
            <span>These images show:</span>
            <div className="relationship-options">
              <button
                type="button"
                className={imageRelationship === "same-product" ? "active" : ""}
                aria-pressed={imageRelationship === "same-product"}
                onClick={() => setImageRelationship("same-product")}
              >
                Same product, different angles
              </button>
              <button
                type="button"
                className={imageRelationship === "separate-products" ? "active" : ""}
                aria-pressed={imageRelationship === "separate-products"}
                onClick={() => setImageRelationship("separate-products")}
              >
                Two separate products
              </button>
            </div>
            <small>Orbis accepts one starting frame; two images are combined before upload.</small>
          </div>
        )}
        </fieldset>
      )}

      {activeTab === "video" ? (
        <section
          id="video-ads-panel"
          role="tabpanel"
          aria-labelledby="video-ads-tab"
          className="mode-panel"
        >
          <div className="button-row mood-buttons">
            {Object.keys(moodPrompts).map((mood) => (
              <button
                key={mood}
                type="button"
                aria-pressed={activeMood === mood}
                className={activeMood === mood ? "active" : ""}
                disabled={session.controlsBusy}
                onClick={() => toggleMood(mood)}
              >
                {mood}
              </button>
            ))}
          </div>
        </section>
      ) : (
        <section
          id="url-to-ad-panel"
          role="tabpanel"
          aria-labelledby="url-to-ad-tab"
          className="mode-panel url-panel"
        >
          <label>
            Product URL
            <input
              type="url"
              placeholder="https://example.com/product"
              value={productUrl}
              onChange={(event) => {
                const value = event.target.value;
                setProductUrl(value);
                setProductExtraction(null);
                setProductLookupError("");
                setLookingUpProduct(isHttpUrl(value));
              }}
            />
          </label>
          <label>
            Additional details <span className="optional-label">Optional</span>
            <textarea
              className="details-input"
              placeholder="Features, audience, or visual direction"
              value={additionalDetails}
              onChange={(event) => setAdditionalDetails(event.target.value)}
            />
          </label>
          {productExtraction && (
            <div className="product-preview">
              <img src={productExtraction.preview} alt={productExtraction.title} />
              <div>
                <strong>{productExtraction.title}</strong>
                {productExtraction.description && <p>{productExtraction.description}</p>}
                <a href={productExtraction.finalUrl} target="_blank" rel="noreferrer">
                  Resolved product page
                </a>
              </div>
            </div>
          )}
          {lookingUpProduct && (
            <p className="product-lookup-status" aria-live="polite">
              Extracting product title and image…
            </p>
          )}
          {productLookupError && <p className="error">{productLookupError}</p>}
          {productLookupError && (
            <div className="manual-image-fallback">
              <label>
                Paste product image URL
                <input
                  type="url"
                  placeholder="https://example.com/product-image.jpg"
                  value={manualImageUrl}
                  onChange={(event) => setManualImageUrl(event.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={!isHttpUrl(manualImageUrl) || lookingUpProduct}
                onClick={() => void useManualImageUrl()}
              >
                Use image URL
              </button>
            </div>
          )}
        </section>
      )}

      {activeTab === "video" && (
        <label>
          Prompt
          <textarea
            value={videoPrompt}
            placeholder="Enter prompt here"
            onChange={(event) => setVideoPrompt(event.target.value)}
          />
        </label>
      )}

      <button
        className="generate-button"
        type="submit"
        disabled={generateDisabled}
        aria-describedby={generateDisabledReason ? "generate-status" : undefined}
      >
        Generate
      </button>
      <div
        className="button-row compact-controls"
        role="group"
        aria-label="Run controls"
      >
        <button
          type="button"
          title="Steer current run"
          disabled={
            !session.connected ||
            !session.runStarted ||
            session.controlsBusy ||
            !activePrompt.trim() ||
            (activeTab === "url" && !validProductUrl)
          }
          onClick={() => void session.steerWithPrompt(finalPrompt)}
        >
          Steer current run
        </button>
        <button
          className="compact-icon"
          type="button"
          aria-label="Pause"
          title="Pause"
          disabled={
            !session.connected ||
            !session.runStarted ||
            session.paused ||
            session.controlsBusy
          }
          onClick={session.pause}
        >
          Ⅱ
        </button>
        <button
          className="compact-icon"
          type="button"
          aria-label="Resume"
          title="Resume"
          disabled={
            !session.connected ||
            !session.runStarted ||
            !session.paused ||
            session.controlsBusy
          }
          onClick={session.resume}
        >
          ▶
        </button>
        <button
          className="compact-icon"
          type="button"
          aria-label="Reset"
          title="Reset"
          disabled={
            !session.connected || !session.runStarted || session.controlsBusy
          }
          onClick={session.reset}
        >
          ↻
        </button>
        <button
          className="compact-icon"
          type="button"
          aria-label={session.muted ? "Enable sound" : "Mute"}
          title={session.muted ? "Enable sound" : "Mute"}
          onClick={session.toggleMuted}
        >
          ◖))
        </button>
        {!session.connected ? (
          <button
            className="compact-icon"
            type="button"
            aria-label="Connect"
            title="Connect"
            disabled={session.controlsBusy}
            onClick={session.connectSession}
          >
            ⏻
          </button>
        ) : (
          <button
            className="compact-icon"
            type="button"
            aria-label="Disconnect"
            title="Disconnect"
            disabled={session.controlsBusy}
            onClick={session.disconnectSession}
          >
            ⏻
          </button>
        )}
        <select
          className="resolution-select"
          aria-label="Resolution for next run"
          title="Resolution for next run"
          value={session.resolution}
          disabled={session.runStarted || session.controlsBusy}
          onChange={(event) => session.setResolution(event.target.value)}
        >
          <option value="1080p">1080p</option>
          <option value="2k">2K</option>
          <option value="4k">4K</option>
        </select>
      </div>

      {activeTab === "video" ? (
        <div className="reference-debug-row">
          <p className="reference-debug" aria-live="polite">
            {videoGenerateDiagnostic
              ? `Mode: ${videoGenerateDiagnostic.mode} | Refs: ${videoGenerateDiagnostic.referenceCount} | Image: ${session.conditioningImagePreview ? `${session.conditioningImagePreview.name}, ${session.conditioningImagePreview.width}x${session.conditioningImagePreview.height}, ${(session.conditioningImagePreview.sizeBytes / 1024).toFixed(1)} KB` : videoGenerateDiagnostic.referenceCount ? `${referenceImages[0]?.name || "reference"}, preparing` : "none"} | Desc: ${videoGenerateDiagnostic.descriptionSource} | Prompt chars: ${videoGenerateDiagnostic.promptChars} | set_image: ${videoGenerateDiagnostic.imageCommandStatus} | Run id: ${videoGenerateDiagnostic.runId} | Frame lock: ${keepProductInFrame ? "on" : "off"} | Auto-restarts: ${autoRestartCount}`
              : `Mode: ${referenceImages.length ? "image-to-video" : "text-to-video"} | Refs: ${referenceImages.length} | Image: ${session.conditioningImagePreview ? `${session.conditioningImagePreview.name}, ${session.conditioningImagePreview.width}x${session.conditioningImagePreview.height}, ${(session.conditioningImagePreview.sizeBytes / 1024).toFixed(1)} KB` : "none"} | Desc: ${descriptionSource} | Prompt chars: ${finalPrompt.length} | set_image: not-sent | Run id: not generated | Frame lock: ${keepProductInFrame ? "on" : "off"} | Auto-restarts: ${autoRestartCount}`}
          </p>
          {session.conditioningImagePreview && (
            <img
              className="conditioning-image-preview"
              src={session.conditioningImagePreview.url}
              alt={`Processed image sent to Orbis: ${session.conditioningImagePreview.name}`}
              title={`${session.conditioningImagePreview.width}x${session.conditioningImagePreview.height}`}
            />
          )}
        </div>
      ) : (
        <p className="reference-debug" aria-live="polite">
          {generateDebug || `Mode: url-to-ad | Refs: ${Number(Boolean(productExtraction))} | Prompt chars: ${urlPrompt.length} | set_image sent: no | Run id: not generated`}
        </p>
      )}
      {activeTab === "video" && frameRecoveryNotice && (
        <p className="frame-recovery-notice" aria-live="polite">
          {frameRecoveryNotice}
        </p>
      )}
      <RunArchiveCard
        activeTab={activeTab}
        archive={archive}
        isRecording={isRecording}
        canGenerateAgain={!generateDisabled && !session.runStarted}
        onGenerateAgain={() => formRef.current?.requestSubmit()}
      />
      <details className="final-prompt">
        <summary>Final prompt</summary>
        <p>{finalPrompt || "Enter a prompt to preview the submitted text."}</p>
      </details>
      {generateDisabledReason && (
        <p className="control-hint" id="generate-status" aria-live="polite">
          {generateDisabledReason}
        </p>
      )}
      {session.error && <p className="error">{session.error}</p>}
      <aside>
        <strong>Recent model events</strong>
        <code>
          {session.events.length ? session.events.join(" · ") : "No events yet"}
        </code>
      </aside>
    </form>
  );
}
