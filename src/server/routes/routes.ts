/**
 * API Route Definitions
 *
 * Maps HTTP methods + paths to handler functions.
 * Each handler lives in its own file under api/.
 */

import { Hono } from "hono";
import { getHealth } from "../api/health";
import { photoStream, transcriptionStream } from "../api/stream";
import { speak, stopAudio } from "../api/audio";
import { getThemePreference, setThemePreference } from "../api/storage";
import { getLatestPhoto, getPhotoData, getPhotoBase64 } from "../api/photo";
import {
  startLiveStream,
  stopLiveStream,
  liveStreamStatus,
} from "../api/livestream";
import { connectAI, disconnectAI, aiFrame, aiStream, setAIMode } from "../api/ai";
import { memoryCapture, memoryCaptureStream } from "../api/memory";

export const api = new Hono();

// Health
api.get("/health", getHealth);

// SSE streams
api.get("/photo-stream", photoStream);
api.get("/transcription-stream", transcriptionStream);
api.get("/livestream-status", liveStreamStatus);
api.get("/ai-stream", aiStream);

// Livestream control
api.post("/livestream/start", startLiveStream);
api.post("/livestream/stop", stopLiveStream);

// AI control
api.post("/ai/connect", connectAI);
api.post("/ai/disconnect", disconnectAI);
api.post("/ai/frame", aiFrame);
api.post("/ai/mode", setAIMode);

// Visual memory — server asks the webview to capture frames from the live
// WHEP <video> on demand, webview POSTs them back here.
api.get("/memory/capture-stream", memoryCaptureStream);
api.post("/memory/capture", memoryCapture);

// Audio
api.post("/speak", speak);
api.post("/stop-audio", stopAudio);

// Storage / preferences
api.get("/theme-preference", getThemePreference);
api.post("/theme-preference", setThemePreference);

// Photos
api.get("/latest-photo", getLatestPhoto);
api.get("/photo/:requestId", getPhotoData);
api.get("/photo-base64/:requestId", getPhotoBase64);
