import express from "express";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI, GenerateVideosOperation } from "@google/genai";
import { createServer as createViteServer } from "vite";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

let aiClient: GoogleGenAI | null = null;
function getAi(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not configured in the environment.");
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// Health check and environment verification
app.get("/api/health", (req, res) => {
  const hasKey = !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY";
  res.json({
    status: "ok",
    hasApiKey: hasKey,
    models: [
      { id: "veo-3.1-generate-preview", name: "Veo 3.1 High Quality", tier: "paid" },
      { id: "veo-3.1-lite-generate-preview", name: "Veo 3.1 Lite (Fast)", tier: "paid" },
    ],
  });
});

// Helper to format user prompt whether string or JSON
function parsePromptPayload(rawPrompt: string, enableSound: boolean): string {
  let promptText = rawPrompt.trim();

  // Check if string is JSON
  if (promptText.startsWith("{") && promptText.endsWith("}")) {
    try {
      const parsed = JSON.parse(promptText);
      const components: string[] = [];

      if (parsed.prompt) {
        components.push(parsed.prompt);
      } else if (parsed.description) {
        components.push(parsed.description);
      }

      if (parsed.style) components.push(`Style: ${parsed.style}`);
      if (parsed.camera) components.push(`Camera movement: ${parsed.camera}`);
      if (parsed.lighting) components.push(`Lighting: ${parsed.lighting}`);
      if (parsed.mood) components.push(`Mood: ${parsed.mood}`);
      if (parsed.action) components.push(`Action: ${parsed.action}`);
      if (parsed.audio || parsed.sound) components.push(`Audio details: ${parsed.audio || parsed.sound}`);
      if (parsed.negative_prompt) components.push(`Negative prompt: avoid ${parsed.negative_prompt}`);

      if (components.length > 0) {
        promptText = components.join(". ");
      }
    } catch {
      // If parsing fails, use as plain text
    }
  }

  if (enableSound && !promptText.toLowerCase().includes("sound") && !promptText.toLowerCase().includes("audio")) {
    promptText += ". With rich synchronized ambient sound effects and immersive environmental audio.";
  }

  return promptText;
}

// 1. POST /api/generate-video
app.post("/api/generate-video", async (req, res) => {
  try {
    const {
      prompt,
      model = "veo-3.1-generate-preview",
      aspectRatio = "16:9",
      resolution = "1080p",
      enableSound = true,
      image,
    } = req.body;

    if (!prompt && !image) {
      return res.status(400).json({ error: "Prompt or reference image is required." });
    }

    const ai = getAi();
    const finalPrompt = prompt ? parsePromptPayload(prompt, enableSound) : "";

    // Valid resolutions: '720p' or '1080p' (4k only supported in full veo without lite)
    const validResolution = resolution === "720p" ? "720p" : "1080p";
    // Valid aspect ratios: '16:9' or '9:16'
    const validAspectRatio = aspectRatio === "9:16" ? "9:16" : "16:9";

    const config: any = {
      numberOfVideos: 1,
      resolution: validResolution,
      aspectRatio: validAspectRatio,
    };

    const requestPayload: any = {
      model: model || "veo-3.1-generate-preview",
      config,
    };

    if (finalPrompt) {
      requestPayload.prompt = finalPrompt;
    }

    if (image && image.imageBytes) {
      // Strip potential data URL prefix if present
      let cleanBytes = image.imageBytes;
      let mimeType = image.mimeType || "image/png";

      if (cleanBytes.includes(";base64,")) {
        const parts = cleanBytes.split(";base64,");
        const mimeMatch = parts[0].match(/data:(.*?)$/);
        if (mimeMatch) mimeType = mimeMatch[1];
        cleanBytes = parts[1];
      }

      requestPayload.image = {
        imageBytes: cleanBytes,
        mimeType: mimeType,
      };
    }

    console.log(`Starting Veo video generation with model: ${requestPayload.model}, ratio: ${validAspectRatio}, res: ${validResolution}`);
    const operation = await ai.models.generateVideos(requestPayload);

    console.log(`Operation initiated: ${operation.name}`);
    res.json({
      success: true,
      operationName: operation.name,
      model: requestPayload.model,
      aspectRatio: validAspectRatio,
      resolution: validResolution,
      enableSound,
      processedPrompt: finalPrompt,
    });
  } catch (err: any) {
    console.error("Veo video generation error:", err);
    const errorMessage = err.message || "Failed to start video generation";
    const isPaidKeyIssue =
      errorMessage.includes("paid tier") ||
      errorMessage.includes("quota") ||
      errorMessage.includes("billing") ||
      errorMessage.includes("PERMISSION_DENIED") ||
      errorMessage.includes("Resource has been exhausted");

    res.status(500).json({
      error: errorMessage,
      isPaidKeyIssue,
    });
  }
});

// 2. POST /api/video-status
app.post("/api/video-status", async (req, res) => {
  try {
    const { operationName } = req.body;
    if (!operationName) {
      return res.status(400).json({ error: "operationName is required" });
    }

    const ai = getAi();
    const op = new GenerateVideosOperation();
    op.name = operationName;

    const updated = await ai.operations.getVideosOperation({ operation: op });

    res.json({
      done: Boolean(updated.done),
      error: updated.error ? updated.error.message || "Unknown operation error" : null,
      metadata: updated.metadata || null,
      hasVideo: Boolean(updated.response?.generatedVideos?.[0]?.video?.uri),
    });
  } catch (err: any) {
    console.error("Error polling video operation:", err);
    res.status(500).json({ error: err.message || "Failed to check video status" });
  }
});

// 3. POST /api/video-download
app.post("/api/video-download", async (req, res) => {
  try {
    const { operationName } = req.body;
    if (!operationName) {
      return res.status(400).json({ error: "operationName is required" });
    }

    const ai = getAi();
    const op = new GenerateVideosOperation();
    op.name = operationName;

    const updated = await ai.operations.getVideosOperation({ operation: op });
    if (!updated.done) {
      return res.status(202).json({ done: false, message: "Video is still processing" });
    }
    if (updated.error) {
      return res.status(500).json({ error: updated.error.message || "Video generation failed" });
    }

    const uri = updated.response?.generatedVideos?.[0]?.video?.uri;
    if (!uri) {
      return res.status(404).json({ error: "Video URI not found in operation response" });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    const videoRes = await fetch(uri, {
      headers: { "x-goog-api-key": apiKey! },
    });

    if (!videoRes.ok) {
      return res.status(videoRes.status).json({
        error: `Failed to fetch video stream from Google storage: ${videoRes.statusText}`,
      });
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'inline; filename="veo3-video.mp4"');

    const arrayBuffer = await videoRes.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err: any) {
    console.error("Error downloading video:", err);
    res.status(500).json({ error: err.message || "Failed to download video" });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Veo 3 Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
