(() => {
  "use strict";

  const STATUS_TTL_MS = 15000;
  let toastTimer = null;
  let pageStatusQueued = false;
  let lastReportedPageStatus = null;

  function cleanText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isTopFrame() {
    return window.top === window;
  }

  function hasVisibleWorkdayReview() {
    const hasReviewHeading = [...document.querySelectorAll("h1,h2,h3,[role='heading']")]
      .some((element) => cleanText(element.textContent).toLowerCase().includes("review"));
    const hasReviewContainer = [...document.querySelectorAll(".css-g7hkny")]
      .some((element) => cleanText(element.textContent));

    return hasReviewHeading && hasReviewContainer;
  }

  function isCapturePageActive() {
    try {
      const pageUrl = new URL(location.href);

      if (pageUrl.hostname === "jobs.ashbyhq.com") return true;
      if (pageUrl.hostname === "jobs.lever.co" && pageUrl.pathname.includes("/apply")) return true;
      if (pageUrl.hostname === "jobs.jobvite.com" && pageUrl.pathname.includes("/apply")) return true;
      if (pageUrl.hostname === "ats.rippling.com" && pageUrl.pathname.includes("/jobs/") && pageUrl.pathname.includes("/apply")) return true;
      if (pageUrl.hostname.endsWith(".recruitee.com") && document.querySelector("form#offer-application-form")) return true;
      if (pageUrl.hostname.endsWith(".bamboohr.com") && pageUrl.pathname.includes("/careers")) return true;
      if (document.querySelector("form#job-applicant-form")) return true;
      if (pageUrl.hostname.endsWith(".gusto.com") || pageUrl.hostname.endsWith(".gusto.io")) return true;
      if (document.querySelector("form#form_submit_new_resume, [id^='resumator-']")) return true;
      if (pageUrl.hostname === "applytojob.com" || pageUrl.hostname.endsWith(".applytojob.com")) return true;
      if (pageUrl.hostname.endsWith("greenhouse.io")) return true;
      if (pageUrl.hostname.endsWith(".myworkdayjobs.com") && pageUrl.pathname.includes("/apply")) {
        return hasVisibleWorkdayReview();
      }
    } catch {
      return false;
    }

    return false;
  }

  function reportCapturePageStatus() {
    const active = isCapturePageActive();
    if (active === lastReportedPageStatus) return;

    lastReportedPageStatus = active;
    chrome.runtime.sendMessage({
      type: "capture-page-status",
      active
    }, () => {
      void chrome.runtime.lastError;
    });
  }

  function queueCapturePageStatusReport() {
    if (pageStatusQueued) return;
    pageStatusQueued = true;

    setTimeout(() => {
      pageStatusQueued = false;
      reportCapturePageStatus();
    }, 150);
  }

  function forwardStatusToTop(status) {
    if (isTopFrame()) return false;

    try {
      window.top.postMessage({
        source: "application-manual-fields-status",
        status
      }, "*");
      return true;
    } catch {
      return false;
    }
  }

  function showCaptureStatusToast(ok, message) {
    if (!isTopFrame()) return;

    const existing = document.getElementById("application-manual-fields-status-toast");
    if (existing) existing.remove();
    clearTimeout(toastTimer);

    const toast = document.createElement("div");
    toast.id = "application-manual-fields-status-toast";
    toast.textContent = message || (ok ? "✓ Capture uploaded" : "✕ Capture upload failed");
    toast.style.cssText = [
      "position: fixed",
      "top: 16px",
      "right: 16px",
      "z-index: 2147483647",
      "padding: 10px 14px",
      "border-radius: 999px",
      "font: 600 14px Arial, sans-serif",
      "box-shadow: 0 8px 24px rgba(0,0,0,0.18)",
      `background: ${ok ? "#067647" : "#b42318"}`,
      "color: white"
    ].join(";");

    document.documentElement.appendChild(toast);
    toastTimer = setTimeout(() => toast.remove(), 5000);
  }

  function showRecentStoredStatus() {
    chrome.runtime.sendMessage({ type: "get-latest-capture-status" }, (response) => {
      if (chrome.runtime.lastError || !response?.status) return;

      const status = response.status;
      if (!status.createdAt || Date.now() - status.createdAt > STATUS_TTL_MS) return;

      if (!forwardStatusToTop(status)) {
        showCaptureStatusToast(Boolean(status.ok), status.message);
      }
      chrome.runtime.sendMessage({ type: "clear-latest-capture-status" });
    });
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.source !== "application-manual-fields-payload"
    ) {
      return;
    }

    const text = typeof event.data.payload === "string"
      ? event.data.payload
      : JSON.stringify(event.data.payload, null, 2);

    chrome.runtime.sendMessage({
      type: "application-manual-fields-captured",
      payload: event.data.payload,
      text,
      downloadOnly: Boolean(event.data.downloadOnly)
    }, (response) => {
      if (chrome.runtime.lastError) return;
      const status = {
        ok: Boolean(response?.ok),
        message: response?.message
      };
      if (!forwardStatusToTop(status)) {
        showCaptureStatusToast(status.ok, status.message);
      }
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "capture-status-updated") return;
    if (!forwardStatusToTop(message.status)) {
      showCaptureStatusToast(Boolean(message.status?.ok), message.status?.message);
    }
  });

  window.addEventListener("message", (event) => {
    if (
      event.data?.source !== "application-manual-fields-status" ||
      !event.data?.status ||
      !isTopFrame()
    ) {
      return;
    }

    showCaptureStatusToast(Boolean(event.data.status.ok), event.data.status.message);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      showRecentStoredStatus();
      queueCapturePageStatusReport();
    }, { once: true });
  } else {
    showRecentStoredStatus();
    queueCapturePageStatusReport();
  }

  new MutationObserver(queueCapturePageStatusReport).observe(document.documentElement || document, {
    childList: true,
    subtree: true
  });
})();
