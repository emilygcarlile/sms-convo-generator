import { Muxer, ArrayBufferTarget } from "https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/+esm";

const VIEWPORT = { width: 540, height: 960 };
const FPS = 30;

const previewCanvas = document.getElementById("previewCanvas");
const previewCtx = previewCanvas.getContext("2d");

const conversationFileInput = document.getElementById("conversationFile");
const mascotImageInput = document.getElementById("mascotImage");
const senderNameInput = document.getElementById("senderName");
const speedSlider = document.getElementById("speedSlider");

const conversationFileChip = document.getElementById("conversationFileChip");
const mascotChip = document.getElementById("mascotChip");
const speedValueEl = document.getElementById("speedValue");
const messageProgressEl = document.getElementById("messageProgress");
const setupStatusEl = document.getElementById("setupStatus");
const recordStatusEl = document.getElementById("recordStatus");

const resetBtn = document.getElementById("resetBtn");
const playBtn = document.getElementById("playBtn");
const recordBtn = document.getElementById("recordBtn");

let chatbotAvatar = null;
let messages = [];
let rawScriptText = "";
let playbackClock = 0;
let playbackState = "idle";
let playbackRaf = null;
let previousFrameTs = 0;

const CHAT_VIEW = {
  top: 132,
  bottom: VIEWPORT.height - 74,
  sidePad: 20,
};
const META_ROW_HEIGHT = 44;

const BUBBLE_STYLE = {
  maxWidthRatio: 0.8,
  defaultFontSize: 20,
  minFontSize: 11,
  xPad: 18,
  yPad: 14,
  spacing: 12,
};

// Keeps important UI away from side edges when videos are placed in external phone frames (e.g., Canva).
const FRAME_SAFE_SIDE_INSET = 0;

function setRecordStatus(message, isError = false) {
  recordStatusEl.textContent = message;
  recordStatusEl.style.color = isError ? "#b91c1c" : "#1d4ed8";
}

function setSetupStatus(message, isError = false) {
  setupStatusEl.textContent = message;
  setupStatusEl.style.color = isError ? "#9f1239" : "#0d665f";
  setupStatusEl.style.background = isError ? "#fbe9ee" : "#e8f6f4";
}

function getSenderName() {
  return senderNameInput.value.trim() || "Campus Bot";
}

function getSecondsPerMessage() {
  return Number(speedSlider.value);
}

function getSpeedMultiplier() {
  return 3 / getSecondsPerMessage();
}

function normalizeMessageText(text, options = {}) {
  const preserveSpacing = Boolean(options.preserveSpacing);
  let normalized = text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n");

  // Put numbered options on their own lines, but do not flatten existing paragraph breaks.
  normalized = normalized.replace(/[ \t]*(\[\d+\])[ \t]*/g, "$1 ");
  normalized = normalized.replace(/([^\n])(\[\d+\]\s)/g, "$1\n$2");

  if (preserveSpacing) {
    // Preserve source spacing; only prevent extreme runs from blowing up bubble height.
    normalized = normalized.replace(/\n{4,}/g, "\n\n\n");
  } else {
    // Compact mode for tighter bubbles.
    normalized = normalized.replace(/\n{3,}/g, "\n\n").replace(/\n/g, " ");
    normalized = normalized.replace(/\s{2,}/g, " ");
    // Keep numbered choices readable in compact mode.
    normalized = normalized.replace(/([^\n])(\[\d+\]\s)/g, "$1\n$2");
  }

  return normalized.trim();
}

function parseScript(rawText, options = {}) {
  const preserveSpacing = Boolean(options.preserveSpacing);
  const lines = rawText.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");

  if (!lines.some((line) => line.trim().length > 0)) {
    throw new Error("Conversation file is empty.");
  }

  const senderKey = getSenderName().toLowerCase().replace(/\s+/g, "");
  const parsedMessages = [];
  const isStudentLabel = (label) =>
    ["student", "user", "human", "learner", "prospect"].includes(label);
  const isBotLabel = (label) =>
    ["bot", "chatbot", "mascot", "assistant", "school", "sender"].includes(label) || label === senderKey;

  let pendingBlankLines = 0;
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      pendingBlankLines += 1;
      return;
    }

    const parsed = trimmed.match(/^([^:]+)\s*:\s*(.+)$/);
    if (!parsed) {
      if (parsedMessages.length === 0) {
        throw new Error(`Line ${idx + 1} is invalid. Use \"student:\" or \"bot:\".`);
      }

      const spacer =
        preserveSpacing && pendingBlankLines > 0 ? "\n".repeat(Math.min(2, pendingBlankLines + 1)) : "\n";
      // Allow multiline content that continues the previous speaker.
      parsedMessages[parsedMessages.length - 1].text += `${spacer}${trimmed}`;
      pendingBlankLines = 0;
      return;
    }

    const rawRole = parsed[1].trim().toLowerCase().replace(/\s+/g, "");
    let role = "";
    if (isStudentLabel(rawRole)) {
      role = "student";
    } else if (isBotLabel(rawRole)) {
      role = "bot";
    } else {
      if (parsedMessages.length === 0) {
        throw new Error(
          `Line ${idx + 1} has unsupported speaker \"${parsed[1].trim()}\". Use student or bot labels.`,
        );
      }
      // If the label is unknown (e.g. URL like http:), treat as message continuation.
      const spacer =
        preserveSpacing && pendingBlankLines > 0 ? "\n".repeat(Math.min(2, pendingBlankLines + 1)) : "\n";
      parsedMessages[parsedMessages.length - 1].text += `${spacer}${trimmed}`;
      pendingBlankLines = 0;
      return;
    }

    parsedMessages.push({
      role,
      text: parsed[2].trim(),
    });
    pendingBlankLines = 0;
  });

  parsedMessages.forEach((message) => {
    message.text = normalizeMessageText(message.text, { preserveSpacing });
  });

  return parsedMessages;
}

function computeTimeline(sourceMessages, secondsPerMessage = 3) {
  let t = 0.7;
  const variationPattern = [-0.08, 0.04, -0.03, 0.06, -0.02];

  return sourceMessages.map((message, index) => {
    const textLength = message.text.length;
    const isBot = message.role === "bot";

    // Keep a tight cadence while still giving slightly more time to complex replies.
    const baseCadence = secondsPerMessage * 0.34;
    const readingFactor = Math.min(1.35, textLength * 0.006);
    const roleAdjust = isBot ? 0.08 : -0.06;
    const simpleBotBoost = isBot && textLength < 40 ? -0.18 : 0;
    const complexBotPenalty = isBot && textLength > 180 ? 0.25 : 0;
    const variation = variationPattern[index % variationPattern.length];
    const cadence = Math.max(0.65, Math.min(2.35, baseCadence + readingFactor + roleAdjust + simpleBotBoost + complexBotPenalty + variation));

    const typingBase = isBot ? 0.38 : 0.3;
    const typingDuration = Math.max(0.28, Math.min(1.15, typingBase + textLength * 0.0016));
    const typingStartAt = t;
    const revealAt = typingStartAt + typingDuration;

    t = revealAt + cadence;

    return {
      ...message,
      revealAt,
      typingStartAt,
      typingDuration,
      popDuration: 0.28,
    };
  });
}

function getTimeline() {
  return computeTimeline(messages, getSecondsPerMessage());
}

function getTotalDurationSec(timeline) {
  if (timeline.length === 0) return 2;
  return timeline[timeline.length - 1].revealAt + 1.8;
}

function splitLongToken(ctx, token, maxWidth) {
  if (ctx.measureText(token).width <= maxWidth) return [token];
  const parts = [];
  let current = "";
  for (const char of token) {
    const next = current + char;
    if (ctx.measureText(next).width > maxWidth && current) {
      parts.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  const paragraphs = text.split("\n");

  paragraphs.forEach((paragraph, paragraphIdx) => {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      // Keep intentional blank lines compact (single line-height only).
      if (paragraphIdx < paragraphs.length - 1) {
        lines.push("");
      }
      return;
    }

    let current = "";
    words.forEach((word) => {
      const segments = splitLongToken(ctx, word, maxWidth);
      segments.forEach((segment) => {
        const candidate = current ? `${current} ${segment}` : segment;
        if (ctx.measureText(candidate).width > maxWidth && current) {
          lines.push(current);
          current = segment;
        } else {
          current = candidate;
        }
      });
    });
    if (current) lines.push(current);
    // Preserve explicit newlines without adding extra blank spacing.
  });

  return lines.length > 0 ? lines : [""];
}

function getMessageLayout(ctx, text) {
  const maxBubbleWidth = VIEWPORT.width * BUBBLE_STYLE.maxWidthRatio;
  const availableHeight = CHAT_VIEW.bottom - (CHAT_VIEW.top + META_ROW_HEIGHT) - 10;
  let fontSize = BUBBLE_STYLE.defaultFontSize;
  let lineHeight = 22;
  let lines = [];
  let width = 0;
  let height = 0;

  while (fontSize >= BUBBLE_STYLE.minFontSize) {
    lineHeight = Math.round(fontSize * 1.12);
    ctx.font = `${fontSize}px 'Avenir Next', sans-serif`;
    lines = wrapLines(ctx, text, maxBubbleWidth - BUBBLE_STYLE.xPad * 2);
    const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width), 0);
    width = Math.min(maxBubbleWidth, textWidth + BUBBLE_STYLE.xPad * 2);
    height = lines.length * lineHeight + BUBBLE_STYLE.yPad * 2;
    if (height <= availableHeight || fontSize === BUBBLE_STYLE.minFontSize) {
      break;
    }
    fontSize -= 1;
  }

  return { lines, width, height, fontSize, lineHeight };
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTopSystemBar(ctx) {
  ctx.fillStyle = "#f4f4f6";
  ctx.fillRect(0, 0, VIEWPORT.width, 38);

  // Dynamic Island
  roundedRect(ctx, VIEWPORT.width / 2 - 66, 6, 132, 28, 14);
  ctx.fillStyle = "#0b0b0c";
  ctx.fill();
}

function drawHeader(ctx, senderName, avatar) {
  const top = 38;
  ctx.fillStyle = "#f4f4f6";
  ctx.fillRect(0, top, VIEWPORT.width, 94);
  ctx.strokeStyle = "#d5d6da";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, top + 94);
  ctx.lineTo(VIEWPORT.width, top + 94);
  ctx.stroke();

  const avatarX = VIEWPORT.width / 2;
  const avatarY = top + 31;

  // Back chevron
  ctx.strokeStyle = "#0a84ff";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(26, top + 40);
  ctx.lineTo(40, top + 28);
  ctx.moveTo(26, top + 40);
  ctx.lineTo(40, top + 52);
  ctx.stroke();

  if (avatar) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX, avatarY, 21, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(avatar, avatarX - 21, avatarY - 21, 42, 42);
    ctx.restore();
  } else {
    ctx.fillStyle = "#cdd2da";
    ctx.beginPath();
    ctx.arc(avatarX, avatarY, 21, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = "#171717";
  ctx.font = "600 15px 'Avenir Next', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(senderName, VIEWPORT.width / 2, top + 74);
  ctx.fillStyle = "#9a9aa0";
  ctx.font = "600 13px 'Avenir Next', sans-serif";
  ctx.fillText("›", VIEWPORT.width / 2 + Math.min(70, ctx.measureText(senderName).width / 2 + 8), top + 74);
  ctx.textAlign = "start";
}

function drawBottomInputBar(ctx) {
  const h = 64;
  const y = VIEWPORT.height - h;
  ctx.fillStyle = "#f4f4f6";
  ctx.fillRect(0, y, VIEWPORT.width, h);

  const plusCx = 30;
  const plusCy = y + 30;
  const plusR = 13;
  const inputX = plusCx + plusR + 10;
  const inputW = VIEWPORT.width - inputX - 18;

  roundedRect(ctx, inputX, y + 10, inputW, 40, 20);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#dadce2";
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#c5c8d0";
  ctx.font = "500 17px 'Avenir Next', sans-serif";
  ctx.fillText("Text Message • SMS", inputX + 18, y + 36);

  ctx.beginPath();
  ctx.arc(plusCx, plusCy, plusR, 0, Math.PI * 2);
  ctx.fillStyle = "#e7e8ec";
  ctx.fill();
  ctx.fillStyle = "#989cab";
  ctx.font = "500 24px 'Avenir Next', sans-serif";
  ctx.fillText("+", plusCx - 6, y + 38);
}

function drawBubble(ctx, message, y, progress) {
  const isBot = message.role === "bot";
  const layout = getMessageLayout(ctx, message.text);
  const x = isBot ? CHAT_VIEW.sidePad : VIEWPORT.width - layout.width - CHAT_VIEW.sidePad;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, progress));
  const s = 0.95 + Math.min(1, progress) * 0.05;
  ctx.translate(x + layout.width / 2, y + layout.height / 2);
  ctx.scale(s, s);
  ctx.translate(-(x + layout.width / 2), -(y + layout.height / 2));

  roundedRect(ctx, x, y, layout.width, layout.height, 20);
  ctx.fillStyle = isBot ? "#e6e7eb" : "#33c759";
  ctx.fill();

  ctx.fillStyle = isBot ? "#1a1a1a" : "#ffffff";
  ctx.font = `${layout.fontSize}px 'Avenir Next', sans-serif`;
  layout.lines.forEach((line, i) => {
    ctx.fillText(line, x + BUBBLE_STYLE.xPad, y + BUBBLE_STYLE.yPad + layout.lineHeight + i * layout.lineHeight);
  });
  ctx.restore();

  return layout.height;
}

function drawTypingIndicator(ctx, role, y, progress = 1) {
  const isBot = role === "bot";
  const width = 64;
  const height = 40;
  const x = isBot ? CHAT_VIEW.sidePad : VIEWPORT.width - width - CHAT_VIEW.sidePad;

  ctx.save();
  ctx.globalAlpha = Math.max(0.2, Math.min(1, progress));
  roundedRect(ctx, x, y, width, height, 20);
  ctx.fillStyle = isBot ? "#eceef2" : "#2ca79d";
  ctx.fill();

  const dotColor = isBot ? "#9aa4b3" : "#ddf8f5";
  ctx.fillStyle = dotColor;
  const baseX = x + 20;
  const pulse = Math.sin(progress * Math.PI * 4) * 1.2;
  for (let i = 0; i < 3; i += 1) {
    ctx.beginPath();
    ctx.arc(baseX + i * 12, y + 20 + pulse * (i === 1 ? 1 : -0.4), 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  return height;
}

function drawPhoneNotch(ctx) {
  roundedRect(ctx, VIEWPORT.width / 2 - 66, 6, 132, 28, 14);
  ctx.fillStyle = "#0b0b0c";
  ctx.fill();
}

function drawDeviceShell(ctx) {
  const shell = {
    x: 16,
    y: 8,
    w: VIEWPORT.width - 32,
    h: VIEWPORT.height - 16,
    r: 60,
  };

  // Outer body
  roundedRect(ctx, shell.x, shell.y, shell.w, shell.h, shell.r);
  ctx.fillStyle = "#0f1116";
  ctx.fill();

  // Subtle metallic edge
  roundedRect(ctx, shell.x + 2, shell.y + 2, shell.w - 4, shell.h - 4, shell.r - 2);
  ctx.strokeStyle = "#2d313c";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Side buttons
  const btnW = 4;
  roundedRect(ctx, shell.x - 2, shell.y + 205, btnW, 52, 2);
  ctx.fillStyle = "#303542";
  ctx.fill();
  roundedRect(ctx, shell.x - 2, shell.y + 272, btnW, 82, 2);
  ctx.fill();
  roundedRect(ctx, shell.x + shell.w - 2, shell.y + 246, btnW, 92, 2);
  ctx.fill();

  const screen = {
    x: shell.x + 12,
    y: shell.y + 12,
    w: shell.w - 24,
    h: shell.h - 24,
    r: 48,
  };

  return screen;
}

function renderConversation(ctx, timeline, senderName, avatar, timeSec) {
  const sx = ctx.canvas.width / VIEWPORT.width;
  const sy = ctx.canvas.height / VIEWPORT.height;

  ctx.save();
  ctx.scale(sx, sy);
  ctx.clearRect(0, 0, VIEWPORT.width, VIEWPORT.height);
  ctx.fillStyle = "#e7ebf2";
  ctx.fillRect(0, 0, VIEWPORT.width, VIEWPORT.height);

  const screen = drawDeviceShell(ctx);
  ctx.save();
  roundedRect(ctx, screen.x, screen.y, screen.w, screen.h, screen.r);
  ctx.clip();
  ctx.translate(screen.x, screen.y);
  ctx.scale(screen.w / VIEWPORT.width, screen.h / VIEWPORT.height);
  ctx.translate(FRAME_SAFE_SIDE_INSET, 0);
  ctx.scale((VIEWPORT.width - FRAME_SAFE_SIDE_INSET * 2) / VIEWPORT.width, 1);

  ctx.fillStyle = "#ededf0";
  ctx.fillRect(0, 0, VIEWPORT.width, VIEWPORT.height);
  drawPhoneNotch(ctx);
  drawTopSystemBar(ctx);
  drawHeader(ctx, senderName, avatar);

  const items = [];
  for (let i = 0; i < timeline.length; i += 1) {
    const msg = timeline[i];
    if (timeSec >= msg.revealAt) {
      items.push({ kind: "message", message: msg, progress: (timeSec - msg.revealAt) / msg.popDuration });
      continue;
    }
    if (timeSec >= msg.typingStartAt && timeSec < msg.revealAt) {
      const typingProgress = (timeSec - msg.typingStartAt) / msg.typingDuration;
      items.push({ kind: "typing", role: msg.role, progress: typingProgress });
      break;
    }
    break;
  }

  const measured = items.map((item) => {
    if (item.kind === "typing") return { ...item, height: 40 };
    return { ...item, height: getMessageLayout(ctx, item.message.text).height };
  });

  const contentHeight = measured.reduce((sum, item, idx) => {
    const spacer = idx < measured.length - 1 ? BUBBLE_STYLE.spacing : 0;
    return sum + item.height + spacer;
  }, 0);

  const chatContentTop = CHAT_VIEW.top + META_ROW_HEIGHT;
  const chatHeight = CHAT_VIEW.bottom - chatContentTop;
  const scrollOffset = Math.max(0, contentHeight - chatHeight);
  let y = chatContentTop - scrollOffset;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, chatContentTop, VIEWPORT.width, chatHeight);
  ctx.clip();

  measured.forEach((item) => {
    if (item.kind === "typing") {
      drawTypingIndicator(ctx, item.role, y, item.progress);
    } else {
      drawBubble(ctx, item.message, y, item.progress);
    }
    y += item.height + BUBBLE_STYLE.spacing;
  });
  ctx.restore();

  drawBottomInputBar(ctx);
  ctx.restore();
  ctx.restore();
}

function countVisibleMessages(timeline, timeSec) {
  return timeline.filter((item) => timeSec >= item.revealAt).length;
}

function renderCurrentFrame() {
  const timeline = getTimeline();
  renderConversation(previewCtx, timeline, getSenderName(), chatbotAvatar, playbackClock);

  const visible = countVisibleMessages(timeline, playbackClock);
  messageProgressEl.textContent = `Message ${visible} of ${timeline.length}`;
}

function stopPlayback() {
  if (playbackRaf) cancelAnimationFrame(playbackRaf);
  playbackRaf = null;
  playbackState = "idle";
  playBtn.textContent = "Play";
}

function playbackTick(ts) {
  if (playbackState !== "playing") return;

  const delta = Math.min(0.05, (ts - previousFrameTs) / 1000 || 0);
  previousFrameTs = ts;
  playbackClock += delta * getSpeedMultiplier();

  const timeline = getTimeline();
  const end = getTotalDurationSec(timeline);
  if (playbackClock >= end) {
    playbackClock = end;
    renderCurrentFrame();
    stopPlayback();
    return;
  }

  renderCurrentFrame();
  playbackRaf = requestAnimationFrame(playbackTick);
}

function startPlayback() {
  if (messages.length === 0) {
    setRecordStatus("Upload a conversation file first.", true);
    return;
  }

  if (playbackState === "playing") {
    stopPlayback();
    return;
  }

  playbackState = "playing";
  playBtn.textContent = "Pause";
  previousFrameTs = performance.now();
  playbackRaf = requestAnimationFrame(playbackTick);
}

function resetPlayback() {
  stopPlayback();
  playbackClock = 0;
  renderCurrentFrame();
  setRecordStatus("Playback reset.");
}

async function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Unable to read conversation file."));
    reader.readAsText(file);
  });
}

async function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Unable to load mascot image."));
      img.src = String(reader.result);
    };
    reader.onerror = () => reject(new Error("Unable to read mascot image."));
    reader.readAsDataURL(file);
  });
}

function updateSetupReadiness() {
  const hasMessages = messages.length > 0;
  const hasAvatar = Boolean(chatbotAvatar);

  if (hasMessages && hasAvatar) {
    setSetupStatus("Conversation loaded - use the preview to play and record.");
  } else if (hasMessages) {
    setSetupStatus("Conversation loaded. Upload mascot image for best realism.");
  } else {
    setSetupStatus("Add a script and mascot image to continue.");
  }
}

function rebuildMessagesFromRaw() {
  if (!rawScriptText) return true;
  try {
    messages = parseScript(rawScriptText, { preserveSpacing: true });
    return true;
  } catch (error) {
    messages = [];
    messageProgressEl.textContent = "Message 0 of 0";
    setRecordStatus(error.message, true);
    return false;
  }
}

async function pickCodec(width, height) {
  const codecs = ["avc1.4d002a", "avc1.42E01E", "avc1.42001f"];
  for (const codec of codecs) {
    const config = {
      codec,
      width,
      height,
      bitrate: 10_000_000,
      framerate: FPS,
      avc: { format: "avc" },
    };
    const support = await VideoEncoder.isConfigSupported(config);
    if (support.supported) return config;
  }

  throw new Error("No supported H.264 codec found in this browser.");
}

async function exportMp4() {
  if (!("VideoEncoder" in window)) {
    throw new Error("This browser does not support WebCodecs. Try Chrome or Edge.");
  }

  const timeline = getTimeline();
  const width = 1080;
  const height = 1920;

  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const ctx = offscreen.getContext("2d");

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    fastStart: "in-memory",
    video: {
      codec: "avc",
      width,
      height,
    },
  });

  const codecConfig = await pickCodec(width, height);
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      throw e;
    },
  });
  encoder.configure(codecConfig);

  const totalDuration = getTotalDurationSec(timeline);
  const totalFrames = Math.ceil(totalDuration * FPS);

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    const t = frameIndex / FPS;
    renderConversation(ctx, timeline, getSenderName(), chatbotAvatar, t);

    const frame = new VideoFrame(offscreen, {
      timestamp: Math.round((frameIndex / FPS) * 1_000_000),
    });

    encoder.encode(frame, { keyFrame: frameIndex % FPS === 0 });
    frame.close();

    if (frameIndex % Math.ceil(FPS * 1.5) === 0) {
      const pct = Math.round((frameIndex / totalFrames) * 100);
      setRecordStatus(`Rendering video... ${pct}%`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  await encoder.flush();
  encoder.close();
  muxer.finalize();

  const blob = new Blob([muxer.target.buffer], { type: "video/mp4" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${getSenderName().replace(/\s+/g, "-").toLowerCase()}-conversation.mp4`;
  anchor.click();
  URL.revokeObjectURL(url);
}

conversationFileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const text = await readTextFile(file);
    rawScriptText = text;
    if (!rebuildMessagesFromRaw()) return;
    conversationFileChip.classList.remove("empty");
    conversationFileChip.textContent = `📄 ${file.name}`;
    resetPlayback();
    updateSetupReadiness();
    setRecordStatus(`Loaded ${messages.length} messages.`);
  } catch (error) {
    messages = [];
    rawScriptText = "";
    conversationFileChip.classList.add("empty");
    conversationFileChip.textContent = "No file uploaded";
    messageProgressEl.textContent = "Message 0 of 0";
    setRecordStatus(error.message, true);
    updateSetupReadiness();
  }
});

mascotImageInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    chatbotAvatar = await loadImage(file);
    mascotChip.classList.remove("empty");
    mascotChip.innerHTML = `<img src="${chatbotAvatar.src}" alt="Mascot" /><span>${file.name}</span>`;
    renderCurrentFrame();
    updateSetupReadiness();
  } catch (error) {
    chatbotAvatar = null;
    mascotChip.classList.add("empty");
    mascotChip.textContent = "No mascot uploaded";
    setRecordStatus(error.message, true);
    updateSetupReadiness();
  }
});

senderNameInput.addEventListener("input", () => {
  if (rawScriptText) {
    rebuildMessagesFromRaw();
  }
  renderCurrentFrame();
});

speedSlider.addEventListener("input", () => {
  speedValueEl.textContent = `${Number(speedSlider.value).toFixed(1)}s`;
  renderCurrentFrame();
});

playBtn.addEventListener("click", () => {
  startPlayback();
});

resetBtn.addEventListener("click", () => {
  resetPlayback();
});

recordBtn.addEventListener("click", async () => {
  if (messages.length === 0) {
    setRecordStatus("Upload a conversation file first.", true);
    return;
  }

  try {
    stopPlayback();
    playBtn.disabled = true;
    resetBtn.disabled = true;
    recordBtn.disabled = true;
    setRecordStatus("Preparing MP4 export...");
    await exportMp4();
    setRecordStatus("MP4 ready and downloaded.");
  } catch (error) {
    setRecordStatus(error.message || "Export failed.", true);
  } finally {
    playBtn.disabled = false;
    resetBtn.disabled = false;
    recordBtn.disabled = false;
  }
});

function drawEmptyPreview() {
  const timeline = [];
  renderConversation(previewCtx, timeline, getSenderName(), chatbotAvatar, 0);
}

speedValueEl.textContent = `${Number(speedSlider.value).toFixed(1)}s`;
updateSetupReadiness();
drawEmptyPreview();
