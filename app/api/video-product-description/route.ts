import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const descriptionCache = new Map<string, string>();
const PRIMARY_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const MODEL_NAMES = [...new Set([PRIMARY_MODEL, "gemini-2.5-flash-lite"])];
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

async function requestDescription(
  model: string,
  apiKey: string,
  mimeType: string,
  imageData: string,
) {
  let response: Response | undefined;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
    }
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: "Describe only the visible product in this image in 25-40 words. State what it is, its color, material, finish, shape, and notable physical features when visible. Be factual and concise. No marketing language, scene directions, guesses, or instructions.",
                },
                { inline_data: { mime_type: mimeType, data: imageData } },
              ],
            },
          ],
        }),
        cache: "no-store",
      },
    );
    if (response.status !== 429 && response.status !== 503) break;
  }
  return response!;
}

export async function POST(request: Request) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const envName = geminiApiKey
    ? "GEMINI_API_KEY"
    : anthropicApiKey
      ? "ANTHROPIC_API_KEY"
      : "none";
  const apiKey = geminiApiKey || anthropicApiKey;
  console.info("[Video product description] Runtime key check", {
    envName,
    defined: Boolean(apiKey),
  });
  if (!apiKey) {
    return NextResponse.json(
      { error: "No vision API key is configured." },
      { status: 503 },
    );
  }

  const formData = await request.formData();
  const image = formData.get("image");
  if (
    !(image instanceof File) ||
    !["image/jpeg", "image/png", "image/webp"].includes(image.type)
  ) {
    return NextResponse.json({ error: "Choose a supported product image." }, { status: 400 });
  }
  if (image.size > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "The image must be 10 MB or smaller." }, { status: 413 });
  }

  const bytes = Buffer.from(await image.arrayBuffer());
  const cacheKey = createHash("sha256").update(bytes).digest("hex");
  const cachedDescription = descriptionCache.get(cacheKey);
  if (cachedDescription) return NextResponse.json({ description: cachedDescription });

  if (!geminiApiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is present, but this endpoint requires GEMINI_API_KEY." },
      { status: 503 },
    );
  }

  try {
    const imageData = bytes.toString("base64");
    let lastStatus = 502;
    for (const model of MODEL_NAMES) {
      let response: Response;
      try {
        response = await requestDescription(model, geminiApiKey, image.type, imageData);
      } catch (caught) {
        console.error(`[Video product description] ${model} request failed`, caught);
        continue;
      }
      lastStatus = response.status;
      const responseBody = await response.text();
      if (!response.ok) continue;

      let result: {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      try {
        result = JSON.parse(responseBody);
      } catch {
        continue;
      }
      const responseText = result.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join(" ");
      const words = (responseText || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
      if (words.length < 25) continue;

      const description = words.slice(0, 40).join(" ");
      if (descriptionCache.size >= 200) {
        descriptionCache.delete(descriptionCache.keys().next().value!);
      }
      descriptionCache.set(cacheKey, description);
      return NextResponse.json({ description });
    }
    return NextResponse.json(
      {
        error: lastStatus === 429 || lastStatus === 503
          ? "Gemini busy, retry or type details."
          : "Description unavailable, retry or type details.",
      },
      { status: 502 },
    );
  } catch (caught) {
    console.error("Video product description failed", caught);
    return NextResponse.json(
      { error: "Description unavailable, retry or type details." },
      { status: 502 },
    );
  }
}