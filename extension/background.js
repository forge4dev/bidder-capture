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
const DEFAULT_CAPTURE_IP_ADDRESS = "127.0.0.1";
const IP_LOOKUP_URLS = [
  "https://api.ipify.org?format=json",
  "https://icanhazip.com/"
];

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

function proxySettingsGet(details) {
  return new Promise((resolve) => {
    if (!chrome.proxy?.settings?.get) {
      resolve(null);
      return;
    }

    chrome.proxy.settings.get(details, (settings) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(settings || null);
    });
  });
}

function proxyLooksConfigured(settings) {
  if (!settings) return false;

  const levelOfControl = String(settings.levelOfControl || "");
  const value = settings.value || {};
  const mode = String(value.mode || "").toLowerCase();

  if (levelOfControl === "controlled_by_other_extensions") return true;
  if (["fixed_servers", "pac_script", "auto_detect"].includes(mode)) return true;

  return false;
}

function extractIpAddressFromText(text) {
  const value = String(text || "").trim();
  if (!value) return "";

  try {
    const parsed = JSON.parse(value);
    const candidate = parsed.ip || parsed.query || parsed.address;
    if (candidate) return String(candidate).trim();
  } catch {
    // Some endpoints return plain text.
  }

  const ipv4 = value.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (ipv4) return ipv4[0];

  const ipv6 = value.match(/\b(?:[a-f0-9]{0,4}:){2,}[a-f0-9]{0,4}\b/i);
  return ipv6 ? ipv6[0] : "";
}

async function fetchEffectiveIpAddress() {
  for (const url of IP_LOOKUP_URLS) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "omit"
      });
      if (!response.ok) continue;

      const ipAddress = extractIpAddressFromText(await response.text());
      if (ipAddress) return ipAddress;
    } catch {
      // Try the next endpoint.
    }
  }

  return "";
}

async function resolveApplicationIpAddress() {
  const proxySettings = await proxySettingsGet({ incognito: false });
  if (!proxyLooksConfigured(proxySettings)) {
    return DEFAULT_CAPTURE_IP_ADDRESS;
  }

  return await fetchEffectiveIpAddress() || DEFAULT_CAPTURE_IP_ADDRESS;
}

async function enrichPayloadWithCaptureIp(payload) {
  const enrichedPayload = payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...payload }
    : {};

  const manualFields = enrichedPayload.manual_fields &&
    typeof enrichedPayload.manual_fields === "object" &&
    !Array.isArray(enrichedPayload.manual_fields)
    ? { ...enrichedPayload.manual_fields }
    : {};

  manualFields.ip_address = await resolveApplicationIpAddress();
  enrichedPayload.manual_fields = manualFields;

  return enrichedPayload;
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
    enrichPayloadWithCaptureIp(message.payload)
      .then((payload) => downloadPayload(JSON.stringify(payload, null, 2)))
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

  enrichPayloadWithCaptureIp(message.payload)
    .then((payload) => uploadCapture(payload)
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
        downloadPayload(JSON.stringify(payload, null, 2))
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
      }))
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
        .catch((downloadError) => sendResponse({
          ok: false,
          uploaded: false,
          downloaded: false,
          error: `${error.message}; fallback download failed: ${downloadError.message}`,
          message: statusMessage(false)
        }));
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
