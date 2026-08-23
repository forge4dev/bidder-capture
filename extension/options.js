"use strict";

const DEFAULT_SETTINGS = {
  serverUrl: "http://localhost:3000",
  masterUserId: "",
  bidderPassword: ""
};

const serverUrl = document.getElementById("serverUrl");
const masterUserId = document.getElementById("masterUserId");
const bidderPassword = document.getElementById("bidderPassword");
const status = document.getElementById("status");

function setStatus(message, ok) {
  status.textContent = message;
  status.className = ok ? "success" : "failure";
}

function formSettings() {
  return {
    serverUrl: serverUrl.value.trim().replace(/\/+$/, ""),
    masterUserId: masterUserId.value.trim(),
    bidderPassword: bidderPassword.value
  };
}

async function saveSettings() {
  await chrome.storage.sync.set(formSettings());
}

chrome.storage.sync.get(DEFAULT_SETTINGS).then((items) => {
  serverUrl.value = items.serverUrl || DEFAULT_SETTINGS.serverUrl;
  masterUserId.value = items.masterUserId || items.masterId || "";
  bidderPassword.value = items.bidderPassword || "";
});

document.getElementById("save").addEventListener("click", async () => {
  await saveSettings();
  setStatus("Saved", true);
});

document.getElementById("test").addEventListener("click", async () => {
  await saveSettings();
  setStatus("Testing...", true);

  chrome.runtime.sendMessage({ type: "test-dashboard-connection" }, (response) => {
    if (response?.ok) {
      setStatus("Success", true);
    } else {
      setStatus(`Failure${response?.error ? `: ${response.error}` : ""}`, false);
    }
  });
});
