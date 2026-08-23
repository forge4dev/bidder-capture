"use strict";

const DEFAULT_SETTINGS = {
  serverUrl: "http://localhost:3000",
  masterUserId: "",
  bidderPassword: ""
};

const STATUS_TTL_MS = 15000;
const ACTIVE_ICON_BACKGROUND = "#bfdbfe";
const ACTIVE_ICON_TEXT = "#111827";
const INACTIVE_ICON_BACKGROUND = "#6b7280";
const INACTIVE_ICON_TEXT = "#ffffff";

function normalizeServerUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function settingsFromStorage(items) {
  return {
    serverUrl: normalizeServerUrl(items.serverUrl || DEFAULT_SETTINGS.serverUrl),
    masterUserId: String(items.masterUserId || items.masterId || "").trim(),
    bidderPassword: String(items.bidderPassword || "")
  };
}

function getSettings() {
  return chrome.storage.sync.get(DEFAULT_SETTINGS).then(settingsFromStorage);
}

function downloadPayload(text) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;

  return chrome.downloads.download({
    url: dataUrl,
    filename: `application-manual-fields-${timestamp}.txt`,
    conflictAction: "uniquify",
    saveAs: false
  });
}

async function postJson(url, body) {
  let response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(`Failed to fetch ${url}. Check the server URL/IP, make sure the dashboard server is running and reachable publicly, and confirm Windows Firewall allows the port. Original error: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`Server responded with ${response.status}`);
  }

  return response.json().catch(() => ({ ok: true }));
}

function uploadBody(settings, payload) {
  return {
    master_user_id: settings.masterUserId,
    bidder_password: settings.bidderPassword,
    manual_fields: payload?.manual_fields || {}
  };
}

async function uploadCapture(payload) {
  const settings = await getSettings();
  if (!settings.serverUrl || !settings.masterUserId) {
    throw new Error("Dashboard server URL and Master User ID are required.");
  }

  return postJson(`${settings.serverUrl}/api/bidding-logs`, uploadBody(settings, payload));
}

async function testConnection() {
  const settings = await getSettings();
  if (!settings.serverUrl || !settings.masterUserId) {
    throw new Error("Dashboard server URL and Master User ID are required.");
  }

  return postJson(`${settings.serverUrl}/api/bidder/test-connection`, {
    master_user_id: settings.masterUserId,
    bidder_password: settings.bidderPassword
  });
}

function statusStorageKey(tabId) {
  return `captureStatus:${tabId}`;
}

function iconImageData(size, backgroundColor, textColor) {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d");
  const radius = Math.max(3, Math.round(size * 0.18));

  context.clearRect(0, 0, size, size);
  context.fillStyle = backgroundColor;
  context.beginPath();
  context.moveTo(radius, 0);
  context.lineTo(size - radius, 0);
  context.quadraticCurveTo(size, 0, size, radius);
  context.lineTo(size, size - radius);
  context.quadraticCurveTo(size, size, size - radius, size);
  context.lineTo(radius, size);
  context.quadraticCurveTo(0, size, 0, size - radius);
  context.lineTo(0, radius);
  context.quadraticCurveTo(0, 0, radius, 0);
  context.closePath();
  context.fill();

  context.fillStyle = textColor;
  context.font = `700 ${Math.round(size * 0.72)}px Arial, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("A", size / 2, size / 2 + size * 0.04);

  return context.getImageData(0, 0, size, size);
}

function actionIcon(active) {
  const backgroundColor = active ? ACTIVE_ICON_BACKGROUND : INACTIVE_ICON_BACKGROUND;
  const textColor = active ? ACTIVE_ICON_TEXT : INACTIVE_ICON_TEXT;
  return {
    16: iconImageData(16, backgroundColor, textColor),
    32: iconImageData(32, backgroundColor, textColor)
  };
}

function setActionActive(tabId, active) {
  if (!Number.isInteger(tabId)) return;

  chrome.action.setBadgeText({ tabId, text: "" });
  chrome.action.setIcon({ tabId, imageData: actionIcon(active) });
  chrome.action.setTitle({
    tabId,
    title: active
      ? "Application Manual Fields Capture is active on this page"
      : "Application Manual Fields Capture"
  });
}

function statusMessage(ok) {
  return ok ? "✓ Capture uploaded" : "✕ Capture upload failed";
}

async function storeCaptureStatus(tabId, ok) {
  if (!Number.isInteger(tabId)) return null;

  const status = {
    ok,
    message: statusMessage(ok),
    createdAt: Date.now()
  };

  await chrome.storage.session.set({ [statusStorageKey(tabId)]: status });
  return status;
}

async function latestCaptureStatus(tabId) {
  if (!Number.isInteger(tabId)) return null;

  const key = statusStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const status = stored[key];

  if (!status?.createdAt || Date.now() - status.createdAt > STATUS_TTL_MS) {
    await chrome.storage.session.remove(key);
    return null;
  }

  return status;
}

function notifyTabCaptureStatus(tabId, status) {
  if (!Number.isInteger(tabId) || !status) return;

  const message = {
    type: "capture-status-updated",
    status
  };

  chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
    if (chrome.runtime.lastError || !Array.isArray(frames) || !frames.length) {
      chrome.tabs.sendMessage(tabId, message, () => {
        void chrome.runtime.lastError;
      });
      return;
    }

    for (const frame of frames) {
      chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId }, () => {
        // Some frames may not have the content script due to host restrictions.
        void chrome.runtime.lastError;
      });
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "capture-page-status") {
    setActionActive(sender.tab?.id, Boolean(message.active));
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "test-dashboard-connection") {
    testConnection()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "get-latest-capture-status") {
    latestCaptureStatus(sender.tab?.id)
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "clear-latest-capture-status") {
    const tabId = sender.tab?.id;
    if (Number.isInteger(tabId)) {
      chrome.storage.session.remove(statusStorageKey(tabId));
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type !== "application-manual-fields-captured" || typeof message.text !== "string") {
    return false;
  }

  const tabId = sender.tab?.id;

  if (message.downloadOnly) {
    downloadPayload(message.text)
      .then(() => sendResponse({
        ok: true,
        uploaded: false,
        downloaded: true,
        message: "✓ Manual fields downloaded"
      }))
      .catch((error) => sendResponse({
        ok: false,
        uploaded: false,
        downloaded: false,
        error: error.message,
        message: "✕ Manual fields download failed"
      }));

    return true;
  }

  uploadCapture(message.payload)
    .then(async () => {
      const status = await storeCaptureStatus(tabId, true);
      notifyTabCaptureStatus(tabId, status);
      sendResponse({
        ok: true,
        uploaded: true,
        downloaded: false,
        message: status?.message || statusMessage(true)
      });
    })
    .catch((error) => {
      downloadPayload(message.text)
        .then(async () => {
          const status = await storeCaptureStatus(tabId, false);
          notifyTabCaptureStatus(tabId, status);
          sendResponse({
            ok: false,
            uploaded: false,
            downloaded: true,
            error: error.message,
            message: status?.message || statusMessage(false)
          });
        })
        .catch((downloadError) => {
          storeCaptureStatus(tabId, false).then((status) => {
            notifyTabCaptureStatus(tabId, status);
            sendResponse({
              ok: false,
              uploaded: false,
              downloaded: false,
              error: `${error.message}; fallback download failed: ${downloadError.message}`,
              message: status?.message || statusMessage(false)
            });
          }).catch(() => sendResponse({
            ok: false,
            uploaded: false,
            downloaded: false,
            error: `${error.message}; fallback download failed: ${downloadError.message}`,
            message: statusMessage(false)
          }));
        });
    });

  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setIcon({ imageData: actionIcon(false) });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setIcon({ imageData: actionIcon(false) });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    setActionActive(tabId, false);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(statusStorageKey(tabId));
});
