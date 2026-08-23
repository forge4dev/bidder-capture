(() => {
  "use strict";

  const MESSAGE_TYPE = "application-manual-fields-payload";
  const EXTENSION_VERSION = "1.0.1";
  const EXTENSION_BUILD_TIMESTAMP = "8/5, 6:00am PT";
  const GREENHOUSE_EMBED_URL = /^https:\/\/(?:boards|job-boards)\.greenhouse\.io\/embed(?:\/|\?|$)/;
  const LEVER_APPLY_URL = /^https:\/\/jobs\.lever\.co\/.*\/apply(?:[/?#].*)?$/;
  const GUSTO_APPLICANTS_URL = /\/postings\/[^/?#]+\/applicants(?:[/?#].*)?$/;
  const BLOCK_REAL_APPLICATION_SUBMIT = false;
  const SCHOOL_LIST_MARKER = "University";
  const DEGREE_LIST_MARKER = "Degree";
  const MANUAL_CONTROL_SELECTOR = [
    "input:not([type='hidden'])",
    "textarea",
    "select",
    "[contenteditable='true']",
    "[role='combobox']"
  ].join(",");
  const schoolTextById = new Map();
  const degreeTextById = new Map();
  const manualFieldCache = new Map();
  let scanQueued = false;
  let dataScanQueued = false;
  let windowDataScanned = false;
  let lastManualSubmitCaptureAt = 0;
  let pendingAshbyCaptureTimer = null;
  let pendingLeverCaptureTimer = null;
  let pendingWorkdayCaptureTimer = null;
  let pendingApplyToJobCaptureTimer = null;
  let pendingJobviteCaptureTimer = null;
  let pendingBambooHrCaptureTimer = null;
  let pendingRipplingCaptureTimer = null;
  let pendingRecruiteeCaptureTimer = null;
  let lastNetworkCaptureKey = "";
  let lastNetworkCaptureAt = 0;
  let manualCaptureButtonQueued = false;

  function matchingPlatform(url) {
    try {
      const parsedUrl = new URL(url, location.href);
      const href = parsedUrl.href;
      if (GREENHOUSE_EMBED_URL.test(href)) return "greenhouse";
      if (parsedUrl.hostname === "jobs.lever.co" && parsedUrl.pathname.includes("/apply")) {
        return "lever";
      }
      if (parsedUrl.hostname === "jobs.jobvite.com" && parsedUrl.pathname.includes("/apply")) {
        return "jobvite";
      }
      if (isRipplingApplyUrl(parsedUrl)) return "rippling";
      if (isBambooHrCareersUrl(parsedUrl)) return "bamboohr";
      if (LEVER_APPLY_URL.test(href)) return "lever";
      if (
        (parsedUrl.hostname.endsWith(".gusto.com") || parsedUrl.hostname.endsWith(".gusto.io")) &&
        GUSTO_APPLICANTS_URL.test(parsedUrl.pathname)
      ) {
        return "gusto";
      }
      if (isApplyToJobHost(parsedUrl)) return "applytojob";
    } catch {
      return null;
    }

    return null;
  }

  function pagePlatform() {
    try {
      const pageUrl = new URL(location.href);
      if (pageUrl.hostname === "jobs.ashbyhq.com") return "ashby";
      if (pageUrl.hostname === "jobs.lever.co" && pageUrl.pathname.includes("/apply")) return "lever";
      if (pageUrl.hostname === "jobs.jobvite.com" && pageUrl.pathname.includes("/apply")) return "jobvite";
      if (isRipplingApplyUrl(pageUrl)) return "rippling";
      if (isRecruiteeApplyPage()) return "recruitee";
      if (isBambooHrCareersUrl(pageUrl)) return "bamboohr";
      if (document.querySelector("form#job-applicant-form")) return "gusto";
      if (pageUrl.hostname.endsWith(".gusto.com") || pageUrl.hostname.endsWith(".gusto.io")) return "gusto";
      if (applyToJobApplicationForm()) return "applytojob";
      if (isApplyToJobHost(pageUrl)) return "applytojob";
      if (isWorkdayApplyUrl(pageUrl)) return "workday";
      if (pageUrl.hostname.endsWith("greenhouse.io")) return "greenhouse";
    } catch {
      return null;
    }

    return null;
  }

  function platformForUrl(url) {
    try {
      const parsedUrl = new URL(url, location.href);
      if (isWorkdayApplyUrl(parsedUrl)) return "workday";
    } catch {
      // Fall through to the network-captured platforms.
    }

    return matchingPlatform(url) || "unknown";
  }

  function isMatchingUrl(url) {
    return Boolean(matchingPlatform(url));
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function textFromSelector(selector) {
    const element = document.querySelector(selector);
    return cleanText(element?.textContent);
  }

  function textFromFirstMatchingElement(selector, predicate) {
    for (const element of document.querySelectorAll(selector)) {
      if (!predicate || predicate(element)) {
        const text = cleanText(element.textContent);
        if (text) return text;
      }
    }

    return "";
  }

  function isWorkdayApplyUrl(url) {
    const parsedUrl = url instanceof URL ? url : new URL(url, location.href);
    return parsedUrl.hostname.endsWith(".myworkdayjobs.com") &&
      parsedUrl.pathname.includes("/apply");
  }

  function gustoHeaderSpans() {
    const heading = document.querySelector("h1");
    if (!heading) return [];

    return [...heading.querySelectorAll("span")]
      .map((element) => cleanText(element.textContent))
      .filter(Boolean);
  }

  function gustoHeaderCompanyName() {
    const spans = gustoHeaderSpans();
    return spans[0] || "";
  }

  function gustoHeaderJobTitle() {
    const spans = gustoHeaderSpans();
    if (spans.length >= 2) return spans[1];

    const heading = document.querySelector("h1");
    const directText = cleanText(heading?.childNodes
      ? [...heading.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(" ")
      : "");
    return directText;
  }

  function gustoPostingSlugParts(url) {
    try {
      const parsedUrl = new URL(url || location.href, location.href);
      const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
      const postingsIndex = pathParts.findIndex((part) => part.toLowerCase() === "postings");
      const rawSlug = postingsIndex >= 0 ? cleanText(pathParts[postingsIndex + 1]) : "";
      if (!rawSlug) return null;

      const slug = decodeURIComponent(rawSlug)
        .replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "");
      const firstDash = slug.indexOf("-");
      if (firstDash <= 0 || firstDash >= slug.length - 1) return null;

      return {
        companyName: slug.slice(0, firstDash),
        jobTitle: slug.slice(firstDash + 1)
      };
    } catch {
      return null;
    }
  }

  function isApplyToJobHost(url) {
    const parsedUrl = url instanceof URL ? url : new URL(url, location.href);
    return parsedUrl.hostname === "applytojob.com" ||
      parsedUrl.hostname.endsWith(".applytojob.com");
  }

  function isBambooHrCareersUrl(url) {
    const parsedUrl = url instanceof URL ? url : new URL(url, location.href);
    return parsedUrl.hostname.endsWith(".bamboohr.com") &&
      parsedUrl.pathname.includes("/careers");
  }

  function isRipplingApplyUrl(url) {
    const parsedUrl = url instanceof URL ? url : new URL(url, location.href);
    return parsedUrl.hostname === "ats.rippling.com" &&
      parsedUrl.pathname.includes("/jobs/") &&
      parsedUrl.pathname.includes("/apply");
  }

  function isRecruiteeUrl(url) {
    const parsedUrl = url instanceof URL ? url : new URL(url, location.href);
    return parsedUrl.hostname.endsWith(".recruitee.com");
  }

  function recruiteeApplicationForm() {
    return document.querySelector("form#offer-application-form");
  }

  function isRecruiteeApplyPage() {
    try {
      return isRecruiteeUrl(new URL(location.href)) && Boolean(recruiteeApplicationForm());
    } catch {
      return false;
    }
  }

  function recruiteeJobTitleFromUrl(url) {
    try {
      const parsedUrl = new URL(url || location.href, location.href);
      const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
      const offerIndex = pathParts.findIndex((part) => part.toLowerCase() === "o");
      return offerIndex >= 0 && pathParts[offerIndex + 1]
        ? cleanText(decodeURIComponent(pathParts[offerIndex + 1]))
        : "";
    } catch {
      return "";
    }
  }

  function ripplingCompanyNameFromUrl(url) {
    try {
      const parsedUrl = new URL(url || location.href, location.href);
      return cleanText(parsedUrl.searchParams.get("jobBoardSlug")) ||
        cleanText(parsedUrl.pathname.split("/").filter(Boolean)[0]);
    } catch {
      return "";
    }
  }

  function ripplingJobTitleFromHeading() {
    for (const heading of document.querySelectorAll("h1,h2,h3,h4,h5,[role='heading']")) {
      const text = cleanText(heading.textContent);
      if (!/^application\s*:?\s*/i.test(text)) continue;

      const title = cleanText(text.replace(/^application\s*:?\s*/i, ""));
      if (title) return title;
    }

    return "";
  }

  function companyNameForPlatform(url, platform) {
    try {
      const parsedUrl = new URL(url || location.href, location.href);

      if (platform === "workday") {
        return cleanText(parsedUrl.hostname.split(".")[0]);
      }

      if (platform === "greenhouse") {
        return cleanText(parsedUrl.searchParams.get("for"));
      }

      if (platform === "lever" || platform === "ashby" || platform === "jobvite") {
        return cleanText(parsedUrl.pathname.split("/").filter(Boolean)[0]);
      }

      if (platform === "bamboohr") {
        return cleanText(parsedUrl.hostname.split(".")[0]);
      }

      if (platform === "recruitee") {
        return cleanText(parsedUrl.hostname.split(".")[0]);
      }

      if (platform === "rippling") {
        return ripplingCompanyNameFromUrl(parsedUrl);
      }

      if (platform === "gusto") {
        return gustoPostingSlugParts(parsedUrl)?.companyName ||
          gustoHeaderCompanyName() ||
          cleanText(parsedUrl.hostname.split(".")[0]);
      }

      if (platform === "applytojob") {
        const firstHostPart = cleanText(parsedUrl.hostname.split(".")[0]);
        return firstHostPart === "www" || firstHostPart === "applytojob" ? "" : firstHostPart;
      }
    } catch {
      return "";
    }

    return "";
  }

  function jobTitleForPlatform(platform) {
    if (platform === "workday") {
      return textFromSelector('h2[data-automation-id="jobTitleHeading"]');
    }

    if (platform === "greenhouse") {
      return textFromFirstMatchingElement("h1", (element) => {
        return cleanText(element.getAttribute?.("class")).includes("section-header");
      });
    }

    if (platform === "lever") {
      const postingHeader = textFromFirstMatchingElement("div", (element) => {
        return cleanText(element.getAttribute?.("class")).includes("posting-header");
      });
      const headerElement = [...document.querySelectorAll("div")]
        .find((element) => cleanText(element.getAttribute?.("class")).includes("posting-header"));
      const title = cleanText(headerElement?.querySelector?.("h2")?.textContent);
      return title || postingHeader;
    }

    if (platform === "jobvite") {
      const heading = textFromSelector("h2.jv-header") ||
        textFromFirstMatchingElement("h2", (element) => {
          return cleanText(element.getAttribute?.("class")).includes("jv-header");
        }) ||
        textFromSelector("h1") ||
        textFromSelector("h2");
      return /^apply$/i.test(heading) ? "" : heading;
    }

    if (platform === "bamboohr") {
      return textFromSelector('h3[data-fabric-component="HeadLine"]') ||
        textFromFirstMatchingElement("h3", (element) => {
          return cleanText(element.getAttribute?.("data-fabric-component")).toLowerCase() === "headline";
        }) ||
        textFromSelector("h1") ||
        textFromSelector("h2") ||
        textFromSelector("h3");
    }

    if (platform === "rippling") {
      return ripplingJobTitleFromHeading();
    }

    if (platform === "recruitee") {
      return recruiteeJobTitleFromUrl(location.href) ||
        textFromSelector("[data-cy='offer-title']") ||
        textFromSelector("h1") ||
        textFromSelector("h2");
    }

    if (platform === "ashby") {
      return textFromFirstMatchingElement("h1", (element) => {
        return cleanText(element.getAttribute?.("class")).includes("ashby-job-posting-heading");
      });
    }

    if (platform === "gusto") {
      return gustoPostingSlugParts(location.href)?.jobTitle ||
        gustoHeaderJobTitle() ||
        textFromSelector("h2") ||
        textFromSelector("h1");
    }

    if (platform === "applytojob") {
      try {
        const pageUrl = new URL(location.href);
        const pathParts = pageUrl.pathname.split("/").filter(Boolean);
        const applyIndex = pathParts.findIndex((part) => part.toLowerCase() === "apply");
        const titleFromUrl = applyIndex >= 0 && pathParts[applyIndex + 2]
          ? decodeURIComponent(pathParts[applyIndex + 2])
          : "";
        if (titleFromUrl) return cleanText(titleFromUrl);
      } catch {
        // Fall back to visible headings below.
      }

      return textFromSelector("h1") || textFromSelector("h2") || textFromSelector(".job-title");
    }

    return "";
  }

  function addBidMetadata(manualFields, url, platform) {
    const companyName = companyNameForPlatform(url, platform) || companyNameForPlatform(location.href, platform);
    const jobTitle = jobTitleForPlatform(platform);

    if (companyName) manualFields.company_name = companyName;
    if (jobTitle) manualFields.job_title = jobTitle;
  }

  function labelToKey(value) {
    return cleanText(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\*/g, "")
      .replace(/\s*\(required\)$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function isInternalIdValue(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      cleanText(value)
    );
  }

  function hasInternalIdValue(value) {
    const values = Array.isArray(value) ? value : [value];
    return values.some((item) => isInternalIdValue(item));
  }

  function isUsefulText(text, submittedId) {
    const value = cleanText(text);
    return value && value !== submittedId && value.toLowerCase() !== "select";
  }

  function textFromElement(element, submittedId) {
    if (!element) return null;

    const values = [
      element instanceof HTMLOptionElement ? element.text : null,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      element.getAttribute?.("data-label"),
      element.getAttribute?.("data-name"),
      element.getAttribute?.("data-text"),
      element.textContent
    ];

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      values.unshift(element.value);
    }

    for (const value of values) {
      if (isUsefulText(value, submittedId)) {
        return cleanText(value);
      }
    }

    return null;
  }

  function usefulRecordText(value, id) {
    const text = cleanText(value);
    if (isUsefulText(text, id)) return text;
    return null;
  }

  function valueFromElement(element) {
    if (!element) return null;

    const values = [
      element instanceof HTMLOptionElement ? element.value : null,
      element.getAttribute?.("value"),
      element.getAttribute?.("data-value"),
      element.getAttribute?.("data-id"),
      element.getAttribute?.("data-option-id"),
      element.id
    ];

    for (const value of values) {
      const text = cleanText(value);
      if (text) return text;
    }

    return null;
  }

  function idFromRecord(record) {
    if (!record || typeof record !== "object") return null;

    const values = [
      record.id,
      record.value,
      record.key,
      record.option_id,
      record.optionId,
      record.school_name_id,
      record.degree_id
    ];

    for (const value of values) {
      const id = cleanText(value);
      if (id) return id;
    }

    return null;
  }

  function textFromRecord(record, id) {
    if (Array.isArray(record)) {
      for (const value of record) {
        const text = usefulRecordText(value, id);
        if (text) return text;
      }

      return null;
    }

    if (!record || typeof record !== "object") return null;

    const values = [
      record.name,
      record.label,
      record.text,
      record.title,
      record.display_name,
      record.displayName,
      record.school_name,
      record.degree
    ];

    for (const value of values) {
      const text = usefulRecordText(value, id);
      if (text) return text;
    }

    return null;
  }

  function optionFromDataArray(record) {
    const normalized = record.map((value) => cleanText(value));
    const numericIdIndex = normalized.findIndex((value) => /^\d{5,}$/.test(value));
    const idIndex = numericIdIndex >= 0 ? numericIdIndex : 0;
    const id = normalized[idIndex];

    if (!id) return null;

    for (const [index, value] of normalized.entries()) {
      if (index === idIndex) continue;

      const text = usefulRecordText(value, id);
      if (text) return { id, text };
    }

    return null;
  }

  function optionFromDataRecord(record) {
    if (Array.isArray(record)) {
      return optionFromDataArray(record);
    }

    const id = idFromRecord(record);
    const text = textFromRecord(record, id);
    return id && text ? { id, text } : null;
  }

  function queryValueCandidates(submittedId, root = document) {
    if (!submittedId || typeof CSS === "undefined" || !CSS.escape) return [];

    const id = CSS.escape(submittedId);
    return [
      ...root.querySelectorAll(
        [
          `option[value='${id}']`,
          `[id='${id}']`,
          `[data-value='${id}']`,
          `[data-id='${id}']`,
          `[data-option-id='${id}']`,
          `[aria-activedescendant='${id}']`
        ].join(",")
      )
    ];
  }

  function findOptionText(submittedId, root = document) {
    for (const element of queryValueCandidates(submittedId, root)) {
      const text = textFromElement(element, submittedId);
      if (text) return text;
    }

    return null;
  }

  function getOptionElements(root) {
    if (root instanceof HTMLSelectElement) {
      return [...root.options];
    }

    return [
      ...root.querySelectorAll(
        "option, [role='option'], li, [data-value], [data-id], [data-option-id]"
      )
    ];
  }

  function findOptionLists() {
    const roots = new Set(
      document.querySelectorAll("select, [role='listbox'], [role='menu'], ul, ol")
    );

    for (const option of document.querySelectorAll("option, [role='option']")) {
      const root = option.closest("select, [role='listbox'], [role='menu'], ul, ol");
      if (root) {
        roots.add(root);
      }
    }

    return [...roots];
  }

  function listContainsOptionText(root, text) {
    const target = text.toLowerCase();

    return getOptionElements(root).some((option) => {
      const optionText = cleanText(
        option instanceof HTMLOptionElement
          ? option.text
          : option.textContent || option.getAttribute("aria-label")
      ).toLowerCase();

      return optionText.includes(target);
    });
  }

  function cacheListOptions(root, cache) {
    for (const option of getOptionElements(root)) {
      const id = valueFromElement(option);
      const text = textFromElement(option, id);

      if (id && text) {
        cache.set(id, text);
      }
    }
  }

  function cacheClassifiedOptions(options) {
    const normalized = options.filter(Boolean);
    const containsSchoolMarker = normalized.some((option) =>
      option.text.toLowerCase().includes(SCHOOL_LIST_MARKER.toLowerCase())
    );
    const containsDegreeMarker = normalized.some((option) =>
      option.text.toLowerCase().includes(DEGREE_LIST_MARKER.toLowerCase())
    );

    if (containsSchoolMarker) {
      for (const option of normalized) {
        schoolTextById.set(option.id, option.text);
      }
    }

    if (containsDegreeMarker) {
      for (const option of normalized) {
        degreeTextById.set(option.id, option.text);
      }
    }
  }

  function cacheOptionData(value, seen = new WeakSet(), depth = 0, budget = { count: 0 }) {
    if (value == null || depth > 8 || budget.count > 20000) return;

    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    budget.count += 1;

    if (Array.isArray(value)) {
      const options = value.map(optionFromDataRecord).filter(Boolean);
      if (options.length >= 2) {
        cacheClassifiedOptions(options);
      }

      for (const item of value) {
        cacheOptionData(item, seen, depth + 1, budget);
      }
      return;
    }

    for (const item of Object.values(value)) {
      cacheOptionData(item, seen, depth + 1, budget);
    }
  }

  function parseAndCacheOptionData(text) {
    if (typeof text !== "string") return;
    if (!text.includes(SCHOOL_LIST_MARKER) && !text.includes(DEGREE_LIST_MARKER)) return;

    try {
      cacheOptionData(JSON.parse(text));
      return;
    } catch {
      // Some Greenhouse pages keep option data inside inline scripts instead of pure JSON.
    }

    const objectPattern = /\{[^{}]*(?:"id"|"value")[^{}]*(?:"name"|"label"|"text"|"title"|"display_name"|"displayName")[^{}]*\}/g;
    const matches = text.match(objectPattern) || [];
    const options = [];

    for (const match of matches.slice(0, 5000)) {
      try {
        const option = optionFromDataRecord(JSON.parse(match));
        if (option) options.push(option);
      } catch {
        // Ignore partial JavaScript object literals that are not valid JSON.
      }
    }

    if (options.length >= 2) {
      cacheClassifiedOptions(options);
    }
  }

  function scanScriptOptionData() {
    for (const script of document.scripts) {
      if (script.src) continue;
      parseAndCacheOptionData(script.textContent);
    }
  }

  function scanWindowOptionData() {
    if (windowDataScanned) return;
    windowDataScanned = true;

    const candidates = [
      "__NEXT_DATA__",
      "__INITIAL_STATE__",
      "__PRELOADED_STATE__",
      "gon",
      "Greenhouse",
      "greenhouse",
      "JobBoard",
      "jobBoard"
    ];

    for (const key of candidates) {
      try {
        cacheOptionData(window[key]);
      } catch {
        // Cross-origin or protected properties can throw; skip them.
      }
    }
  }

  function queueDataScan() {
    if (dataScanQueued) return;

    dataScanQueued = true;
    window.requestAnimationFrame(() => {
      dataScanQueued = false;
      scanScriptOptionData();
      scanWindowOptionData();
    });
  }

  function scanClassifiedLists() {
    for (const list of findOptionLists()) {
      if (listContainsOptionText(list, SCHOOL_LIST_MARKER)) {
        cacheListOptions(list, schoolTextById);
      }

      if (listContainsOptionText(list, DEGREE_LIST_MARKER)) {
        cacheListOptions(list, degreeTextById);
      }
    }
  }

  function queueClassifiedListScan() {
    if (scanQueued) return;

    scanQueued = true;
    window.requestAnimationFrame(() => {
      scanQueued = false;
      scanClassifiedLists();
    });
  }

  function findTextInClassifiedList(submittedId, classifierText) {
    if (!submittedId) return null;

    scanScriptOptionData();
    scanWindowOptionData();
    scanClassifiedLists();

    const cache = classifierText === SCHOOL_LIST_MARKER
      ? schoolTextById
      : degreeTextById;
    const cachedText = cache.get(String(submittedId));
    if (cachedText) return cachedText;

    for (const list of findOptionLists()) {
      if (!listContainsOptionText(list, classifierText)) continue;

      const text = findOptionText(submittedId, list);
      if (text) return text;
    }

    return null;
  }

  function findLinkedInAnswer(payload) {
    const answers = payload?.job_application?.answers_attributes;
    if (!answers || typeof answers !== "object") return null;

    for (const answer of Object.values(answers)) {
      if (!answer || typeof answer !== "object") continue;

      const textValue = cleanText(answer.text_value);
      if (/linkedin\.com/i.test(textValue)) {
        return textValue;
      }
    }

    return null;
  }

  function isPlaceholderValue(value) {
    const text = cleanText(value).toLowerCase();
    return (
      !text ||
      text === "select" ||
      text === "select..." ||
      text === "choose" ||
      text === "choose..." ||
      text === "please select"
    );
  }

  function isIgnoredManualFieldKey(key) {
    return [
      "captcha",
      "recaptcha",
      "g_recaptcha",
      "hcaptcha",
      "h_captcha",
      "turnstile",
      "cf_turnstile"
    ].some((marker) => key.includes(marker));
  }

  function isSecurityControl(control) {
    if (!control) return false;

    const metadata = [
      control.getAttribute?.("name"),
      control.id,
      control.className,
      control.getAttribute?.("aria-label"),
      control.getAttribute?.("data-sitekey"),
      control.closest?.("[data-sitekey]")?.getAttribute?.("data-sitekey")
    ].map((value) => cleanText(value).toLowerCase()).join(" ");

    return /captcha|recaptcha|hcaptcha|h-captcha|turnstile|cf-turnstile/.test(metadata);
  }

  function filenameFromUploadText(value) {
    const text = cleanText(value);
    if (!text) return "";

    const fullFilename = text.match(/([^\\/\n\r]+?\.(?:docx|doc|pdf|txt|rtf|odt|pages))(?=\s*(?:$|,|;|\(|\b(?:successfully uploaded|remove|delete|replace|click|drag|upload)\b))/i);
    if (fullFilename) return cleanText(fullFilename[1]);

    const candidates = text
      .replace(/\bsuccessfully uploaded\b/gi, ",")
      .split(/[,;\n\r]+/)
      .map(cleanText)
      .filter(Boolean);

    for (const candidate of candidates) {
      const match = candidate.match(/([^\\/\n\r]+?\.(?:docx|doc|pdf|txt|rtf|odt|pages))$/i);
      if (match) return cleanText(match[1]);
    }

    const fallback = text.match(/([^\\/\n\r]+?\.(?:docx|doc|pdf|txt|rtf|odt|pages))(?![a-z0-9])/i);
    return fallback ? cleanText(fallback[1]) : text;
  }

  function isFilenameValue(value) {
    return /[^\\/\n\r]+?\.(?:docx|doc|pdf|txt|rtf|odt|pages)(?![a-z0-9])/i.test(cleanText(value));
  }

  function filenameFromFileInputValue(value) {
    const text = cleanText(value);
    if (!text) return "";

    const fileName = text.split(/[\\/]/).pop();
    return filenameFromUploadText(fileName || text);
  }

  function shouldNormalizeFileFieldKey(key) {
    return /resume|resume_cv|cv|cover_letter|file|upload|attachment/.test(key);
  }

  function isPlausibleLabel(value) {
    const text = cleanText(value);
    if (!text || isPlaceholderValue(text)) return false;
    if (text.length > 180) return false;
    if (text.split(/\s+/).length > 24) return false;

    const key = labelToKey(text);
    const compositeSignals = [
      "first_name",
      "last_name",
      "email",
      "phone",
      "resume_cv",
      "cover_letter",
      "school",
      "degree",
      "discipline",
      "linkedin_profile",
      "website"
    ].filter((signal) => key.includes(signal));
    if (compositeSignals.length > 2) return false;

    return true;
  }

  function isManualControl(control) {
    if (!control?.matches?.(MANUAL_CONTROL_SELECTOR)) return false;
    if (isSecurityControl(control)) return false;

    if (control instanceof HTMLInputElement) {
      return ![
        "button",
        "hidden",
        "image",
        "password",
        "reset",
        "submit"
      ].includes(control.type);
    }

    return true;
  }

  function associatedLabelText(control) {
    if (!control) return null;

    const labels = control.labels ? [...control.labels] : [];
    const forLabel = control.id
      ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)
      : null;
    if (forLabel) labels.unshift(forLabel);

    const wrapperLabel = control.closest("label");
    if (wrapperLabel) labels.unshift(wrapperLabel);

    for (const label of labels) {
      const text = cleanText(label.textContent);
      if (isPlausibleLabel(text)) return text;
    }

    return null;
  }

  function metadataLabelText(control) {
    const values = [
      control.getAttribute?.("aria-label"),
      control.getAttribute?.("data-label"),
      control.getAttribute?.("placeholder"),
      control.getAttribute?.("name"),
      control.id
    ];

    for (const value of values) {
      const text = cleanText(value);
      if (isPlausibleLabel(text)) return text;
    }

    return null;
  }

  function textWithoutControls(root) {
    if (!root) return null;

    const clone = root.cloneNode(true);
    clone
      .querySelectorAll("input, textarea, select, button, option, [role='listbox'], [role='menu'], svg")
      .forEach((element) => element.remove());

    const text = cleanText(clone.textContent);
    return text || null;
  }

  function directTextWithoutControls(root) {
    if (!root) return null;

    const parts = [];
    for (const node of root.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node;
        if (!element.matches?.("input, textarea, select, button, option, [role='listbox'], [role='menu'], svg")) {
          const text = textWithoutControls(element);
          if (text) parts.push(text);
        }
      }
    }

    const text = cleanText(parts.join(" "));
    return text || null;
  }

  function requiredTextWithoutControls(root) {
    const text = textWithoutControls(root);
    if (!text || !text.includes("*")) return null;

    const beforeStar = text.slice(0, text.indexOf("*"));
    const parts = beforeStar
      .split(/\n| {2,}|\t|(?<=[a-z])(?=[A-Z])/)
      .map(cleanText)
      .filter(Boolean);

    return parts.at(-1) || cleanText(beforeStar) || null;
  }

  function requiredLabelText(control) {
    if (!control) return null;

    const roots = [
      control.closest("[class*='field' i], [class*='question' i], [class*='input' i], li, fieldset"),
      control.parentElement
    ].filter(Boolean);

    for (const root of roots) {
      const text = requiredTextWithoutControls(root);
      if (isPlausibleLabel(text)) return text;
    }

    let current = control;
    for (let depth = 0; current && depth < 5; depth += 1) {
      let sibling = current.previousElementSibling;
      while (sibling) {
        const text = requiredTextWithoutControls(sibling);
        if (isPlausibleLabel(text)) return text;
        sibling = sibling.previousElementSibling;
      }
      current = current.parentElement;
    }

    return null;
  }

  function localLabelText(control) {
    const roots = [
      control.parentElement,
      control.closest("[class*='field' i], [class*='input' i], [data-testid], li")
    ].filter(Boolean);

    for (const root of roots) {
      const text = directTextWithoutControls(root);
      if (isPlausibleLabel(text)) return text;
    }

    return null;
  }

  function rootLabelText(control) {
    const roots = [
      control.closest("[data-testid], [class*='field' i], [class*='question' i], [class*='input' i], li"),
      control.parentElement
    ].filter(Boolean);

    for (const root of roots) {
      const text = textWithoutControls(root);
      if (isPlausibleLabel(text)) return text;
    }

    return null;
  }

  function previousText(element) {
    let current = element;

    for (let depth = 0; current && depth < 5; depth += 1) {
      let sibling = current.previousElementSibling;
      while (sibling) {
        const text = textWithoutControls(sibling) || cleanText(sibling.textContent);
        if (isPlausibleLabel(text)) return text;
        sibling = sibling.previousElementSibling;
      }

      current = current.parentElement;
    }

    return null;
  }

  function labelForControl(control) {
    return (
      requiredLabelText(control) ||
      associatedLabelText(control) ||
      localLabelText(control) ||
      metadataLabelText(control) ||
      rootLabelText(control) ||
      previousText(control)
    );
  }

  function optionTextForChoice(control) {
    const text = associatedLabelText(control) || metadataLabelText(control);
    if (text) return text;

    const parentText = textWithoutControls(control.parentElement);
    return parentText || cleanText(control.value);
  }

  function groupLabelForChoice(control) {
    const fieldset = control.closest("fieldset");
    const legend = fieldset?.querySelector("legend");
    const legendText = cleanText(legend?.textContent);
    if (legendText) return legendText;

    const requiredLabel = requiredLabelText(control);
    if (requiredLabel) return requiredLabel;

    const optionText = optionTextForChoice(control);
    let current = control.parentElement;

    for (let depth = 0; current && depth < 5; depth += 1) {
      const text = previousText(current);
      if (text && text !== optionText) return text;
      current = current.parentElement;
    }

    return null;
  }

  function valueForManualControl(control) {
    if (!isManualControl(control)) return null;

    if (control instanceof HTMLInputElement) {
      if (control.type === "checkbox" || control.type === "radio") {
        return control.checked ? optionTextForChoice(control) : null;
      }

      if (control.type === "file") {
        const files = [...control.files].map((file) => file.name).filter(Boolean);
        return files.length > 1 ? files : files[0] || null;
      }

      return cleanText(control.value);
    }

    if (control instanceof HTMLTextAreaElement) {
      return cleanText(control.value);
    }

    if (control instanceof HTMLSelectElement) {
      const values = [...control.selectedOptions]
        .map((option) => cleanText(option.text || option.value))
        .filter((value) => !isPlaceholderValue(value));
      return control.multiple ? values : values[0] || null;
    }

    const value = cleanText(
      control.textContent ||
      control.getAttribute?.("aria-valuetext") ||
      control.getAttribute?.("value")
    );
    return value;
  }

  function addManualField(fields, label, value) {
    const key = labelToKey(label);
    if (!key) return;
    if (isIgnoredManualFieldKey(key)) return;

    const values = Array.isArray(value) ? value : [value];
    const normalizedValues = values
      .map((item) => cleanText(item))
      .map((item) => shouldNormalizeFileFieldKey(key) ? filenameFromUploadText(item) : item)
      .filter((item) => !isPlaceholderValue(item))
      .filter((item) => !isInternalIdValue(item));

    if (!normalizedValues.length) return;

    const nextValue = normalizedValues.length > 1 ? normalizedValues : normalizedValues[0];

    if (!Object.hasOwn(fields, key) || hasInternalIdValue(fields[key])) {
      fields[key] = nextValue;
      return;
    }

    const existingValues = Array.isArray(fields[key]) ? fields[key] : [fields[key]];
    for (const item of normalizedValues) {
      if (!existingValues.includes(item)) {
        existingValues.push(item);
      }
    }
    fields[key] = existingValues.length > 1 ? existingValues : existingValues[0];
  }

  function manualFieldFromControl(control) {
    if (!isManualControl(control)) return null;

    const value = valueForManualControl(control);
    if (Array.isArray(value) ? !value.length : isPlaceholderValue(value)) return null;

    const label = control instanceof HTMLInputElement &&
      (control.type === "checkbox" || control.type === "radio")
      ? groupLabelForChoice(control) || optionTextForChoice(control)
      : labelForControl(control);

    if (!label) return null;

    return { label, value };
  }

  function cacheManualFieldFromControl(control) {
    const field = manualFieldFromControl(control);

    if (!field) {
      if (isManualControl(control)) {
        const label = control instanceof HTMLInputElement &&
          (control.type === "checkbox" || control.type === "radio")
          ? groupLabelForChoice(control) || optionTextForChoice(control)
          : labelForControl(control);
        const key = labelToKey(label);
        if (key) {
          manualFieldCache.delete(key);
        }
      }
      return;
    }

    const key = labelToKey(field.label);
    if (key) {
      manualFieldCache.set(key, field);
    }
  }

  function isCustomOptionElement(element) {
    if (!element?.matches) return false;

    return Boolean(
      element.closest(
        "[role='option'], [role='listbox'] li, [role='menu'] li, [data-value], [data-option-id]"
      )
    );
  }

  function customOptionElement(element) {
    return element?.closest?.(
      "[role='option'], [role='listbox'] li, [role='menu'] li, [data-value], [data-option-id]"
    );
  }

  function textFromCustomOption(option) {
    const text = cleanText(
      option?.getAttribute?.("aria-label") ||
      option?.getAttribute?.("data-label") ||
      option?.getAttribute?.("data-name") ||
      option?.textContent
    );

    return isPlaceholderValue(text) ? null : text;
  }

  function listRootForCustomOption(option) {
    return option?.closest?.("[role='listbox'], [role='menu'], ul, ol") || option?.parentElement;
  }

  function controlForCustomOption(option) {
    const list = listRootForCustomOption(option);
    const listId = list?.id;

    if (listId && typeof CSS !== "undefined" && CSS.escape) {
      const escaped = CSS.escape(listId);
      const control = document.querySelector(
        `[aria-controls="${escaped}"], [aria-owns="${escaped}"]`
      );
      if (control) return control;
    }

    const active = document.activeElement;
    if (active?.matches?.(MANUAL_CONTROL_SELECTOR)) {
      return active;
    }

    let current = list || option;
    for (let depth = 0; current && depth < 6; depth += 1) {
      const control = current.querySelector?.(MANUAL_CONTROL_SELECTOR);
      if (control) return control;

      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.matches?.(MANUAL_CONTROL_SELECTOR)) return sibling;
        const nested = sibling.querySelector?.(MANUAL_CONTROL_SELECTOR);
        if (nested) return nested;
        sibling = sibling.previousElementSibling;
      }

      current = current.parentElement;
    }

    return null;
  }

  function labelForCustomOption(option) {
    const control = controlForCustomOption(option);
    const list = listRootForCustomOption(option);

    return (
      labelForControl(control) ||
      requiredLabelText(list) ||
      previousText(list) ||
      rootLabelText(list)
    );
  }

  function cacheManualFieldFromCustomOption(target) {
    if (!isCustomOptionElement(target)) return;

    const option = customOptionElement(target);
    const value = textFromCustomOption(option);
    const label = labelForCustomOption(option);

    if (!label || !value) return;

    const key = labelToKey(label);
    if (key) {
      manualFieldCache.set(key, { label, value });
    }
  }

  function collectManualFields() {
    const fields = {};

    for (const control of document.querySelectorAll(MANUAL_CONTROL_SELECTOR)) {
      const field = manualFieldFromControl(control);
      if (field) {
        addManualField(fields, field.label, field.value);
      }
    }

    for (const [key, field] of manualFieldCache.entries()) {
      if (!Object.hasOwn(fields, key)) {
        addManualField(fields, field.label, field.value);
      }
    }

    return fields;
  }

  function elementClassIncludes(element, marker) {
    return cleanText(element?.getAttribute?.("class")).includes(marker);
  }

  function greenhouseQuestionRoot() {
    return greenhouseQuestionRoots()[0] || document;
  }

  function greenhouseQuestionRoots() {
    const roots = [...document.querySelectorAll(".application--questions")]
      .filter((element) => {
        return cleanText(element.textContent) &&
          element.querySelector(".field-wrapper, fieldset, input, textarea, .select__container, .select-shell");
      });

    return roots.length ? roots : [document];
  }

  function isGreenhouseSkippableLabel(label) {
    const key = labelToKey(label);
    return !key ||
      /^\d+$/.test(key) ||
      key === "search" ||
      key === "select" ||
      key === "clear_selection" ||
      key === "toggle_flyout";
  }

  function greenhouseQuestionItems() {
    const wrappers = greenhouseQuestionRoots().flatMap((root) => {
      return [...root.querySelectorAll("div")].filter((item) => {
        return elementClassIncludes(item, "field-wrapper") &&
          greenhouseIsActionableFieldWrapper(item);
      });
    });

    return wrappers.filter((wrapper) => {
      return !wrappers.some((other) => other !== wrapper && wrapper.contains(other));
    });
  }

  function greenhouseIsActionableFieldWrapper(wrapper) {
    return Boolean(
      greenhouseFileUploadContainer(wrapper) ||
      greenhouseSelectContainer(wrapper) ||
      greenhouseCheckboxFieldset(wrapper) ||
      greenhouseInputWrapper(wrapper)
    );
  }

  function greenhouseFileUploadContainer(wrapper) {
    return [...wrapper.querySelectorAll("div")]
      .find((element) => elementClassIncludes(element, "file-upload"));
  }

  function greenhouseSelectContainer(wrapper) {
    return [...wrapper.querySelectorAll("div")]
      .find((element) => {
        const classText = cleanText(element.getAttribute?.("class"));
        return classText.includes("select__container") ||
          classText.includes("select-shell") ||
          classText.includes("select__control");
      });
  }

  function greenhouseCheckboxFieldset(wrapper) {
    return [...wrapper.querySelectorAll("fieldset")]
      .find((element) => elementClassIncludes(element, "checkbox"));
  }

  function greenhouseInputWrapper(wrapper) {
    return [...wrapper.querySelectorAll("div")]
      .find((element) => elementClassIncludes(element, "input-wrapper"));
  }

  function labelTextBeforeRequiredStar(value) {
    const text = cleanText(value);
    if (!text) return "";

    const starIndex = text.indexOf("*");
    if (starIndex >= 0) {
      return cleanText(text.slice(0, starIndex + 1));
    }

    return text;
  }

  function firstVisibleTextBeforeControl(root) {
    const parts = [];

    for (const node of root.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent);
        continue;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      const element = node;
      if (element.matches?.("input, textarea, select, button, a, [role='combobox'], [contenteditable='true']")) {
        break;
      }

      if (element.querySelector?.("input, textarea, select, button, a, [role='combobox'], [contenteditable='true']")) {
        const text = directTextWithoutControls(element);
        if (text) parts.push(text);
        break;
      }

      const text = cleanText(element.textContent);
      if (text) parts.push(text);
    }

    return labelTextBeforeRequiredStar(parts.join(" "));
  }

  function greenhouseLabelForQuestion(item) {
    const upload = greenhouseFileUploadContainer(item);
    const uploadLabel = upload
      ? [...upload.querySelectorAll("div")]
        .find((element) => {
          const classText = cleanText(element.getAttribute?.("class"));
          return classText.includes("label") && classText.includes("upload-label");
        })
      : null;
    const uploadLabelText = labelTextBeforeRequiredStar(uploadLabel?.textContent);
    if (uploadLabelText) return uploadLabelText;

    const checkboxFieldset = greenhouseCheckboxFieldset(item) || (item.matches?.("fieldset") ? item : null);
    const legend = checkboxFieldset?.querySelector("legend");
    const legendText = labelTextBeforeRequiredStar(legend?.textContent);
    if (legendText) return legendText;

    const selectContainer = greenhouseSelectContainer(item);
    const selectLabelText = labelTextBeforeRequiredStar(selectContainer?.querySelector("label")?.textContent);
    if (selectLabelText) return selectLabelText;

    const inputWrapper = greenhouseInputWrapper(item);
    const inputLabelText = labelTextBeforeRequiredStar(inputWrapper?.querySelector("label")?.textContent);
    if (inputLabelText) return inputLabelText;

    const label = item.querySelector("label");
    const labelText = labelTextBeforeRequiredStar(directTextWithoutControls(label) || textWithoutControls(label));
    if (labelText) return labelText;

    for (const control of item.querySelectorAll("input, textarea, select, [role='combobox']")) {
      const describedByText = cleanText(
        [...cleanText(control.getAttribute?.("aria-describedby")).split(/\s+/)]
          .map((id) => document.getElementById(id)?.textContent)
          .filter(Boolean)
          .join(" ")
      );
      const metadataText = labelTextBeforeRequiredStar(
        control.getAttribute?.("description") ||
        control.getAttribute?.("aria-label") ||
        describedByText
      );

      if (metadataText) return metadataText;
    }

    const requiredText = labelTextBeforeRequiredStar(requiredTextWithoutControls(item));
    if (requiredText) return requiredText;

    return firstVisibleTextBeforeControl(item);
  }

  function greenhouseChoiceLabel(control) {
    const controlId = control?.id;
    if (controlId && typeof CSS !== "undefined" && CSS.escape) {
      const explicitLabel = document.querySelector(`label[for="${CSS.escape(controlId)}"]`);
      const text = cleanText(explicitLabel?.textContent);
      if (text) return text;
    }

    const label = control.closest("label");
    if (label) {
      const text = textWithoutControls(label);
      if (text) return text;
    }

    const siblingText = cleanText(control.nextElementSibling?.textContent);
    if (siblingText) return siblingText;

    const parentText = textWithoutControls(control.parentElement);
    return parentText || cleanText(control.value);
  }

  function greenhouseIsCheckedChoice(control) {
    return Boolean(
      control?.checked ||
      control?.matches?.(":checked") ||
      control?.getAttribute?.("checked") != null ||
      cleanText(control?.getAttribute?.("aria-checked")).toLowerCase() === "true"
    );
  }

  function greenhouseCheckboxOptionChecked(optionWrapper) {
    const control = optionWrapper.querySelector?.("input[type='checkbox'], input[type='radio']");
    if (greenhouseIsCheckedChoice(control)) return true;

    const metadata = cleanText([
      optionWrapper.getAttribute?.("aria-checked"),
      optionWrapper.getAttribute?.("data-checked"),
      optionWrapper.getAttribute?.("data-selected"),
      optionWrapper.getAttribute?.("class"),
      optionWrapper.querySelector?.(".checkbox__input")?.getAttribute?.("class"),
      optionWrapper.querySelector?.("svg")?.getAttribute?.("class")
    ].join(" ")).toLowerCase();

    return /\b(true|checked|selected|is-checked|is-selected)\b/.test(metadata) ||
      optionWrapper.querySelector?.("input[checked], input:checked, [aria-checked='true'], [data-checked='true']") != null;
  }

  function greenhouseCheckboxOptionLabel(optionWrapper) {
    const control = optionWrapper.querySelector?.("input[type='checkbox'], input[type='radio']");
    const label = greenhouseChoiceLabel(control);
    if (label) return label;

    const directLabel = optionWrapper.querySelector?.("label");
    const text = cleanText(directLabel?.textContent || textWithoutControls(optionWrapper));
    return text || null;
  }

  function greenhouseDirectCheckboxFieldsets() {
    return greenhouseQuestionRoots().flatMap((root) => {
      return [...root.querySelectorAll("fieldset")].filter((fieldset) => {
        return elementClassIncludes(fieldset, "checkbox");
      });
    });
  }

  function addGreenhouseDirectCheckboxFields(fields) {
    for (const fieldset of greenhouseDirectCheckboxFieldsets()) {
      const label = labelTextBeforeRequiredStar(fieldset.querySelector("legend")?.textContent) ||
        greenhouseLabelForQuestion(fieldset);
      const values = [];
      const optionWrappers = [...fieldset.querySelectorAll("div")]
        .filter((element) => elementClassIncludes(element, "checkbox__wrapper"));

      for (const optionWrapper of optionWrappers) {
        if (!greenhouseCheckboxOptionChecked(optionWrapper)) continue;

        const value = greenhouseCheckboxOptionLabel(optionWrapper);
        if (value) values.push(value);
      }

      if (label && values.length) {
        addManualField(fields, label, values.length > 1 ? [...new Set(values)] : values[0]);
      }
    }
  }

  function greenhouseFileLinkValues(item) {
    const values = [];

    const filenameSelectors = [
      ".file-upload_filename",
      "[class*='file-upload_filename']",
      "[class*='file-upload__filename']",
      "[class*='upload_filename']",
      "[class*='filename']"
    ].join(",");

    for (const element of item.querySelectorAll(filenameSelectors)) {
      const candidate = filenameFromUploadText(element.textContent);
      if (isFilenameValue(candidate)) {
        values.push(candidate);
      }
    }

    for (const link of item.querySelectorAll("a")) {
      const candidate = filenameFromUploadText(
        cleanText(link.textContent) ||
        cleanText(link.getAttribute("download")) ||
        cleanText(link.getAttribute("href"))
      );

      if (isFilenameValue(candidate)) {
        values.push(candidate);
      }
    }

    for (const element of item.querySelectorAll("p, span, div")) {
      const text = cleanText(element.textContent);
      if (!text || text.length > 120) continue;

      const candidate = filenameFromUploadText(text);
      if (isFilenameValue(candidate)) {
        values.push(candidate);
      }
    }

    return [...new Set(values)];
  }

  function greenhouseReactSelectValues(item) {
    const values = [];

    for (const element of item.querySelectorAll("*")) {
      const classText = cleanText(element.getAttribute?.("class"));
      if (
        !classText.includes("select__single-value") &&
        !classText.includes("select__multi-value__label") &&
        !classText.includes("singleValue") &&
        !classText.includes("multiValue")
      ) {
        continue;
      }

      const text = cleanText(element.textContent);
      if (text && !isPlaceholderValue(text)) {
        values.push(text);
      }
    }

    return [...new Set(values)];
  }

  function greenhouseDirectSelectContainers() {
    const containers = greenhouseQuestionRoots().flatMap((root) => {
      return [...root.querySelectorAll("div")].filter((element) => {
        const classText = cleanText(element.getAttribute?.("class"));
        return classText.includes("select__container") || classText.includes("select-shell");
      });
    });

    return containers.filter((container) => {
      return !containers.some((other) => other !== container && container.contains(other));
    });
  }

  function addGreenhouseDirectSelectFields(fields) {
    for (const container of greenhouseDirectSelectContainers()) {
      const wrapper = container.closest(".field-wrapper") || container;
      const label = greenhouseLabelForQuestion(wrapper);
      const values = greenhouseReactSelectValues(container);

      if (!values.length) {
        for (const select of container.querySelectorAll("select")) {
          values.push(
            ...[...select.selectedOptions]
              .map((option) => cleanText(option.text || option.value))
              .filter((value) => !isPlaceholderValue(value))
          );
        }
      }

      if (label && !isGreenhouseSkippableLabel(label) && values.length) {
        addManualField(fields, label, values.length > 1 ? [...new Set(values)] : values[0]);
      }
    }
  }

  function greenhouseFileUploadField(wrapper) {
    const upload = greenhouseFileUploadContainer(wrapper);
    if (!upload) return null;

    const labelElement = [...upload.querySelectorAll("div")]
      .find((element) => {
        const classText = cleanText(element.getAttribute?.("class"));
        return classText.includes("label") && classText.includes("upload-label");
      }) || wrapper.querySelector("label");
    const label = labelTextBeforeRequiredStar(labelElement?.textContent);
    const values = [
      ...[...upload.querySelectorAll("input[type='file']")]
        .flatMap((control) => [...control.files].map((file) => file.name)),
      ...greenhouseFileLinkValues(upload)
    ];

    return { label, value: values.length > 1 ? [...new Set(values)] : values[0] || null };
  }

  function greenhouseSelectField(wrapper) {
    const selectContainer = greenhouseSelectContainer(wrapper);
    if (!selectContainer) return null;

    const label = greenhouseLabelForQuestion(wrapper);
    const values = greenhouseReactSelectValues(selectContainer);

    if (!values.length) {
      for (const select of selectContainer.querySelectorAll("select")) {
        values.push(
          ...[...select.selectedOptions]
            .map((option) => cleanText(option.text || option.value))
            .filter((value) => !isPlaceholderValue(value))
        );
      }
    }

    return { label, value: values.length > 1 ? [...new Set(values)] : values[0] || null };
  }

  function greenhouseCheckboxField(wrapper) {
    const fieldset = greenhouseCheckboxFieldset(wrapper);
    if (!fieldset) return null;

    const label = labelTextBeforeRequiredStar(fieldset.querySelector("legend")?.textContent) ||
      greenhouseLabelForQuestion(fieldset);
    const values = [];
    const optionWrappers = [...fieldset.querySelectorAll("div")]
      .filter((element) => elementClassIncludes(element, "checkbox__wrapper"));

    if (optionWrappers.length) {
      for (const optionWrapper of optionWrappers) {
        if (!greenhouseCheckboxOptionChecked(optionWrapper)) continue;

        const value = greenhouseCheckboxOptionLabel(optionWrapper);
        if (value) values.push(value);
      }
    } else {
      for (const control of fieldset.querySelectorAll("input[type='checkbox'], input[type='radio']")) {
        if (greenhouseIsCheckedChoice(control)) {
          values.push(greenhouseChoiceLabel(control));
        }
      }
    }

    return { label, value: values.length > 1 ? [...new Set(values)] : values[0] || null };
  }

  function greenhouseRegularField(wrapper) {
    const label = greenhouseLabelForQuestion(wrapper);
    const values = [];
    const inputWrapper = greenhouseInputWrapper(wrapper) || wrapper;

    for (const control of inputWrapper.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='combobox']")) {
      if (control.closest?.("fieldset.checkbox, .file-upload, .select__container")) continue;
      const value = greenhouseValueForControl(control);
      if (Array.isArray(value)) values.push(...value);
      else if (value) values.push(value);
    }

    return { label, value: values.length > 1 ? [...new Set(values)] : values[0] || null };
  }

  function greenhouseFieldFromWrapper(wrapper) {
    return greenhouseFileUploadField(wrapper) ||
      greenhouseSelectField(wrapper) ||
      greenhouseCheckboxField(wrapper) ||
      greenhouseRegularField(wrapper);
  }

  function greenhouseValueForQuestion(item) {
    const values = [];

    values.push(...greenhouseReactSelectValues(item));

    for (const control of item.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='combobox']")) {
      if (isSecurityControl(control)) continue;

      if (control instanceof HTMLInputElement) {
        if (control.type === "hidden" || control.type === "button" || control.type === "submit") continue;

        if (control.type === "checkbox" || control.type === "radio") {
          if (greenhouseIsCheckedChoice(control)) values.push(greenhouseChoiceLabel(control));
          continue;
        }

        if (control.type === "file") {
          values.push(...[...control.files].map((file) => file.name));
          continue;
        }

        values.push(control.value);
        continue;
      }

      if (control instanceof HTMLTextAreaElement) {
        values.push(control.value);
        continue;
      }

      if (control instanceof HTMLSelectElement) {
        values.push(
          ...[...control.selectedOptions]
            .map((option) => cleanText(option.text || option.value))
            .filter((value) => !isPlaceholderValue(value))
        );
        continue;
      }

      const customValue = cleanText(
        control.getAttribute?.("aria-valuetext") ||
        control.getAttribute?.("title") ||
        control.textContent
      );
      if (customValue) values.push(customValue);
    }

    values.push(...greenhouseFileLinkValues(item));

    const normalizedValues = values
      .map(cleanText)
      .filter(Boolean)
      .filter((value) => !isPlaceholderValue(value));

    if (!normalizedValues.length) return null;
    return normalizedValues.length > 1 ? normalizedValues : normalizedValues[0];
  }

  function greenhouseValueForControl(control) {
    if (!control || isSecurityControl(control)) return null;

    const selectRoot = control.closest?.(".select__container, .select-shell, .select__control");
    const reactSelectValues = selectRoot ? greenhouseReactSelectValues(selectRoot) : [];
    if (reactSelectValues.length) {
      return reactSelectValues.length > 1 ? reactSelectValues : reactSelectValues[0];
    }

    if (control instanceof HTMLInputElement) {
      if (control.type === "hidden" || control.type === "button" || control.type === "submit") return null;

      if (control.type === "checkbox" || control.type === "radio") {
        return greenhouseIsCheckedChoice(control) ? greenhouseChoiceLabel(control) : null;
      }

      if (control.type === "file") {
        const files = [...control.files].map((file) => file.name).filter(Boolean);
        return files.length > 1 ? files : files[0] || null;
      }

      return cleanText(control.value || control.getAttribute("value"));
    }

    if (control instanceof HTMLTextAreaElement) {
      return cleanText(control.value);
    }

    if (control instanceof HTMLSelectElement) {
      const values = [...control.selectedOptions]
        .map((option) => cleanText(option.text || option.value))
        .filter((value) => !isPlaceholderValue(value));
      return control.multiple ? values : values[0] || null;
    }

    return cleanText(
      control.getAttribute?.("aria-valuetext") ||
      control.getAttribute?.("title") ||
      control.textContent
    );
  }

  function addGreenhouseDirectLabeledControls(fields) {
    for (const root of greenhouseQuestionRoots()) {
      for (const label of root.querySelectorAll("label[for]")) {
        const labelText = labelTextBeforeRequiredStar(
          directTextWithoutControls(label) ||
          textWithoutControls(label) ||
          label.textContent
        );
        const controlId = label.getAttribute("for");
        if (!labelText || isGreenhouseSkippableLabel(labelText) || !controlId) continue;

        const control = document.getElementById(controlId);
        if (!control || !root.contains(control)) continue;

        const value = greenhouseValueForControl(control);
        if (value) {
          addManualField(fields, labelText, value);
        }
      }
    }
  }

  function addGreenhouseDirectTextInputFields(fields) {
    for (const root of greenhouseQuestionRoots()) {
      for (const wrapper of root.querySelectorAll(".field-wrapper")) {
        const inputWrapper = [...wrapper.querySelectorAll("div")]
          .find((element) => {
            const classText = cleanText(element.getAttribute?.("class"));
            return classText.split(/\s+/).includes("input-wrapper");
          });
        if (!inputWrapper) continue;

        const label = labelTextBeforeRequiredStar(inputWrapper.querySelector("label")?.textContent);
        if (!label || isGreenhouseSkippableLabel(label)) continue;

        const control = inputWrapper.querySelector("input:not([type='hidden']), textarea");
        if (!control) continue;

        const value = greenhouseValueForControl(control);
        if (value) {
          addManualField(fields, label, value);
        }
      }
    }
  }

  function addGreenhouseAriaLabeledControls(fields) {
    for (const root of greenhouseQuestionRoots()) {
      for (const control of root.querySelectorAll("input:not([type='hidden']), textarea, select")) {
        const describedByText = cleanText(
          [...cleanText(control.getAttribute?.("aria-describedby")).split(/\s+/)]
            .map((id) => document.getElementById(id)?.textContent)
            .filter(Boolean)
            .join(" ")
        );
        const label = cleanText(
          control.getAttribute?.("aria-label") ||
          control.getAttribute?.("description") ||
          describedByText
        );
        if (!label || isGreenhouseSkippableLabel(label)) continue;

        const value = greenhouseValueForControl(control);
        if (value) {
          addManualField(fields, label, value);
        }
      }
    }
  }

  function collectGreenhouseManualFields() {
    const fields = {};
    const items = greenhouseQuestionItems();

    for (const item of items) {
      const field = greenhouseFieldFromWrapper(item);
      const label = field?.label;
      const value = field?.value;

      if (label && !isGreenhouseSkippableLabel(label) && value) {
        addManualField(fields, label, value);
      }
    }

    addGreenhouseDirectTextInputFields(fields);
    addGreenhouseDirectLabeledControls(fields);
    addGreenhouseAriaLabeledControls(fields);
    addGreenhouseDirectSelectFields(fields);
    addGreenhouseDirectCheckboxFields(fields);

    return Object.keys(fields).length ? fields : collectManualFields();
  }

  function itemKeyAppearsInGreenhouseQuestions(key, items) {
    return items.some((item) => {
      const label = greenhouseLabelForQuestion(item);
      return labelToKey(label) === key;
    });
  }

  function ashbyQuestionItems() {
    const items = [...document.querySelectorAll("fieldset, div")].filter((item) => {
      if (item.matches?.("fieldset")) return true;
      return elementClassIncludes(item, "ashby-application-form-field-entry");
    });

    return items.filter((item) => {
      return !items.some((other) => other !== item && other.contains(item));
    });
  }

  function ashbyLabelElements(item) {
    const elements = [];

    if (item.matches?.("fieldset")) {
      const legend = item.querySelector("legend");
      if (legend) elements.push(legend);
    }

    elements.push(
      ...[...item.querySelectorAll("label, [aria-label], h1, h2, h3, h4, h5, h6")]
        .filter((element) => {
          if (element.matches?.("input, textarea, select")) return false;
          const text = cleanText(element.getAttribute?.("aria-label") || element.textContent);
          return Boolean(text);
        })
    );

    return [...new Set(elements)];
  }

  function ashbyLabelForQuestion(item) {
    for (const element of ashbyLabelElements(item)) {
      const text = labelTextBeforeRequiredStar(
        directTextWithoutControls(element) ||
        textWithoutControls(element) ||
        element.getAttribute?.("aria-label")
      );

      if (text) return text;
    }

    return firstVisibleTextBeforeControl(item);
  }

  function ashbyChoiceLabel(control) {
    const label = control.closest("label");
    if (label) {
      const text = textWithoutControls(label);
      if (text) return text;
    }

    for (let sibling = control.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      if (sibling.matches?.("input, textarea, select, button, svg")) continue;
      const text = cleanText(sibling.textContent);
      if (text && !isPlaceholderValue(text) && text !== cleanText(control.value)) return text;
    }

    const parent = control.parentElement;
    if (parent && parent.querySelectorAll("input[type='checkbox'], input[type='radio']").length <= 1) {
      const text = textWithoutControls(parent);
      if (text && text !== cleanText(control.value)) return text;
    }

    return cleanText(control.value);
  }

  function ashbyFileLinkValues(item) {
    const values = [];

    for (const link of item.querySelectorAll("a")) {
      const candidate = filenameFromUploadText(
        cleanText(link.textContent) ||
        cleanText(link.getAttribute("download")) ||
        cleanText(link.getAttribute("href"))
      );

      if (isFilenameValue(candidate)) {
        values.push(candidate);
      }
    }

    return values;
  }

  function ashbyFallbackVisibleValue(item, label) {
    const clone = item.cloneNode(true);

    clone
      .querySelectorAll("input, textarea, select, option, svg, [role='listbox'], [role='menu']")
      .forEach((element) => element.remove());

    for (const labelElement of clone.querySelectorAll("label, legend, h1, h2, h3, h4, h5, h6")) {
      const text = cleanText(labelElement.textContent || labelElement.getAttribute?.("aria-label"));
      if (!text || text === cleanText(label)) {
        labelElement.remove();
      }
    }

    const ignoredButtonText = /^(upload|attach|replace|remove|delete|choose file|browse)$/i;
    const values = [...clone.querySelectorAll("[aria-selected='true'], [aria-checked='true'], button, [role='button'], [role='option']")]
      .map((element) => cleanText(element.textContent || element.getAttribute?.("aria-label")))
      .filter((text) => text && !isPlaceholderValue(text))
      .filter((text) => text !== cleanText(label))
      .filter((text) => !ignoredButtonText.test(text));

    if (values.length) {
      return values.length > 1 ? [...new Set(values)] : values[0];
    }

    const text = cleanText(clone.textContent);
    if (!text || text === cleanText(label) || isPlaceholderValue(text)) return null;
    if (ignoredButtonText.test(text)) return null;

    return text;
  }

  function ashbyValueForQuestion(item, label) {
    const values = [];

    for (const control of item.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='combobox']")) {
      if (isSecurityControl(control)) continue;

      if (control instanceof HTMLInputElement) {
        if (control.type === "hidden" || control.type === "button" || control.type === "submit") continue;

        if (control.type === "checkbox" || control.type === "radio") {
          if (control.checked) values.push(ashbyChoiceLabel(control));
          continue;
        }

        if (control.type === "file") {
          values.push(...[...control.files].map((file) => file.name));
          continue;
        }

        values.push(control.value);
        continue;
      }

      if (control instanceof HTMLTextAreaElement) {
        values.push(control.value);
        continue;
      }

      if (control instanceof HTMLSelectElement) {
        values.push(
          ...[...control.selectedOptions]
            .map((option) => cleanText(option.text || option.value))
            .filter((value) => !isPlaceholderValue(value))
        );
        continue;
      }

      const customValue = cleanText(
        control.getAttribute?.("aria-valuetext") ||
        control.getAttribute?.("title") ||
        control.textContent
      );
      if (customValue) values.push(customValue);
    }

    values.push(...ashbyFileLinkValues(item));

    const normalizedValues = values
      .map(cleanText)
      .filter(Boolean)
      .filter((value) => !isPlaceholderValue(value))
      .filter((value) => !isInternalIdValue(value));

    if (normalizedValues.length) {
      return normalizedValues.length > 1 ? [...new Set(normalizedValues)] : normalizedValues[0];
    }

    return ashbyFallbackVisibleValue(item, label);
  }

  function collectAshbyManualFields() {
    const fields = {};
    const items = ashbyQuestionItems();

    if (!items.length) {
      return collectManualFields();
    }

    for (const item of items) {
      const label = ashbyLabelForQuestion(item);
      const value = ashbyValueForQuestion(item, label);

      if (label && value) {
        addManualField(fields, label, value);
      }
    }

    return Object.keys(fields).length ? fields : collectManualFields();
  }

  function leverQuestionItems() {
    return [...document.querySelectorAll("li")].filter((item) => {
      const classText = cleanText(item.getAttribute?.("class"));
      return classText.includes("application-question") ||
        classText.includes("appcation-question");
    });
  }

  function leverLabelForQuestion(item) {
    const labelElement = [...item.querySelectorAll("div")]
      .find((element) => elementClassIncludes(element, "application-label"));

    return cleanText(labelElement?.textContent);
  }

  function leverFieldForQuestion(item) {
    return [...item.querySelectorAll("div")]
      .find((element) => elementClassIncludes(element, "application-field"));
  }

  function leverCleanChoiceText(value, submittedValue) {
    const text = cleanText(value);
    if (!text || isPlaceholderValue(text)) return "";
    if (submittedValue && text === cleanText(submittedValue)) return "";
    return text;
  }

  function leverChoiceLabel(control) {
    const label = control.closest("label");
    if (label) {
      const text = leverCleanChoiceText(textWithoutControls(label), control.value);
      if (text) return text;
    }

    for (let sibling = control.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      if (sibling.matches?.("input, textarea, select, button, svg")) continue;
      const text = leverCleanChoiceText(sibling.textContent, control.value);
      if (text) return text;
    }

    const parent = control.parentElement;
    if (parent && parent.querySelectorAll("input[type='checkbox'], input[type='radio']").length <= 1) {
      const text = leverCleanChoiceText(textWithoutControls(parent), control.value);
      if (text) return text;
    }

    return cleanText(control.value);
  }

  function leverFileLinkValues(fieldElement) {
    const values = [];

    for (const link of fieldElement.querySelectorAll("a")) {
      const text = cleanText(link.textContent);
      const hrefTail = cleanText(link.getAttribute("download")) ||
        cleanText(link.getAttribute("href")).split(/[/?#]/).filter(Boolean).pop();
      const candidate = filenameFromUploadText(text || hrefTail);

      if (!candidate) continue;
      if (!isFilenameValue(candidate)) continue;
      values.push(candidate);
    }

    return values;
  }

  function leverVisibleFieldText(fieldElement) {
    const clone = fieldElement.cloneNode(true);
    clone
      .querySelectorAll("input, textarea, select, button, option, svg, [role='listbox'], [role='menu']")
      .forEach((element) => element.remove());

    const text = cleanText(clone.textContent);
    if (!text || isPlaceholderValue(text)) return "";
    return text;
  }

  function leverValueForField(fieldElement) {
    if (!fieldElement) return null;

    const values = [];

    for (const control of fieldElement.querySelectorAll("input, textarea, select")) {
      if (isSecurityControl(control)) continue;

      if (control instanceof HTMLInputElement) {
        if (control.type === "hidden" || control.type === "button" || control.type === "submit") continue;

        if (control.type === "checkbox" || control.type === "radio") {
          if (control.checked) values.push(leverChoiceLabel(control));
          continue;
        }

        if (control.type === "file") {
          values.push(...[...control.files].map((file) => file.name));
          continue;
        }

        values.push(control.value);
        continue;
      }

      if (control instanceof HTMLTextAreaElement) {
        values.push(control.value);
        continue;
      }

      if (control instanceof HTMLSelectElement) {
        values.push(
          ...[...control.selectedOptions]
            .map((option) => cleanText(option.text || option.value))
            .filter((value) => !isPlaceholderValue(value))
        );
      }
    }

    values.push(...leverFileLinkValues(fieldElement));

    const normalizedValues = values
      .map(cleanText)
      .filter(Boolean)
      .filter((value) => !isPlaceholderValue(value));

    if (normalizedValues.length) {
      return normalizedValues.length > 1 ? normalizedValues : normalizedValues[0];
    }

    const fallbackText = leverVisibleFieldText(fieldElement);
    return isPlaceholderValue(fallbackText) ? null : fallbackText;
  }

  function collectLeverManualFields() {
    const fields = {};
    const items = leverQuestionItems();

    if (!items.length) {
      return collectManualFields();
    }

    for (const item of items) {
      const label = leverLabelForQuestion(item);
      const field = leverFieldForQuestion(item);
      const value = leverValueForField(field);

      if (label && value) {
        addManualField(fields, label, value);
      }
    }

    return fields;
  }

  function gustoApplicationForm() {
    return document.querySelector("form#job-applicant-form");
  }

  function gustoMetadataLabelForControl(control) {
    const metadata = cleanText(
      control?.getAttribute?.("aria-label") ||
      control?.getAttribute?.("placeholder") ||
      control?.getAttribute?.("name") ||
      control?.id
    );

    return metadata.replace(/^job_applicant\[([^\]]+)\]$/i, "$1");
  }

  function gustoFileLabelForControl(control) {
    const metadata = labelToKey(gustoMetadataLabelForControl(control));
    if (!metadata) return "";
    if (/resume|cv/.test(metadata)) return "Resume CV";
    if (/cover_letter/.test(metadata)) return "Cover Letter";
    return titleFromSnakeLikeKey(metadata);
  }

  function titleFromSnakeLikeKey(value) {
    return cleanText(value)
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
      .replace(/\bCv\b/g, "CV");
  }

  function gustoFormLabelForControl(form, control) {
    if (control instanceof HTMLInputElement && control.type === "file") {
      const fileLabel = gustoFileLabelForControl(control);
      if (fileLabel) return fileLabel;
    }

    const labels = [];
    const controlId = control?.id;
    const questionBlock = control?.closest?.("[class*='col-span'], [class*='grid-cols'], .mt-6, .pt-8");

    if (questionBlock) {
      for (const label of questionBlock.querySelectorAll("label")) {
        if (label.querySelector("input, textarea, select")) continue;

        const text = labelTextBeforeRequiredStar(
          directTextWithoutControls(label) ||
          textWithoutControls(label) ||
          label.textContent
        );
        if (text) labels.push(label);
      }
    }

    if (controlId && typeof CSS !== "undefined" && CSS.escape) {
      const label = form.querySelector(`label[for="${CSS.escape(controlId)}"]`) ||
        document.querySelector(`label[for="${CSS.escape(controlId)}"]`);
      if (label) labels.push(label);
    }

    const closestLabel = control?.closest?.("label");
    if (closestLabel) labels.push(closestLabel);

    for (const label of labels) {
      const text = labelTextBeforeRequiredStar(
        directTextWithoutControls(label) ||
        textWithoutControls(label) ||
        label.textContent
      );
      if (text) return text;
    }

    return gustoMetadataLabelForControl(control);
  }

  function gustoVisibleUploadedFileName(control) {
    const uploadRoot = control?.closest?.("[data-controller~='file-upload'], [data-controller='file-upload']") ||
      control?.closest?.("label") ||
      control?.parentElement;
    if (!uploadRoot) return "";

    const explicitLabel = uploadRoot.querySelector("[data-file-upload-target='fileLabel']");
    const explicitText = filenameFromUploadText(explicitLabel?.textContent);
    if (isFilenameValue(explicitText)) return explicitText;

    for (const element of uploadRoot.querySelectorAll("p, span, div")) {
      const candidate = filenameFromUploadText(element.textContent);
      if (isFilenameValue(candidate)) {
        return candidate;
      }
    }

    return "";
  }

  function gustoChoiceLabel(form, control) {
    const label = gustoFormLabelForControl(form, control);
    if (label && label !== cleanText(control?.value)) return label;

    const siblingText = cleanText(control?.nextElementSibling?.textContent);
    if (siblingText) return siblingText;

    return cleanText(control?.value);
  }

  function gustoCustomQuestionGroupForChoice(control) {
    const column = control?.closest?.("[class*='col-span'], .sm\\:col-span-6") ||
      control?.closest?.("div");
    const group = column?.closest?.(".grid, [class*='grid-cols']");
    return group || column || control?.parentElement;
  }

  function gustoQuestionLabelForChoiceGroup(form, group, firstControl) {
    const controlId = firstControl?.id;
    const labels = [...group.querySelectorAll("label")];

    for (const label of labels) {
      const forValue = label.getAttribute("for");
      if (forValue && forValue === controlId) continue;
      if (label.querySelector("input[type='checkbox'], input[type='radio']")) continue;

      const text = labelTextBeforeRequiredStar(label.textContent);
      if (text) return text;
    }

    const metadata = cleanText(
      firstControl?.getAttribute?.("aria-label") ||
      firstControl?.getAttribute?.("name")
    );
    return metadata.replace(/^job_applicant\[([^\]]+)\]$/i, "$1");
  }

  function gustoSelectedChoiceValues(form, groupName) {
    return [...form.querySelectorAll("input[type='checkbox'], input[type='radio']")]
      .filter((control) => control.name === groupName && control.checked)
      .map((control) => gustoChoiceLabel(form, control))
      .filter(Boolean);
  }

  function addGustoChoiceGroupFields(fields, form) {
    const seenNames = new Set();

    for (const control of form.querySelectorAll("input[type='checkbox'], input[type='radio']")) {
      if (!control.name || seenNames.has(control.name)) continue;
      seenNames.add(control.name);

      const group = gustoCustomQuestionGroupForChoice(control);
      if (!group) continue;

      const label = gustoQuestionLabelForChoiceGroup(form, group, control);
      const values = gustoSelectedChoiceValues(form, control.name);

      if (label && values.length) {
        addManualField(fields, label, values.length > 1 ? values : values[0]);
      }
    }
  }

  function gustoValueForControl(form, control) {
    if (!control || isSecurityControl(control)) return null;

    if (control instanceof HTMLInputElement) {
      if (["hidden", "button", "submit", "reset", "password"].includes(control.type)) return null;

      if (control.type === "checkbox" || control.type === "radio") {
        return control.checked ? gustoChoiceLabel(form, control) : null;
      }

      if (control.type === "file") {
        const files = [...control.files].map((file) => file.name).filter(Boolean);
        const visibleFileName = gustoVisibleUploadedFileName(control);
        if (visibleFileName) return visibleFileName;
        return files.length > 1 ? files : files[0] || null;
      }

      return cleanText(control.value || control.getAttribute("value"));
    }

    if (control instanceof HTMLTextAreaElement) {
      return cleanText(control.value);
    }

    if (control instanceof HTMLSelectElement) {
      const values = [...control.selectedOptions]
        .map((option) => cleanText(option.text || option.value))
        .filter((value) => !isPlaceholderValue(value));
      return control.multiple ? values : values[0] || null;
    }

    return cleanText(
      control.getAttribute?.("aria-valuetext") ||
      control.getAttribute?.("title") ||
      control.textContent
    );
  }

  function collectGustoManualFields() {
    const fields = {};
    const form = gustoApplicationForm();

    if (!form) return collectManualFields();

    addGustoChoiceGroupFields(fields, form);

    for (const control of form.querySelectorAll("input, textarea, select")) {
      if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) {
        continue;
      }

      const label = gustoFormLabelForControl(form, control);
      const value = gustoValueForControl(form, control);

      if (label && value) {
        addManualField(fields, label, value);
      }
    }

    return fields;
  }

  function applyToJobApplicationForm() {
    const explicitForm = document.querySelector("form#form_submit_new_resume");
    if (explicitForm) return explicitForm;

    const resumatorElement = document.querySelector("[id^='resumator-']");
    return resumatorElement?.closest?.("form") || null;
  }

  function applyToJobMetadataLabelForControl(control) {
    const metadata = cleanText(
      control?.getAttribute?.("aria-label") ||
      control?.getAttribute?.("placeholder") ||
      control?.getAttribute?.("name") ||
      control?.id
    );

    return metadata
      .replace(/^resumator-/i, "")
      .replace(/-value$/i, "")
      .replace(/^job_applicant\[([^\]]+)\]$/i, "$1");
  }

  function applyToJobLabelForControl(form, control) {
    const labels = [];
    const controlId = control?.id;
    const group = control?.closest?.(".form-group, [class*='form-group']");
    const directGroupLabel = group?.querySelector?.(":scope > label.control-label, :scope > label");

    if (control instanceof HTMLInputElement && control.type === "file") {
      const metadata = labelToKey(applyToJobMetadataLabelForControl(control));
      if (/resume|cv/.test(metadata)) return "Resume CV";
      if (/cover_letter/.test(metadata)) return "Cover Letter";
    }

    if (directGroupLabel) labels.push(directGroupLabel);

    if (controlId && typeof CSS !== "undefined" && CSS.escape) {
      const selector = `label[for="${CSS.escape(controlId)}"]`;
      const label = form.querySelector(selector) || document.querySelector(selector);
      if (label) labels.push(label);
    }

    const groupLabel = group?.querySelector?.("label.control-label, label");
    if (groupLabel) labels.push(groupLabel);

    const closestLabel = control?.closest?.("label");
    if (closestLabel) labels.push(closestLabel);

    for (const label of labels) {
      const text = labelTextBeforeRequiredStar(
        directTextWithoutControls(label) ||
        textWithoutControls(label) ||
        label.textContent
      );
      if (text) return text;
    }

    return applyToJobMetadataLabelForControl(control);
  }

  function applyToJobChoiceLabel(control) {
    const label = control?.closest?.("label");
    const labelText = labelTextBeforeRequiredStar(textWithoutControls(label) || label?.textContent);
    if (labelText && labelText !== cleanText(control?.value)) return labelText;

    const nextText = cleanText(control?.nextElementSibling?.textContent);
    if (nextText) return nextText;

    return cleanText(control?.value);
  }

  function applyToJobVisibleUploadedFileName(control) {
    const uploadRoot = control?.closest?.(".form-group, [class*='resume'], [class*='upload']") ||
      control?.parentElement;
    if (!uploadRoot) return "";

    for (const element of uploadRoot.querySelectorAll("p, span, a, div")) {
      const candidate = filenameFromUploadText(element.textContent);
      if (isFilenameValue(candidate)) {
        return candidate;
      }
    }

    return "";
  }

  function applyToJobValueForControl(form, control) {
    if (!control || isSecurityControl(control)) return null;

    if (control instanceof HTMLInputElement) {
      if (["hidden", "button", "submit", "reset", "password"].includes(control.type)) return null;

      if (control.type === "checkbox" || control.type === "radio") {
        return control.checked ? applyToJobChoiceLabel(control) : null;
      }

      if (control.type === "file") {
        const files = [...control.files].map((file) => file.name).filter(Boolean);
        if (files.length) return files.length > 1 ? files : files[0];

        const inputValueFileName = filenameFromFileInputValue(control.value || control.getAttribute("value"));
        if (inputValueFileName) return inputValueFileName;

        const visibleFileName = applyToJobVisibleUploadedFileName(control);
        if (visibleFileName) return visibleFileName;
        return null;
      }

      return cleanText(control.value || control.getAttribute("value"));
    }

    if (control instanceof HTMLTextAreaElement) {
      return cleanText(control.value);
    }

    if (control instanceof HTMLSelectElement) {
      const values = [...control.selectedOptions]
        .map((option) => cleanText(option.text || option.value))
        .filter((value) => !isPlaceholderValue(value));
      return control.multiple ? values : values[0] || null;
    }

    return cleanText(control.textContent);
  }

  function addApplyToJobAddressField(fields, form) {
    const group = form.querySelector("#resumator-address");
    if (!group) return new Set();

    const addressControls = [...group.querySelectorAll("input, textarea, select")];
    const skipped = new Set(addressControls);
    const addressParts = {};

    for (const control of addressControls) {
      if (!control || isSecurityControl(control)) continue;

      const rawValue = control instanceof HTMLSelectElement
        ? [...control.selectedOptions].map((option) => cleanText(option.text || option.value)).filter(Boolean).join(", ")
        : cleanText(control.value || control.getAttribute?.("value"));
      if (isPlaceholderValue(rawValue)) continue;

      const key = labelToKey(
        control.getAttribute?.("placeholder") ||
        applyToJobMetadataLabelForControl(control)
      );
      if (key) addressParts[key] = rawValue;
    }

    const orderedValues = [
      addressParts.address,
      addressParts.city,
      addressParts.state_province || addressParts.state,
      addressParts.postal || addressParts.zip || addressParts.zip_code
    ].filter(Boolean);

    if (orderedValues.length) {
      addManualField(fields, "Address", orderedValues.join(", "));
      fields.address_details = addressParts;
    }

    return skipped;
  }

  function addApplyToJobChoiceGroupFields(fields, form) {
    const seenNames = new Set();

    for (const control of form.querySelectorAll("input[type='checkbox'], input[type='radio']")) {
      if (!control.name || seenNames.has(control.name)) continue;
      seenNames.add(control.name);

      const group = control.closest(".form-group, fieldset") || control.parentElement;
      const groupLabel = group
        ? [...group.querySelectorAll("label.control-label, label")]
          .map((labelElement) => {
            if (labelElement.querySelector("input[type='checkbox'], input[type='radio']")) return "";
            const forValue = labelElement.getAttribute("for");
            if (forValue && forValue === control.id) return "";
            return labelTextBeforeRequiredStar(labelElement.textContent);
          })
          .find(Boolean)
        : "";
      const label = groupLabel || applyToJobLabelForControl(form, control);
      const values = [...form.querySelectorAll("input[type='checkbox'], input[type='radio']")]
        .filter((item) => item.name === control.name && item.checked)
        .map((item) => applyToJobChoiceLabel(item))
        .filter(Boolean);

      if (label && values.length && group) {
        addManualField(fields, label, values.length > 1 ? values : values[0]);
      }
    }
  }

  function collectApplyToJobManualFields() {
    const fields = {};
    const form = applyToJobApplicationForm();

    if (!form) return collectManualFields();

    const skipControls = addApplyToJobAddressField(fields, form);
    addApplyToJobChoiceGroupFields(fields, form);

    for (const control of form.querySelectorAll("input, textarea, select")) {
      if (skipControls.has(control)) continue;
      if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) {
        continue;
      }

      const label = applyToJobLabelForControl(form, control);
      const value = applyToJobValueForControl(form, control);

      if (label && value) {
        addManualField(fields, label, value);
      }
    }

    return fields;
  }

  function jobviteQuestionItems() {
    const selectors = [
      ".jv-apply-field",
      "[jv-apply-field]",
      "[class*='jv-apply-field']",
      ".jv-form-field",
      "[class*='jv-form-field-input']"
    ].join(",");

    return [...new Set([...document.querySelectorAll(selectors)]
      .map((item) => item.closest?.(".jv-form-field, [jv-apply-field], .jv-apply-field, [class*='jv-apply-field']") || item))]
      .filter((item) => item.querySelector("input, textarea, select, [contenteditable='true'], [role='combobox']"));
  }

  function addJobviteResumeField(fields) {
    const resumeSection = document.querySelector("#attachResume") ||
      [...document.querySelectorAll(".jv-apply-section, [class*='jv-apply-section'], section, div")]
        .find((element) => /add resume/i.test(cleanText(element.querySelector?.("h1,h2,h3")?.textContent)));

    const candidates = [
      ...(resumeSection
        ? resumeSection.querySelectorAll(".jv-file-list .jv-text-link, .jv-file-list span, .jv-file-list a, .jv-file span, .jv-file a")
        : []),
      ...document.querySelectorAll("#attachResume .jv-text-link, #attachResume .jv-file-list span, #attachResume .jv-file-list a, .jv-file-list .jv-text-link")
    ];

    for (const element of candidates) {
      const fileName = filenameFromUploadText(element.textContent);
      if (isFilenameValue(fileName)) {
        addManualField(fields, "Resume CV", fileName);
        return;
      }
    }
  }

  function jobviteLabelForQuestion(item) {
    const label = item.querySelector(".jv-form-field-label, label[class*='jv-form-field-label'], label");
    const text = labelTextBeforeRequiredStar(
      directTextWithoutControls(label) ||
      textWithoutControls(label) ||
      label?.textContent
    );
    if (text) return text;

    const control = item.querySelector("input, textarea, select");
    return control ? labelForControl(control) : "";
  }

  function jobviteChoiceLabel(control) {
    const label = control?.closest?.("label");
    const labelText = labelTextBeforeRequiredStar(textWithoutControls(label) || label?.textContent);
    if (labelText && labelText !== cleanText(control?.value)) return labelText;

    const siblingText = cleanText(control?.nextElementSibling?.textContent);
    if (siblingText) return siblingText;

    return cleanText(control?.value);
  }

  function jobviteFieldItemForControl(control) {
    return control?.closest?.(".jv-form-field, [jv-apply-field], .jv-apply-field, [class*='jv-apply-field']") ||
      control?.closest?.("div");
  }

  function jobviteLabelForControl(control) {
    const item = jobviteFieldItemForControl(control);
    const fromItem = item ? jobviteLabelForQuestion(item) : "";
    if (fromItem) return fromItem;

    const id = control?.id;
    if (id && typeof CSS !== "undefined" && CSS.escape) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      const text = labelTextBeforeRequiredStar(
        directTextWithoutControls(label) ||
        textWithoutControls(label) ||
        label?.textContent
      );
      if (text) return text;
    }

    return labelTextBeforeRequiredStar(
      cleanText(control?.getAttribute?.("aria-label")) ||
      cleanText(control?.getAttribute?.("autocomplete")) ||
      metadataLabelText(control)
    );
  }

  function addJobviteControlFields(fields) {
    const form = document.querySelector("form[name='scopeData.applyForm'], form.jv-form, .jv-form") || document;

    for (const control of form.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='combobox']")) {
      if (!isManualControl(control)) continue;
      if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) {
        continue;
      }

      const label = jobviteLabelForControl(control);
      const value = jobviteValueForControl(control);

      if (label && value) {
        addManualField(fields, label, value);
      }
    }
  }

  function jobviteVisibleUploadedFileName(control) {
    const field = control?.closest?.(".jv-apply-field, [jv-apply-field], [class*='jv-apply-field']") ||
      control?.parentElement;
    if (!field) return "";

    for (const element of field.querySelectorAll("p, span, a, div")) {
      const candidate = filenameFromUploadText(element.textContent);
      if (isFilenameValue(candidate)) {
        return candidate;
      }
    }

    return "";
  }

  function jobviteSelectValues(control) {
    const selectedOptions = [...control.selectedOptions];
    const values = selectedOptions
      .map((option) => cleanText(
        option.text ||
        option.label ||
        option.getAttribute?.("label") ||
        option.getAttribute?.("data-label") ||
        option.value
      ))
      .filter((value) => !isPlaceholderValue(value));

    const liveValue = cleanText(control.value || control.getAttribute("value"));
    if (liveValue && !isPlaceholderValue(liveValue) && !values.includes(liveValue)) {
      const matchingOption = [...control.options].find((option) => cleanText(option.value) === liveValue);
      const matchingText = cleanText(
        matchingOption?.text ||
        matchingOption?.label ||
        matchingOption?.getAttribute?.("label") ||
        matchingOption?.getAttribute?.("data-label")
      );
      values.push(matchingText && !isPlaceholderValue(matchingText) ? matchingText : liveValue);
    }

    return values;
  }

  function jobviteValueForControl(control) {
    if (!control || isSecurityControl(control)) return null;

    if (control instanceof HTMLInputElement) {
      if (["hidden", "button", "submit", "reset", "password"].includes(control.type)) return null;

      if (control.type === "checkbox" || control.type === "radio") {
        return control.checked ? jobviteChoiceLabel(control) : null;
      }

      if (control.type === "file") {
        const files = [...control.files].map((file) => file.name).filter(Boolean);
        if (files.length) return files.length > 1 ? files : files[0];

        const inputValueFileName = filenameFromFileInputValue(control.value || control.getAttribute("value"));
        if (inputValueFileName) return inputValueFileName;

        return jobviteVisibleUploadedFileName(control) || null;
      }

      return cleanText(control.value || control.getAttribute("value"));
    }

    if (control instanceof HTMLTextAreaElement) {
      return cleanText(control.value);
    }

    if (control instanceof HTMLSelectElement) {
      const values = jobviteSelectValues(control);
      return control.multiple ? values : values[0] || null;
    }

    return cleanText(
      control.getAttribute?.("aria-valuetext") ||
      control.getAttribute?.("title") ||
      control.textContent
    );
  }

  function jobviteValueForQuestion(item) {
    const values = [];
    const choiceControls = [...item.querySelectorAll("input[type='checkbox'], input[type='radio']")];

    if (choiceControls.length) {
      values.push(...choiceControls
        .filter((control) => control.checked)
        .map((control) => jobviteChoiceLabel(control)));
      return values.length > 1 ? values : values[0] || null;
    }

    for (const control of item.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='combobox']")) {
      const value = jobviteValueForControl(control);
      if (Array.isArray(value)) {
        values.push(...value);
      } else if (value) {
        values.push(value);
      }
    }

    return values.length > 1 ? values : values[0] || null;
  }

  function collectJobviteManualFields() {
    const fields = {};
    const items = jobviteQuestionItems();

    addJobviteResumeField(fields);
    addJobviteControlFields(fields);

    if (!items.length) return Object.keys(fields).length ? fields : collectManualFields();

    for (const item of items) {
      const label = jobviteLabelForQuestion(item);
      const value = jobviteValueForQuestion(item);

      if (label && value) {
        addManualField(fields, label, value);
      }
    }

    return fields;
  }

  function ripplingApplicationForm() {
    return document.querySelector("form") || document;
  }

  function ripplingQuestionItems() {
    const form = ripplingApplicationForm();
    const items = [...form.querySelectorAll("[data-testid='field'], [data-test-id='field']")]
      .filter((item) => item.querySelector("input, textarea, select, [contenteditable='true'], [role='combobox'], [role='radiogroup'], [role='radio'], [data-testid='chip'], [role='button']"));

    if (items.length) {
      return items.filter((item) => {
        return !items.some((other) => other !== item && other.contains(item));
      });
    }

    return [...form.querySelectorAll("label, div")]
      .filter((item) => item.querySelector("input, textarea, select, [contenteditable='true'], [role='combobox']"));
  }

  function ripplingLabelForQuestion(item) {
    const visibleQuestionText = ripplingVisibleQuestionText(item);
    if (visibleQuestionText) return visibleQuestionText;

    const customQuestionLabel = ripplingCustomQuestionLabelForItem(item);
    if (customQuestionLabel) return customQuestionLabel;

    for (const control of item.querySelectorAll("input, textarea, select, [role='combobox']")) {
      const ariaLabelledBy = cleanText(control.getAttribute?.("aria-labelledby"));
      const labelledText = cleanText(
        ariaLabelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent)
          .filter(Boolean)
          .join(" ")
      );
      const controlText = labelTextBeforeRequiredStar(
        labelledText ||
        control.getAttribute?.("aria-label") ||
        control.getAttribute?.("placeholder") ||
        control.getAttribute?.("name") ||
        control.id
      );
      if (controlText) return controlText;
    }

    const labelElement = item.querySelector("span[id$='-label'], label[id$='-label'], label");
    const text = labelTextBeforeRequiredStar(
      directTextWithoutControls(labelElement) ||
      textWithoutControls(labelElement) ||
      labelElement?.getAttribute?.("aria-label") ||
      labelElement?.textContent
    );
    if (text) return text;

    const dataTestId = cleanText(
      item.querySelector("input[data-testid], textarea[data-testid], select[data-testid], [role='combobox'][data-testid], label[data-testid]")?.getAttribute?.("data-testid") ||
      item.querySelector("input[data-test-id], textarea[data-test-id], select[data-test-id], [role='combobox'][data-test-id], label[data-test-id]")?.getAttribute?.("data-test-id") ||
      item.querySelector("[data-testid]:not([data-testid='field']), [data-test-id]:not([data-test-id='field'])")?.getAttribute?.("data-testid") ||
      item.querySelector("[data-testid]:not([data-testid='field']), [data-test-id]:not([data-test-id='field'])")?.getAttribute?.("data-test-id")
    );
    if (dataTestId) return titleFromSnakeLikeKey(dataTestId);

    return firstVisibleTextBeforeControl(item);
  }

  function ripplingVisibleQuestionText(item) {
    const radioQuestion = ripplingRadioQuestionText(item);
    if (radioQuestion) return radioQuestion;

    const text = cleanText(item.textContent);
    const starIndex = text.indexOf("*");
    if (starIndex > 0) {
      const requiredQuestion = labelTextBeforeRequiredStar(text);
      if (
        requiredQuestion &&
        !isRipplingPlaceholderValue(requiredQuestion) &&
        !/^(yes|no|clear selection)$/i.test(requiredQuestion)
      ) {
        return requiredQuestion;
      }
    }

    const beforeControl = firstVisibleTextBeforeControl(item);
    if (
      beforeControl &&
      !isRipplingPlaceholderValue(beforeControl) &&
      !/^(yes|no|clear selection)$/i.test(beforeControl)
    ) {
      return beforeControl;
    }

    return "";
  }

  function ripplingRadioQuestionText(item) {
    if (!item.querySelector("[role='radiogroup'], [role='radio'], input[type='radio'], input[type='checkbox']")) {
      return "";
    }

    const clone = item.cloneNode(true);
    clone
      .querySelectorAll("input, textarea, select, button, [role='radio'], [role='checkbox'], [role='button'], [data-testid='screen-reader-only'], [data-test-id='screen-reader-only'], svg")
      .forEach((element) => element.remove());

    const text = cleanText(clone.textContent)
      .replace(/\bYes\b.*$/i, "")
      .replace(/\bNo\b.*$/i, "")
      .replace(/\bClear selection\b.*$/i, "");
    const label = labelTextBeforeRequiredStar(text);

    if (
      label &&
      !isRipplingPlaceholderValue(label) &&
      !/^(yes|no|clear selection|yesno)$/i.test(label)
    ) {
      return label;
    }

    return ripplingNearbyChoiceQuestionText(item);
  }

  function ripplingTextWithoutInteractiveContent(element) {
    if (!element) return "";

    const clone = element.cloneNode(true);
    clone
      .querySelectorAll([
        "input",
        "textarea",
        "select",
        "button",
        "svg",
        "[role='radio']",
        "[role='checkbox']",
        "[role='button']",
        "[role='combobox']",
        "[role='listbox']",
        "[data-testid='screen-reader-only']",
        "[data-test-id='screen-reader-only']",
        "[data-testid*='tip']",
        "[data-test-id*='tip']"
      ].join(","))
      .forEach((child) => child.remove());

    return cleanText(clone.textContent);
  }

  function ripplingQuestionCandidateFromText(value) {
    let text = cleanText(value)
      .replace(/\bClear selection\b.*$/i, "")
      .replace(/\bYes\b\s*$/i, "")
      .replace(/\bNo\b\s*$/i, "");

    text = labelTextBeforeRequiredStar(text) || text;
    text = cleanText(text);

    if (!text || text.length < 10) return "";
    if (isRipplingPlaceholderValue(text)) return "";
    if (/^(yes|no|clear selection|yesno)$/i.test(text)) return "";
    if (/drop or select|total\s+\d+\s+file|preview file|remove file|\.(doc|docx|pdf)\b/i.test(text)) return "";
    if (/\b\d+\s*\/\s*\d+\b/.test(text)) return "";

    return text;
  }

  function ripplingNearbyChoiceQuestionText(item) {
    const fieldWrapper = item.closest("[data-testid='field'], [data-test-id='field']") || item;
    const seen = new Set();

    for (let ancestor = fieldWrapper; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      let sibling = ancestor.previousElementSibling;
      for (let steps = 0; sibling && steps < 8; steps += 1, sibling = sibling.previousElementSibling) {
        if (seen.has(sibling)) continue;
        seen.add(sibling);

        const directCandidate = ripplingQuestionCandidateFromText(
          directTextWithoutControls(sibling) ||
          ripplingTextWithoutInteractiveContent(sibling)
        );
        if (directCandidate) return directCandidate;

        const nestedCandidates = [
          ...sibling.querySelectorAll("label, span[id$='-label'], h1, h2, h3, h4, h5, p, div")
        ].reverse();
        for (const nested of nestedCandidates) {
          const candidate = ripplingQuestionCandidateFromText(
            directTextWithoutControls(nested) ||
            ripplingTextWithoutInteractiveContent(nested)
          );
          if (candidate) return candidate;
        }
      }
    }

    return "";
  }

  function ripplingCustomQuestionIdForItem(item) {
    const control = item.querySelector("input, textarea, select, [role='combobox'], [role='radiogroup'], [role='radio']");
    const values = [
      control?.getAttribute?.("data-testid"),
      control?.getAttribute?.("data-test-id"),
      control?.getAttribute?.("name"),
      control?.id
    ].map(cleanText).filter(Boolean);

    for (const value of values) {
      const match = value.match(/customQuestions\.([a-z0-9-]+)/i);
      if (match) return match[1];
    }

    return "";
  }

  function ripplingCustomQuestionLabelForItem(item) {
    const questionId = ripplingCustomQuestionIdForItem(item);
    if (!questionId) return "";

    const label = [...document.querySelectorAll("[id^='label-customQuestions']")]
      .find((element) => {
        const id = cleanText(element.id);
        const text = labelTextBeforeRequiredStar(element.textContent);
        return id.includes(questionId) &&
          text &&
          text.length > 10 &&
          !/^(yes|no|clear selection|yesno)$/i.test(text);
      });
    const labelText = labelTextBeforeRequiredStar(label?.textContent);
    if (labelText) return labelText;

    const fieldWrapper = item.closest("[data-testid='field'], [data-test-id='field']") || item;
    let cursor = fieldWrapper.previousElementSibling;
    for (let steps = 0; cursor && steps < 5; steps += 1, cursor = cursor.previousElementSibling) {
      const text = labelTextBeforeRequiredStar(cursor.textContent);
      if (
        text &&
        !isRipplingPlaceholderValue(text) &&
        !text.includes("0/") &&
        !/^(yes|no|clear selection)$/i.test(text)
      ) {
        return text;
      }
    }

    return "";
  }

  function ripplingChoiceLabel(control) {
    const dataValue = cleanText(control?.getAttribute?.("data-value"));
    if (dataValue) return dataValue;

    const label = control?.closest?.("label");
    const labelText = labelTextBeforeRequiredStar(textWithoutControls(label) || label?.textContent);
    if (labelText && labelText !== cleanText(control?.value)) return labelText;

    const siblingText = cleanText(control?.nextElementSibling?.textContent);
    if (siblingText) return siblingText;

    const ariaLabelledBy = cleanText(control?.getAttribute?.("aria-labelledby"));
    const labelledText = cleanText(
      ariaLabelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent)
        .filter(Boolean)
        .join(" ")
    );
    if (labelledText) return labelledText;

    return cleanText(control?.value);
  }

  function ripplingSelectedChoiceValues(item) {
    const values = [];

    for (const control of item.querySelectorAll("input[type='checkbox'], input[type='radio']")) {
      if (control.checked || control.matches?.(":checked")) {
        values.push(ripplingChoiceLabel(control));
      }
    }

    for (const radio of item.querySelectorAll("[role='radio'][aria-checked='true'], [role='checkbox'][aria-checked='true']")) {
      values.push(ripplingChoiceLabel(radio));
    }

    return [...new Set(values.map(cleanText).filter(Boolean))];
  }

  function ripplingVisibleUploadedFileNames(item) {
    const preferredValues = [];
    const fallbackValues = [];
    const preferredSelectors = [
      "[data-testid='chip']",
      "[data-test-id='chip']",
      "[id^='chip-'][id$='content']",
      "[aria-label*='Preview file']",
      "[aria-label*='preview file']"
    ].join(",");

    for (const element of item.querySelectorAll(preferredSelectors)) {
      const candidate = filenameFromUploadText(
        cleanText(element.getAttribute?.("aria-label")).replace(/^preview file\s*:\s*/i, "") ||
        element.textContent
      );
      if (isFilenameValue(candidate)) preferredValues.push(candidate);
    }

    if (preferredValues.length) return [...new Set(preferredValues)];

    const fallbackSelectors = [
      "[data-testid*='file']",
      "[data-test-id*='file']",
      "span",
      "p",
      "a"
    ].join(",");

    for (const element of item.querySelectorAll(fallbackSelectors)) {
      const text = cleanText(element.textContent);
      if (!text || text.length > 180) continue;
      const candidate = filenameFromUploadText(text);
      if (isFilenameValue(candidate)) fallbackValues.push(candidate);
    }

    for (const element of item.querySelectorAll("span, div, p, a")) {
      const text = cleanText(element.textContent);
      if (!text || text.length > 120) continue;
      const candidate = filenameFromUploadText(text);
      if (isFilenameValue(candidate)) fallbackValues.push(candidate);
    }

    return [...new Set(fallbackValues)];
  }

  function isRipplingPlaceholderValue(value) {
    const text = cleanText(value).toLowerCase();
    return isPlaceholderValue(text) ||
      text === "search" ||
      text === "textbox" ||
      text === "true" ||
      text === "false" ||
      text === "type to search" ||
      text === "start typing";
  }

  function isRipplingSkippableFieldLabel(label) {
    const text = cleanText(label).toLowerCase();
    const key = labelToKey(label);
    return !key ||
      key === "search" ||
      key === "textbox" ||
      key === "select" ||
      key === "clear_selection" ||
      key === "cover_letter" ||
      key.startsWith("cover_letter_") ||
      text.startsWith("cover letter ");
  }

  function isRipplingCoverLetterItem(item, label) {
    const labelText = cleanText(label).toLowerCase();
    const metadata = cleanText([
      label,
      item?.getAttribute?.("data-testid"),
      item?.getAttribute?.("data-test-id"),
      item?.querySelector?.("[data-testid='cover_letter'], [data-test-id='cover_letter']")?.getAttribute?.("data-testid"),
      item?.querySelector?.("[data-testid='cover_letter'], [data-test-id='cover_letter']")?.getAttribute?.("data-test-id"),
      item?.querySelector?.("input[data-testid='input-cover_letter'], input[data-test-id='input-cover_letter']")?.getAttribute?.("data-testid"),
      item?.querySelector?.("input[data-testid='input-cover_letter'], input[data-test-id='input-cover_letter']")?.getAttribute?.("data-test-id")
    ].filter(Boolean).join(" ")).toLowerCase();

    return labelToKey(label) === "cover_letter" ||
      labelText.startsWith("cover letter ") ||
      /\bcover[_\s-]?letter\b/.test(metadata);
  }

  function ripplingCustomSelectValues(item, label) {
    const values = [];
    const controls = item.querySelectorAll([
      "[role='combobox']",
      "[aria-haspopup='listbox']",
      "[aria-haspopup='true']",
      "button",
      "[role='button']"
    ].join(","));

    for (const control of controls) {
      if (control.closest?.("label[data-testid='cover_letter'], label[data-test-id='cover_letter'], label[data-testid='resume'], label[data-test-id='resume']")) {
        continue;
      }

      if (control.matches?.("input, textarea, select")) {
        const controlText = cleanText(
          control.getAttribute?.("aria-valuetext") ||
          control.getAttribute?.("aria-label") ||
          control.value ||
          control.getAttribute?.("value")
        );
        if (!controlText || isRipplingPlaceholderValue(controlText)) continue;
        if (label && controlText === cleanText(label)) continue;
        values.push(controlText);
        continue;
      }

      const text = cleanText(
        control.getAttribute?.("aria-valuetext") ||
        control.getAttribute?.("aria-label") ||
        control.textContent
      );
      if (!text || isRipplingPlaceholderValue(text)) continue;
      if (label && text === cleanText(label)) continue;
      if (/^(remove|delete|clear|open|close)$/i.test(text)) continue;
      if (/drop or select|\.(doc|docx|pdf)|total\s+0\s+file\s+selected/i.test(text)) continue;

      values.push(text);
    }

    return [...new Set(values)];
  }

  function ripplingValueForQuestion(item) {
    const values = [];
    const label = ripplingLabelForQuestion(item);
    const labelKey = labelToKey(label);
    const isFileField = shouldNormalizeFileFieldKey(labelKey);

    const uploadedFileNames = ripplingVisibleUploadedFileNames(item);
    values.push(...uploadedFileNames);
    if (!isFileField) {
      values.push(...ripplingCustomSelectValues(item, label));
    }
    values.push(...ripplingSelectedChoiceValues(item));

    for (const control of item.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='combobox']")) {
      if (isSecurityControl(control)) continue;

      if (control instanceof HTMLInputElement) {
        if (["hidden", "button", "submit", "reset", "password"].includes(control.type)) continue;

        if (control.type === "checkbox" || control.type === "radio") {
          if (control.checked) values.push(ripplingChoiceLabel(control));
          continue;
        }

        if (control.type === "file") {
          values.push(...[...control.files].map((file) => file.name));
          if (control.files?.length) {
            const inputValueFileName = filenameFromFileInputValue(control.value || control.getAttribute("value"));
            if (inputValueFileName) values.push(inputValueFileName);
          }
          continue;
        }

        values.push(control.value || control.getAttribute("value"));
        continue;
      }

      if (control instanceof HTMLTextAreaElement) {
        values.push(control.value);
        continue;
      }

      if (control instanceof HTMLSelectElement) {
        values.push(
          ...[...control.selectedOptions]
            .map((option) => cleanText(option.text || option.value))
            .filter((value) => !isPlaceholderValue(value))
        );
        continue;
      }

      const customValue = cleanText(
        control.getAttribute?.("aria-valuetext") ||
        control.getAttribute?.("title") ||
        control.textContent
      );
      if (customValue && !isRipplingPlaceholderValue(customValue)) values.push(customValue);
    }

    const normalizedValues = values
      .map(cleanText)
      .map((value) => isFileField ? filenameFromUploadText(value) : value)
      .filter(Boolean)
      .filter((value) => !isRipplingPlaceholderValue(value))
      .filter((value) => !isFileField || isFilenameValue(value))
      .filter((value) => !isInternalIdValue(value));

    const uniqueValues = [...new Set(normalizedValues)];
    if (isFileField && !uniqueValues.length) return "";

    if (labelKey === "phone_number" || labelKey === "phone") {
      const countryCode = uniqueValues.find((value) => /^\+\d+\s*[A-Z]{2,3}$/i.test(value));
      const localNumber = uniqueValues.find((value) => /\d/.test(value) && !/^\+\d+\s*[A-Z]{2,3}$/i.test(value));
      if (countryCode && localNumber) {
        return `${countryCode.replace(/\s*[A-Z]{2,3}$/i, "")} ${localNumber}`;
      }
    }

    if (labelKey === "location") {
      const locationValue = uniqueValues
        .filter((value) => !/^textbox$/i.test(value))
        .find((value) => /,/.test(value)) ||
        uniqueValues.find((value) => !/^textbox$/i.test(value));
      return locationValue || null;
    }

    return uniqueValues.length > 1 ? uniqueValues : uniqueValues[0] || null;
  }

  function collectRipplingManualFields() {
    const fields = {};
    const items = ripplingQuestionItems();

    if (!items.length) return collectManualFields();

    for (const item of items) {
      const label = ripplingLabelForQuestion(item);
      if (isRipplingCoverLetterItem(item, label)) continue;
      if (isRipplingSkippableFieldLabel(label)) continue;

      const value = ripplingValueForQuestion(item);

      if (label && value) {
        addManualField(fields, label, value);
      }
    }

    return Object.keys(fields).length ? fields : collectManualFields();
  }

  function recruiteeLabelForControl(form, control) {
    const controlId = control?.id;

    if (controlId && typeof CSS !== "undefined" && CSS.escape) {
      const label = form?.querySelector?.(`label[for="${CSS.escape(controlId)}"]`);
      const text = labelTextBeforeRequiredStar(label?.textContent);
      if (text) return text;
    }

    const closestLabel = control?.closest?.("label");
    const closestLabelText = labelTextBeforeRequiredStar(closestLabel?.textContent);
    if (closestLabelText) return closestLabelText;

    const sectionLabel = control
      ?.closest?.("section, fieldset, [class]")
      ?.querySelector?.("label");
    const sectionLabelText = labelTextBeforeRequiredStar(sectionLabel?.textContent);
    if (sectionLabelText) return sectionLabelText;

    return labelTextBeforeRequiredStar(
      control?.getAttribute?.("aria-label") ||
      control?.getAttribute?.("placeholder") ||
      control?.getAttribute?.("name") ||
      controlId
    );
  }

  function isRecruiteeCoverLetterControl(control, label) {
    const text = cleanText(label).toLowerCase();
    const metadata = cleanText([
      label,
      control?.id,
      control?.name,
      control?.getAttribute?.("data-cy"),
      control?.getAttribute?.("aria-describedby"),
      control?.closest?.("section")?.textContent
    ].filter(Boolean).join(" ")).toLowerCase();

    return labelToKey(label) === "cover_letter" ||
      text.startsWith("cover letter") ||
      /\bcover\s*letter\b|coverletter/i.test(metadata);
  }

  function recruiteeVisibleUploadedFileName(control) {
    const values = [];
    const wrapper = control?.closest?.("section, fieldset, div") || control?.parentElement;

    values.push(...[...(control?.files || [])].map((file) => file.name));

    for (const element of wrapper?.querySelectorAll?.("[title], span, div, p") || []) {
      const titleCandidate = filenameFromUploadText(element.getAttribute?.("title"));
      if (isFilenameValue(titleCandidate)) values.push(titleCandidate);

      const textCandidate = filenameFromUploadText(element.textContent);
      if (isFilenameValue(textCandidate)) values.push(textCandidate);
    }

    return [...new Set(values.map(filenameFromUploadText).filter(isFilenameValue))][0] || "";
  }

  function recruiteeValueForControl(control, label) {
    if (isSecurityControl(control)) return null;

    if (control instanceof HTMLInputElement) {
      if (["hidden", "button", "submit", "reset", "password"].includes(control.type)) return null;

      if (control.type === "file") {
        if (isRecruiteeCoverLetterControl(control, label)) return null;
        return recruiteeVisibleUploadedFileName(control) || null;
      }

      if (control.type === "checkbox" || control.type === "radio") {
        if (!control.checked) return null;
        return labelTextBeforeRequiredStar(textWithoutControls(control.closest("label")) || control.value);
      }

      return cleanText(control.value || control.getAttribute("value"));
    }

    if (control instanceof HTMLTextAreaElement) {
      return cleanText(control.value);
    }

    if (control instanceof HTMLSelectElement) {
      const values = [...control.selectedOptions]
        .map((option) => cleanText(option.text || option.value))
        .filter((value) => !isPlaceholderValue(value));
      return control.multiple ? values : values[0] || null;
    }

    return null;
  }

  function collectRecruiteeManualFields() {
    const fields = {};
    const form = recruiteeApplicationForm();
    if (!form) return collectManualFields();

    for (const control of form.querySelectorAll("input, textarea, select")) {
      const label = recruiteeLabelForControl(form, control);
      if (!label || isRecruiteeCoverLetterControl(control, label)) continue;

      const value = recruiteeValueForControl(control, label);
      if (value) addManualField(fields, label, value);
    }

    return Object.keys(fields).length ? fields : collectManualFields();
  }

  function bambooHrApplicationForm() {
    return document.querySelector("form#job-application-form") ||
      document.querySelector("form");
  }

  function bambooHrLabelForControl(form, control) {
    const labels = [];
    const controlId = control?.id;

    if (controlId && typeof CSS !== "undefined" && CSS.escape) {
      const selector = `label[for="${CSS.escape(controlId)}"]`;
      const label = form?.querySelector?.(selector) || document.querySelector(selector);
      if (label) labels.push(label);
    }

    const wrapper = control?.closest?.("[data-fabric-component='TextField InputWrapper'], [data-fabric-component='DatePicker'], [data-fabric-component='SelectField InputWrapper'], .MuiFormControl-root, [class*='MuiFormControl-root']");
    const wrapperLabel = wrapper?.querySelector?.("label");
    if (wrapperLabel) labels.push(wrapperLabel);

    const closestLabel = control?.closest?.("label");
    if (closestLabel) labels.push(closestLabel);

    for (const label of labels) {
      const text = labelTextBeforeRequiredStar(
        directTextWithoutControls(label) ||
        textWithoutControls(label) ||
        label.textContent
      );
      if (text) return text;
    }

    return metadataLabelText(control);
  }

  function bambooHrVisibleSelectValue(control) {
    const wrapper = control?.closest?.("[data-fabric-component='SelectField InputWrapper'], .MuiFormControl-root, [class*='MuiFormControl-root']") ||
      control?.parentElement;
    const button = wrapper?.querySelector?.("button[aria-label], [role='button'][aria-label]");
    const ariaLabel = cleanText(button?.getAttribute?.("aria-label"));
    if (!ariaLabel) return "";

    const label = bambooHrLabelForControl(bambooHrApplicationForm(), control);
    const labelPattern = label ? new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i") : null;
    const value = labelPattern ? cleanText(ariaLabel.replace(labelPattern, "")) : ariaLabel;

    return isPlaceholderValue(value) ? "" : value;
  }

  function bambooHrValueForControl(control) {
    if (!control || isSecurityControl(control)) return null;

    if (control instanceof HTMLInputElement) {
      if (["hidden", "button", "submit", "reset", "password"].includes(control.type)) return null;

      if (control.type === "checkbox" || control.type === "radio") {
        return control.checked ? optionTextForChoice(control) : null;
      }

      if (control.type === "file") {
        const files = [...control.files].map((file) => file.name).filter(Boolean);
        if (files.length) return files.length > 1 ? files : files[0];
        return filenameFromFileInputValue(control.value || control.getAttribute("value")) || null;
      }

      return cleanText(control.value || control.getAttribute("value"));
    }

    if (control instanceof HTMLTextAreaElement) {
      return cleanText(control.value);
    }

    if (control instanceof HTMLSelectElement) {
      const visibleValue = bambooHrVisibleSelectValue(control);
      if (visibleValue) return visibleValue;

      const values = [...control.selectedOptions]
        .map((option) => cleanText(option.text || option.label || option.value))
        .filter((value) => !isPlaceholderValue(value));
      return control.multiple ? values : values[0] || null;
    }

    return cleanText(
      control.getAttribute?.("aria-valuetext") ||
      control.getAttribute?.("title") ||
      control.textContent
    );
  }

  function addBambooHrResumeField(fields, root) {
    const uploadLists = [
      ...root.querySelectorAll("[data-fabric-component='FileUploadList'], [data-fabric-component='FileUpload']")
    ];

    for (const uploadList of uploadLists) {
      const container = uploadList.closest("[class*='MuiBox-root'], [data-fabric-component='Flex'], div") ||
        uploadList.parentElement;
      const labelText = cleanText(
        container?.querySelector?.("[data-fabric-component='BodyText']")?.textContent ||
        uploadList.closest?.("[class*='grid']")?.querySelector?.("[data-fabric-component='BodyText']")?.textContent ||
        "Resume"
      );

      if (!/resume|cv/i.test(labelText)) continue;

      for (const element of uploadList.querySelectorAll("span, a, div")) {
        const fileName = filenameFromUploadText(element.textContent);
        if (isFilenameValue(fileName)) {
          addManualField(fields, "Resume CV", fileName);
          return;
        }
      }
    }
  }

  function bambooHrChoiceOptionLabel(control) {
    const label = control?.closest?.("label");
    const explicitOption = label?.querySelector?.(".MuiFormControlLabel-label, [class*='FormControlLabel-label']");
    const explicitText = cleanText(explicitOption?.textContent);
    if (explicitText) return explicitText;

    const labelText = textWithoutControls(label) || label?.textContent;
    const cleaned = labelTextBeforeRequiredStar(labelText);
    if (cleaned && cleaned !== cleanText(control?.value)) return cleaned;

    return cleanText(control?.value);
  }

  function bambooHrChoiceIsChecked(control) {
    if (control?.checked) return true;

    const directControlWrapper = control?.parentElement;
    if (
      directControlWrapper?.matches?.(".Mui-checked, [class*='Mui-checked'], [aria-checked='true']") ||
      directControlWrapper?.getAttribute?.("aria-checked") === "true"
    ) {
      return true;
    }

    const fabricControl = control?.closest?.("[data-fabric-component='Radio'], [data-fabric-component='Checkbox']");
    if (!fabricControl || fabricControl.contains(control) === false) return false;

    return fabricControl === directControlWrapper &&
      (
        fabricControl.matches?.(".Mui-checked, [class*='Mui-checked'], [aria-checked='true']") ||
        fabricControl.getAttribute?.("aria-checked") === "true"
      );
  }

  function addBambooHrChoiceGroupFields(fields, root) {
    for (const fieldset of root.querySelectorAll("fieldset")) {
      const controls = [...fieldset.querySelectorAll("input[type='radio'], input[type='checkbox']")];
      if (!controls.length) continue;

      const legend = fieldset.querySelector("legend");
      const label = labelTextBeforeRequiredStar(
        directTextWithoutControls(legend) ||
        textWithoutControls(legend) ||
        legend?.textContent
      );
      if (!label) continue;

      const values = controls
        .filter((control) => bambooHrChoiceIsChecked(control))
        .map((control) => bambooHrChoiceOptionLabel(control))
        .filter(Boolean);

      if (values.length) {
        addManualField(fields, label, values.length > 1 ? values : values[0]);
      }
    }
  }

  function collectBambooHrManualFields() {
    const fields = {};
    const form = bambooHrApplicationForm();
    const root = form || document;

    addBambooHrResumeField(fields, root);
    addBambooHrChoiceGroupFields(fields, root);

    for (const control of root.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='combobox']")) {
      if (!isManualControl(control)) continue;
      if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) {
        continue;
      }

      const label = bambooHrLabelForControl(form, control);
      const value = bambooHrValueForControl(control);

      if (label && value) {
        addManualField(fields, label, value);
      }
    }

    return Object.keys(fields).length ? fields : collectManualFields();
  }

  function isVisibleElement(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || Boolean(cleanText(element.textContent));
  }

  function workdayReviewContainer() {
    return [...document.querySelectorAll(".css-g7hkny")]
      .find((element) => isVisibleElement(element) && cleanText(element.textContent));
  }

  function visibleTextLines(element) {
    const text = element?.innerText || element?.textContent || "";
    return text
      .split(/\r?\n/)
      .map(cleanText)
      .filter(Boolean);
  }

  function workdayEmphasizedTextSet(container) {
    const emphasized = new Set();

    for (const element of container.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading'],label,strong,b")) {
      if (!isVisibleElement(element)) continue;
      const text = cleanText(element.textContent);
      if (text) emphasized.add(text);
    }

    for (const element of container.querySelectorAll("*")) {
      if (!isVisibleElement(element)) continue;
      const text = cleanText(element.textContent);
      if (!text || text.length > 180) continue;

      const weight = Number.parseInt(getComputedStyle(element).fontWeight, 10);
      if (Number.isFinite(weight) && weight >= 600) {
        emphasized.add(text);
      }
    }

    return emphasized;
  }

  function isWorkdayReviewHeadingVisible() {
    return [...document.querySelectorAll("h1,h2,h3,[role='heading']")]
      .some((element) => isVisibleElement(element) && cleanText(element.textContent).toLowerCase().includes("review"));
  }

  function isWorkdayShortAnswer(value) {
    const text = cleanText(value).toLowerCase();
    return /^(yes|no|n\/a|none|true|false)$/i.test(text) ||
      /^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(text) ||
      /^\+?[0-9][0-9\s().-]{5,}$/.test(text) ||
      /^https?:\/\//i.test(text) ||
      /^www\./i.test(text);
  }

  function isLikelyWorkdayValue(text) {
    const value = cleanText(text);
    if (!value) return false;
    if (isWorkdayShortAnswer(value)) return true;
    if (/,/.test(value)) return true;
    if (/\d/.test(value) && value.length < 120) return true;
    if (/united states|america|mobile|linkedin/i.test(value)) return true;
    return false;
  }

  function isWorkdaySectionAt(lines, index, emphasizedTexts) {
    const text = cleanText(lines[index]);
    const next = cleanText(lines[index + 1]);
    const afterNext = cleanText(lines[index + 2]);

    if (!text || /^review$/i.test(text)) return false;
    if (isWorkdayRepeatedGroupHeading(text)) return false;
    if (isCommonWorkdayFieldLabel(text)) return false;
    if (!next || !afterNext) return false;
    if (text.endsWith("?")) return false;
    if (!emphasizedTexts.has(text)) return false;
    if (isLikelyWorkdayValue(text)) return false;

    return isWorkdayLabelAt(lines, index + 1, emphasizedTexts);
  }

  function isCommonWorkdayFieldLabel(text) {
    return new Set([
      "job_title",
      "company",
      "location",
      "i_currently_work_here",
      "from",
      "to",
      "role_description",
      "legal_name",
      "address",
      "email_address",
      "phone"
    ]).has(labelToKey(text));
  }

  function isWorkdayApplicationQuestionsSection(sectionKey) {
    return /application_questions/i.test(sectionKey);
  }

  function isWorkdayRequiredQuestion(text) {
    return /\*\s*$/.test(cleanText(text));
  }

  function workdayFieldKey(label) {
    const text = cleanText(label);
    if (text.length > 200) {
      return `${text.slice(0, 200)} ....`;
    }

    return labelToKey(text);
  }

  function workdayQuestionKey(label) {
    const text = cleanText(label);
    if (!text) return "";
    if (text.length > 200) return `${text.slice(0, 200)} ....`;
    return text;
  }

  function workdayRepeatedGroupMatch(text) {
    return cleanText(text).match(/^(.+?)\s+([0-9]+)$/);
  }

  function isWorkdayRepeatedGroupHeading(text) {
    const match = workdayRepeatedGroupMatch(text);
    if (!match) return false;

    const groupName = labelToKey(match[1]);
    return Boolean(groupName);
  }

  function workdayRepeatedGroupKeys(text) {
    const match = workdayRepeatedGroupMatch(text);
    if (!match) return null;

    const parentKey = labelToKey(match[1]);
    const itemKey = labelToKey(`${match[1]} ${match[2]}`);
    if (!parentKey || !itemKey) return null;

    return { parentKey, itemKey };
  }

  function isWorkdayLabelAt(lines, index, emphasizedTexts) {
    const text = cleanText(lines[index]);
    const next = cleanText(lines[index + 1]);

    if (!text || !next || /^review$/i.test(text)) return false;
    if (isWorkdayRepeatedGroupHeading(text)) return false;
    if (isWorkdaySectionAt(lines, index, emphasizedTexts)) return false;
    if (text.length > 180) return false;

    return emphasizedTexts.has(text) ||
      text.endsWith("?") ||
      (isWorkdayShortAnswer(next) && !isLikelyWorkdayValue(text));
  }

  function workdayLabelRowAt(lines, index, emphasizedTexts) {
    const labels = [];
    let cursor = index;

    while (
      cursor < lines.length &&
      labels.length < 4 &&
      isWorkdayLabelAt(lines, cursor, emphasizedTexts)
    ) {
      labels.push(lines[cursor]);
      cursor += 1;
    }

    if (labels.length < 2) return null;

    const values = [];
    while (
      cursor < lines.length &&
      values.length < labels.length &&
      !workdayRepeatedGroupKeys(lines[cursor]) &&
      !isWorkdaySectionAt(lines, cursor, emphasizedTexts) &&
      !isWorkdayLabelAt(lines, cursor, emphasizedTexts)
    ) {
      values.push(lines[cursor]);
      cursor += 1;
    }

    if (values.length !== labels.length) return null;

    return {
      nextIndex: cursor,
      pairs: labels.map((label, labelIndex) => ({
        label,
        value: values[labelIndex]
      }))
    };
  }

  function parseWorkdayApplicationQuestions(lines, index, emphasizedTexts, target) {
    const question = cleanText(lines[index]);
    if (!isWorkdayRequiredQuestion(question)) {
      return { handled: true, nextIndex: index + 1 };
    }

    const answers = [];
    let cursor = index + 1;

    while (cursor < lines.length) {
      const text = cleanText(lines[cursor]);

      if (!text) {
        cursor += 1;
        continue;
      }

      if (isWorkdayRequiredQuestion(text)) break;
      if (workdayRepeatedGroupKeys(text)) break;
      if (isWorkdaySectionAt(lines, cursor, emphasizedTexts)) break;

      answers.push(text);
      cursor += 1;
    }

    setWorkdayQuestionValue(target, question, answers);

    return {
      handled: true,
      nextIndex: Math.max(cursor, index + 1)
    };
  }

  function setWorkdayReviewValue(fields, sectionKey, target, label, value) {
    const fieldKey = workdayFieldKey(label);
    const normalizedValues = (Array.isArray(value) ? value : [value])
      .map(cleanText)
      .map((item) => shouldNormalizeFileFieldKey(fieldKey) ? filenameFromUploadText(item) : item)
      .filter(Boolean)
      .filter((item) => !shouldNormalizeFileFieldKey(fieldKey) || isFilenameValue(item))
      .filter((item) => !isPlaceholderValue(item));

    if (!fieldKey || !normalizedValues.length) return;

    const nextValue = normalizedValues.length > 1
      ? normalizedValues.join(", ")
      : normalizedValues[0];

    target[fieldKey] = nextValue;
    deriveWorkdaySummaryFields(fields, sectionKey, fieldKey, nextValue);
  }

  function setWorkdayQuestionValue(target, question, answerLines) {
    const questionKey = workdayQuestionKey(question);
    const normalizedValues = (Array.isArray(answerLines) ? answerLines : [answerLines])
      .map(cleanText)
      .filter(Boolean)
      .filter((item) => !isPlaceholderValue(item));

    if (!questionKey || !normalizedValues.length) return;

    target[questionKey] = normalizedValues.length > 1
      ? normalizedValues.join("\n")
      : normalizedValues[0];
  }

  function addWorkdaySummaryField(fields, key, value) {
    const text = Array.isArray(value) ? value.join(", ") : cleanText(value);
    if (text && !fields[key]) {
      fields[key] = text;
    }
  }

  function deriveWorkdaySummaryFields(fields, sectionKey, fieldKey, value) {
    if (fieldKey === "legal_name" || fieldKey === "name" || fieldKey === "full_name") {
      addWorkdaySummaryField(fields, "name", value);
    }

    if (fieldKey === "email_address" || fieldKey === "email") {
      addWorkdaySummaryField(fields, "email", value);
    }

    if (fieldKey === "phone" || fieldKey === "phone_number" || fieldKey === "mobile_phone") {
      addWorkdaySummaryField(fields, "phone_number", value);
    }

    if (fieldKey === "address" || sectionKey === "address") {
      addWorkdaySummaryField(fields, "address", value);
    }

    if (shouldNormalizeFileFieldKey(fieldKey)) {
      addWorkdaySummaryField(fields, "resume_cv", value);
    }
  }

  function workdayReviewSections() {
    const sections = [...document.querySelectorAll("div[aria-labelledby]")]
      .filter((element) => {
        const labelledBy = cleanText(element.getAttribute("aria-labelledby"));
        return labelledBy.includes("section") && isVisibleElement(element) && cleanText(element.textContent);
      });

    return sections.filter((section) => {
      return !sections.some((other) => other !== section && other.contains(section));
    });
  }

  function workdayReviewRootElement() {
    return document.querySelector("[data-automation-id='applyFlowReviewPage']") ||
      workdayReviewContainer() ||
      document.body;
  }

  function workdayHeadingLevel(element) {
    const match = cleanText(element?.tagName).match(/^H([1-6])$/i);
    return match ? Number(match[1]) : 7;
  }

  function workdayDomKey(label) {
    const text = cleanText(label);
    if (!text) return "";
    if (text.length > 200) return `${text.slice(0, 200)} ....`;
    return labelToKey(text);
  }

  function workdayNodeValueText(element) {
    return cleanText(element?.textContent)
      .replace(/\s+,\s+/g, ", ");
  }

  function workdayDirectValueSpans(section) {
    const values = [];

    for (const span of section.querySelectorAll("span")) {
      if (!isVisibleElement(span)) continue;

      const nestedSection = span.closest("div[aria-labelledby]");
      if (nestedSection && nestedSection !== section) continue;

      const text = workdayNodeValueText(span);
      if (text && !isPlaceholderValue(text)) {
        values.push(text);
      }
    }

    return [...new Set(values)];
  }

  function addWorkdayUploadFields(fields) {
    const root = workdayReviewRootElement();
    if (!root) return;

    const uploadNames = [...root.querySelectorAll(
      "[data-automation-id='file-upload-item-name'], " +
      "[data-automation-id='arialiveMessage'], " +
      "[data-automation-id*='file-upload'] span, " +
      "[data-automation-id*='attachment'] span"
    )]
      .filter(isVisibleElement)
      .map((element) => filenameFromUploadText(element.textContent))
      .filter(isFilenameValue);

    const uniqueNames = [...new Set(uploadNames)];
    if (!uniqueNames.length) return;

    const section = root.querySelector("[aria-labelledby*='Resume'][aria-labelledby*='section'], [aria-labelledby*='CV'][aria-labelledby*='section']") ||
      root.querySelector("[data-automation-id*='resume'], [data-automation-id*='Resume'], [data-automation-id*='attachment']");
    const heading = section?.querySelector?.("h1,h2,h3,h4,h5,label,[role='heading']");
    const label = cleanText(heading?.textContent) || "Resume/CV";
    const categoryKey = workdayDomKey(label) || "resume_cv";

    if (!fields.workday_review[categoryKey] || typeof fields.workday_review[categoryKey] !== "object") {
      fields.workday_review[categoryKey] = {};
    }

    setWorkdayDomValue(fields, categoryKey, fields.workday_review[categoryKey], label, uniqueNames[0]);
    fields.resume_cv = uniqueNames[0];
  }

  function workdayNearestCategoryLabel(section, root) {
    const headings = [...root.querySelectorAll("h1,h2,h3,[role='heading']")]
      .filter((element) => isVisibleElement(element) && !section.contains(element))
      .filter((element) => {
        const text = cleanText(element.textContent);
        return text && !/^review$/i.test(text);
      })
      .filter((element) => {
        const position = element.compareDocumentPosition(section);
        return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
      });

    const nearest = headings[headings.length - 1];
    return cleanText(nearest?.textContent) || "Review";
  }

  function addWorkdayDirectSectionFields(fields) {
    const root = workdayReviewRootElement();
    if (!root) return;

    const sections = [...root.querySelectorAll("div[aria-labelledby]")]
      .filter((section) => {
        const labelledBy = cleanText(section.getAttribute("aria-labelledby"));
        return labelledBy.includes("section") && isVisibleElement(section);
      });

    for (const section of sections) {
      const heading = section.querySelector("h1,h2,h3,h4,h5,label,[role='heading']");
      const label = cleanText(heading?.textContent);
      if (!label || /^review$/i.test(label)) continue;

      const values = workdayDirectValueSpans(section);
      if (!values.length) continue;

      const categoryLabel = workdayNearestCategoryLabel(section, root);
      const categoryKey = workdayDomKey(categoryLabel) || "review";

      if (!fields.workday_review[categoryKey] || typeof fields.workday_review[categoryKey] !== "object") {
        fields.workday_review[categoryKey] = {};
      }

      setWorkdayDomValue(fields, categoryKey, fields.workday_review[categoryKey], label, values);
    }
  }

  function workdayIsQuestionNode(element) {
    return element?.matches?.("h1,h2,h3,h4,h5,label");
  }

  function workdayAnswerSpansBetween(startElement, stopPredicate) {
    const values = [];
    let current = startElement.nextElementSibling;

    while (current) {
      if (stopPredicate(current)) break;

      for (const span of current.matches?.("span") ? [current] : current.querySelectorAll?.("span") || []) {
        if (!isVisibleElement(span)) continue;
        const text = workdayNodeValueText(span);
        if (text && !isPlaceholderValue(text)) {
          values.push(text);
        }
      }

      current = current.nextElementSibling;
    }

    return [...new Set(values)];
  }

  function workdayReviewTokens(section) {
    return [...section.querySelectorAll("h1,h2,h3,h4,h5,label,span")]
      .filter(isVisibleElement)
      .map((element) => ({
        element,
        text: workdayNodeValueText(element),
        kind: workdayIsQuestionNode(element) ? "label" : "value",
        level: workdayHeadingLevel(element)
      }))
      .filter((token) => token.text);
  }

  function setWorkdayDomValue(fields, sectionKey, target, label, value) {
    const key = workdayDomKey(label);
    const values = (Array.isArray(value) ? value : [value])
      .map(cleanText)
      .map((item) => shouldNormalizeFileFieldKey(key) ? filenameFromUploadText(item) : item)
      .filter(Boolean)
      .filter((item) => !shouldNormalizeFileFieldKey(key) || isFilenameValue(item))
      .filter((item) => !isPlaceholderValue(item));

    if (!key || !values.length) return;

    target[key] = values.length > 1 ? values.join(", ") : values[0];
    deriveWorkdaySummaryFields(fields, sectionKey, key, target[key]);
  }

  function pruneEmptyObjects(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;

    for (const [key, nestedValue] of Object.entries(value)) {
      if (
        nestedValue &&
        typeof nestedValue === "object" &&
        !Array.isArray(nestedValue) &&
        pruneEmptyObjects(nestedValue)
      ) {
        delete value[key];
      }
    }

    return Object.keys(value).length === 0;
  }

  function collectWorkdayManualFieldsFromDom() {
    const fields = {
      workday_review: {}
    };
    addWorkdayDirectSectionFields(fields);
    addWorkdayUploadFields(fields);

    const sections = workdayReviewSections();

    if (!sections.length) {
      return Object.keys(fields.workday_review).length ? fields : null;
    }

    for (const section of sections) {
      const tokens = workdayReviewTokens(section);
      const firstHeading = tokens.find((token) => token.element.matches("h1,h2,h3,h4,h5"))?.element;
      const sectionLabel = cleanText(firstHeading?.textContent) || "Review";
      const sectionKey = workdayDomKey(sectionLabel) || "review";
      const root = fields.workday_review[sectionKey] && typeof fields.workday_review[sectionKey] === "object"
        ? fields.workday_review[sectionKey]
        : {};
      fields.workday_review[sectionKey] = root;

      const stack = [{
        level: 0,
        key: sectionKey,
        object: root,
        element: section
      }];

      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        const element = token.element;
        const label = cleanText(element.textContent);
        if (!label || /^review$/i.test(label)) continue;
        if (element === firstHeading) continue;

        if (token.kind !== "label") continue;

        const level = token.level;
        const isHeading = level < 7;
        const answers = [];

        for (let valueIndex = index + 1; valueIndex < tokens.length; valueIndex += 1) {
          const nextToken = tokens[valueIndex];
          if (nextToken.kind === "label") {
            break;
          }

          if (nextToken.kind === "value") {
            answers.push(nextToken.text);
          }
        }

        const key = workdayDomKey(label);
        if (!key) continue;

        while (stack.length > 1 && stack[stack.length - 1].level >= level) {
          stack.pop();
        }

        const parent = stack[stack.length - 1].object;

        if (answers.length) {
          setWorkdayDomValue(fields, sectionKey, parent, label, answers);
          continue;
        }

        if (isHeading) {
          if (!parent[key] || typeof parent[key] !== "object" || Array.isArray(parent[key])) {
            parent[key] = {};
          }

          stack.push({
            level,
            key,
            object: parent[key],
            element
          });
        }
      }

      pruneEmptyObjects(root);
      if (!Object.keys(root).length) {
        delete fields.workday_review[sectionKey];
      }
    }

    return Object.keys(fields.workday_review).length ? fields : null;
  }

  function collectWorkdayManualFields() {
    const domFields = collectWorkdayManualFieldsFromDom();
    if (domFields) return domFields;

    const fields = {
      workday_review: {}
    };
    const container = workdayReviewContainer();

    if (!container) return fields;

    const lines = visibleTextLines(container);
    const emphasizedTexts = workdayEmphasizedTextSet(container);
    let sectionKey = "review";
    let activeTarget = fields.workday_review[sectionKey];
    fields.workday_review[sectionKey] = {};
    activeTarget = fields.workday_review[sectionKey];

    for (let index = 0; index < lines.length;) {
      const line = cleanText(lines[index]);

      if (!line || /^review$/i.test(line)) {
        index += 1;
        continue;
      }

      const repeatedGroup = workdayRepeatedGroupKeys(line);
      if (repeatedGroup) {
        if (!fields.workday_review[sectionKey]) {
          fields.workday_review[sectionKey] = {};
        }
        if (!fields.workday_review[sectionKey][repeatedGroup.parentKey]) {
          fields.workday_review[sectionKey][repeatedGroup.parentKey] = {};
        }
        if (!fields.workday_review[sectionKey][repeatedGroup.parentKey][repeatedGroup.itemKey]) {
          fields.workday_review[sectionKey][repeatedGroup.parentKey][repeatedGroup.itemKey] = {};
        }
        activeTarget = fields.workday_review[sectionKey][repeatedGroup.parentKey][repeatedGroup.itemKey];
        index += 1;
        continue;
      }

      if (isWorkdaySectionAt(lines, index, emphasizedTexts)) {
        sectionKey = labelToKey(line) || "review";
        if (!fields.workday_review[sectionKey]) {
          fields.workday_review[sectionKey] = {};
        }
        activeTarget = fields.workday_review[sectionKey];
        index += 1;
        continue;
      }

      if (isWorkdayApplicationQuestionsSection(sectionKey)) {
        const result = parseWorkdayApplicationQuestions(lines, index, emphasizedTexts, activeTarget);
        index = result.nextIndex;
        continue;
      }

      if (isWorkdayRequiredQuestion(line)) {
        const result = parseWorkdayApplicationQuestions(lines, index, emphasizedTexts, activeTarget);
        index = result.nextIndex;
        continue;
      }

      const labelRow = workdayLabelRowAt(lines, index, emphasizedTexts);
      if (labelRow) {
        for (const pair of labelRow.pairs) {
          setWorkdayReviewValue(fields, sectionKey, activeTarget, pair.label, pair.value);
        }
        index = labelRow.nextIndex;
        continue;
      }

      if (isWorkdayLabelAt(lines, index, emphasizedTexts)) {
        const label = line;
        const values = [];
        let valueIndex = index + 1;

        while (valueIndex < lines.length) {
          if (workdayRepeatedGroupKeys(lines[valueIndex])) break;
          if (isWorkdayRequiredQuestion(lines[valueIndex])) break;
          if (isWorkdaySectionAt(lines, valueIndex, emphasizedTexts)) break;
          if (values.length && isWorkdayLabelAt(lines, valueIndex, emphasizedTexts)) break;
          values.push(lines[valueIndex]);
          valueIndex += 1;
        }

        const normalizedValues = values
          .map(cleanText)
          .filter(Boolean)
          .filter((value) => !isPlaceholderValue(value));

        setWorkdayReviewValue(fields, sectionKey, activeTarget, label, normalizedValues);

        index = Math.max(valueIndex, index + 1);
        continue;
      }

      index += 1;
    }

    for (const [key, value] of Object.entries(fields.workday_review)) {
      if (!value || typeof value !== "object") continue;

      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (!nestedValue || typeof nestedValue !== "object" || Array.isArray(nestedValue)) continue;

        for (const [itemKey, itemValue] of Object.entries(nestedValue)) {
          if (
            itemValue &&
            typeof itemValue === "object" &&
            !Array.isArray(itemValue) &&
            !Object.keys(itemValue).length
          ) {
            delete nestedValue[itemKey];
          }
        }

        if (!Object.keys(nestedValue).length) {
          delete value[nestedKey];
        }
      }

      if (!Object.keys(value).length) {
        delete fields.workday_review[key];
      }
    }

    return fields;
  }

  function linkedinFromManualFields(fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (!key.includes("linkedin")) continue;

      const values = Array.isArray(value) ? value : [value];
      const linkedin = values.find((item) => cleanText(item));
      if (linkedin) return cleanText(linkedin);
    }

    return null;
  }

  function enrichManualFieldsPayload(payload) {
    if (!payload || typeof payload !== "object") return payload;
    if (!payload.job_application || typeof payload.job_application !== "object") return payload;

    const manualFields = collectManualFields();
    if (Object.keys(manualFields).length) {
      payload.job_application.manual_fields = manualFields;
    }

    const linkedin = linkedinFromManualFields(manualFields) || findLinkedInAnswer(payload);
    if (linkedin) {
      payload.job_application.linkedin = linkedin;
    }

    return payload;
  }

  function manualFieldsOnlyPayload(url, platformOverride) {
    const platform = platformOverride || platformForUrl(url);
    const manualFields = platform === "workday"
      ? collectWorkdayManualFields()
      : platform === "lever"
        ? collectLeverManualFields()
        : platform === "greenhouse"
          ? collectGreenhouseManualFields()
          : platform === "ashby"
            ? collectAshbyManualFields()
            : platform === "gusto"
              ? collectGustoManualFields()
              : platform === "applytojob"
                ? collectApplyToJobManualFields()
                : platform === "jobvite"
                  ? collectJobviteManualFields()
                  : platform === "bamboohr"
                    ? collectBambooHrManualFields()
                    : platform === "rippling"
                      ? collectRipplingManualFields()
                      : platform === "recruitee"
                        ? collectRecruiteeManualFields()
      : collectManualFields();
    manualFields.platform = platform;
    manualFields.extension_version = EXTENSION_VERSION;
    manualFields.extension_build_timestamp = EXTENSION_BUILD_TIMESTAMP;
    manualFields.bid_url = location.href;
    addBidMetadata(manualFields, url, platform);

    return {
      manual_fields: manualFields
    };
  }

  function enrichEducationPayload(payload) {
    if (!payload || typeof payload !== "object") return payload;

    const educations = payload.job_application?.educations;
    if (!Array.isArray(educations)) return payload;

    for (const education of educations) {
      if (!education || typeof education !== "object") continue;

      const schoolName = findTextInClassifiedList(education.school_name_id, SCHOOL_LIST_MARKER);
      if (schoolName) {
        education.school_name = schoolName;
      }

      const degree = findTextInClassifiedList(education.degree_id, DEGREE_LIST_MARKER);
      if (degree) {
        education.degree = degree;
      }
    }

    return payload;
  }

  function sendPayload(url, body) {
    if (body == null) return;

    const emit = (payload) => {
      const downloadPayload = manualFieldsOnlyPayload(url);

      window.postMessage(
        { source: MESSAGE_TYPE, url: new URL(url, location.href).href, payload: downloadPayload },
        location.origin
      );
    };

    if (typeof body === "string") {
      try {
        emit(JSON.parse(body));
      } catch {
        emit(body);
      }
      return;
    }

    if (body instanceof URLSearchParams) {
      emit(Object.fromEntries(body.entries()));
      return;
    }

    if (body instanceof FormData) {
      const payload = {};
      for (const [key, value] of body.entries()) {
        const displayValue = value instanceof File
          ? { name: value.name, type: value.type, size: value.size }
          : value;

        if (Object.hasOwn(payload, key)) {
          payload[key] = Array.isArray(payload[key])
            ? [...payload[key], displayValue]
            : [payload[key], displayValue];
        } else {
          payload[key] = displayValue;
        }
      }
      emit(payload);
      return;
    }

    if (body instanceof Blob) {
      body.text().then((text) => {
        try {
          emit(JSON.parse(text));
        } catch {
          emit(text);
        }
      });
      return;
    }

    emit(String(body));
  }

  function sendManualFields(url, platformOverride) {
    window.postMessage(
      { source: MESSAGE_TYPE, url: new URL(url, location.href).href, payload: manualFieldsOnlyPayload(url, platformOverride) },
      location.origin
    );
  }

  function downloadManualFieldsOnly(url, platformOverride) {
    window.postMessage(
      {
        source: MESSAGE_TYPE,
        url: new URL(url, location.href).href,
        payload: manualFieldsOnlyPayload(url, platformOverride),
        downloadOnly: true
      },
      location.origin
    );
  }

  function sendNetworkManualFields(url, platform) {
    const absoluteUrl = new URL(url, location.href).href;
    const captureKey = `${platform}:${absoluteUrl}`;
    const now = Date.now();

    if (captureKey === lastNetworkCaptureKey && now - lastNetworkCaptureAt < 1000) {
      return;
    }

    lastNetworkCaptureKey = captureKey;
    lastNetworkCaptureAt = now;
    sendManualFields(absoluteUrl, platform);
  }

  function submissionUrlForForm(form) {
    if (!form) return location.href;

    try {
      return new URL(form.getAttribute("action") || location.href, location.href).href;
    } catch {
      return location.href;
    }
  }

  function isAshbyApplyPage() {
    try {
      return new URL(location.href).hostname === "jobs.ashbyhq.com";
    } catch {
      return false;
    }
  }

  function isLeverApplyPage() {
    try {
      const pageUrl = new URL(location.href);
      return pageUrl.hostname === "jobs.lever.co" && pageUrl.pathname.includes("/apply");
    } catch {
      return false;
    }
  }

  function isJobviteApplyPage() {
    try {
      const pageUrl = new URL(location.href);
      return pageUrl.hostname === "jobs.jobvite.com" && pageUrl.pathname.includes("/apply");
    } catch {
      return false;
    }
  }

  function isBambooHrApplyPage() {
    try {
      return isBambooHrCareersUrl(new URL(location.href));
    } catch {
      return false;
    }
  }

  function isRipplingApplyPage() {
    try {
      return isRipplingApplyUrl(new URL(location.href));
    } catch {
      return false;
    }
  }

  function isWorkdayApplyPage() {
    try {
      return isWorkdayApplyUrl(new URL(location.href));
    } catch {
      return false;
    }
  }

  function isGustoApplyPage() {
    return Boolean(gustoApplicationForm());
  }

  function isApplyToJobApplyPage() {
    try {
      return Boolean(applyToJobApplicationForm()) || isApplyToJobHost(new URL(location.href));
    } catch {
      return Boolean(applyToJobApplicationForm());
    }
  }

  function isAshbySubmitButton(target) {
    let element = target instanceof Element ? target : target?.parentElement;

    while (element) {
      const classText = cleanText(element.getAttribute?.("class"));
      if (classText.includes("ashby-application-form-submit-button")) {
        return true;
      }

      element = element.parentElement;
    }

    return false;
  }

  function isLeverSubmitApplicationButton(target) {
    const button = target instanceof Element
      ? target.closest("button, input[type='submit'], input[type='button'], [role='button']")
      : null;

    if (!button) return false;

    const text = cleanText(
      button.textContent ||
      button.value ||
      button.getAttribute?.("aria-label")
    ).toLowerCase();

    return text === "submit application";
  }

  function isJobviteSubmitButton(target) {
    const button = target instanceof Element
      ? target.closest("button, input[type='submit'], input[type='button'], [role='button']")
      : null;

    if (!button) return false;

    const text = cleanText(
      button.textContent ||
      button.value ||
      button.getAttribute?.("aria-label")
    ).toLowerCase();

    return button.type === "submit" ||
      /^(submit|apply|submit application|send application)$/i.test(text);
  }

  function isBambooHrSubmitButton(target) {
    const button = target instanceof Element
      ? target.closest("button, input[type='submit'], input[type='button'], [role='button']")
      : null;

    if (!button) return false;

    const text = cleanText(
      button.textContent ||
      button.value ||
      button.getAttribute?.("aria-label")
    ).toLowerCase();

    return button.type === "submit" ||
      /^(submit|apply|submit application|send application|send)$/i.test(text);
  }

  function isRipplingSubmitButton(target) {
    const button = target instanceof Element
      ? target.closest("button, input[type='submit'], input[type='button'], [role='button']")
      : null;

    if (!button) return false;

    const text = cleanText(
      button.textContent ||
      button.value ||
      button.getAttribute?.("aria-label")
    ).toLowerCase();

    return button.type === "submit" ||
      /^(submit|apply|submit application|send application|next|continue)$/i.test(text);
  }

  function isWorkdaySubmitButton(target) {
    const button = target instanceof Element
      ? target.closest("button, input[type='submit'], input[type='button'], [role='button']")
      : null;

    if (!button) return false;

    const text = cleanText(
      button.textContent ||
      button.value ||
      button.getAttribute?.("aria-label")
    ).toLowerCase();

    return text === "submit";
  }

  function isGustoSubmitButton(target) {
    const button = target instanceof Element
      ? target.closest("button, input[type='submit'], input[type='button'], [role='button']")
      : null;

    if (!button) return false;

    const text = cleanText(
      button.textContent ||
      button.value ||
      button.getAttribute?.("aria-label")
    ).toLowerCase();

    return button.type === "submit" ||
      /^(submit|apply|submit application|send application)$/i.test(text);
  }

  function isApplyToJobSubmitButton(target) {
    const button = target instanceof Element
      ? target.closest("button, input[type='submit'], input[type='button'], [role='button']")
      : null;

    if (!button) return false;
    const form = applyToJobApplicationForm();
    if (form && !form.contains(button)) return false;

    const text = cleanText(
      button.textContent ||
      button.value ||
      button.getAttribute?.("aria-label")
    ).toLowerCase();

    return button.type === "submit" ||
      /^(submit|apply|submit application|send application)$/i.test(text);
  }

  function hasVisibleWorkdayReviewForCaptureButton() {
    return isWorkdayReviewHeadingVisible() && Boolean(workdayReviewContainer());
  }

  function isCapturePageActiveForButton() {
    try {
      const pageUrl = new URL(location.href);

      if (pageUrl.hostname === "jobs.ashbyhq.com") return true;
      if (pageUrl.hostname === "jobs.lever.co" && pageUrl.pathname.includes("/apply")) return true;
      if (pageUrl.hostname === "jobs.jobvite.com" && pageUrl.pathname.includes("/apply")) return true;
      if (isRipplingApplyUrl(pageUrl)) return true;
      if (isRecruiteeApplyPage()) return true;
      if (isBambooHrApplyPage()) return true;
      if (isGustoApplyPage()) return true;
      if (pageUrl.hostname.endsWith(".gusto.com") || pageUrl.hostname.endsWith(".gusto.io")) return true;
      if (isApplyToJobApplyPage()) return true;
      if (pageUrl.hostname.endsWith("greenhouse.io")) return true;
      if (pageUrl.hostname.endsWith(".myworkdayjobs.com") && pageUrl.pathname.includes("/apply")) {
        return hasVisibleWorkdayReviewForCaptureButton();
      }
    } catch {
      return false;
    }

    return false;
  }

  function removeManualCaptureButton() {
    document.getElementById("application-manual-fields-test-button")?.remove();
  }

  function installManualCaptureButton() {
    const platform = pagePlatform();
    if (!platform || !isCapturePageActiveForButton()) {
      removeManualCaptureButton();
      return;
    }
    if (document.getElementById("application-manual-fields-test-button")) return;

    const button = document.createElement("button");
    button.id = "application-manual-fields-test-button";
    button.type = "button";
    button.textContent = "Capture Manual fields";
    button.style.cssText = [
      "position: fixed",
      "left: 14px",
      "bottom: 14px",
      "z-index: 2147483647",
      "border: 1px solid #064e3b",
      "border-radius: 999px",
      "background: #064e3b",
      "color: #fff",
      "padding: 9px 14px",
      "font: 600 13px Arial, sans-serif",
      "cursor: pointer",
      "box-shadow: 0 6px 18px rgba(0,0,0,0.2)",
      "opacity: 0.92"
    ].join(";");

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      sendManualFields(location.href, pagePlatform() || platform);
    });

    document.documentElement.appendChild(button);
  }

  function queueManualCaptureButtonInstall() {
    if (manualCaptureButtonQueued) return;
    manualCaptureButtonQueued = true;

    requestAnimationFrame(() => {
      manualCaptureButtonQueued = false;
      installManualCaptureButton();
    });
  }

  function hasVisibleValidationError() {
    const errorSelectors = [
      "[aria-invalid='true']",
      "[role='alert']",
      "[class*='error' i]",
      "[class*='invalid' i]"
    ];

    for (const element of document.querySelectorAll(errorSelectors.join(","))) {
      if (element instanceof HTMLElement && element.offsetParent === null) continue;

      const text = cleanText(element.textContent || element.getAttribute?.("aria-label"));
      if (text || element.getAttribute?.("aria-invalid") === "true") {
        return true;
      }
    }

    return false;
  }

  function captureAshbySubmitButtonClick(event) {
    if (!isAshbyApplyPage() || !isAshbySubmitButton(event.target)) return;
    if (Date.now() - lastManualSubmitCaptureAt < 1000) return;

    clearTimeout(pendingAshbyCaptureTimer);
    pendingAshbyCaptureTimer = setTimeout(() => {
      pendingAshbyCaptureTimer = null;
      if (hasVisibleValidationError()) return;

      lastManualSubmitCaptureAt = Date.now();
      sendManualFields(location.href, "ashby");
    }, 750);
  }

  function captureLeverSubmitButtonClick(event) {
    if (!isLeverApplyPage() || !isLeverSubmitApplicationButton(event.target)) return;
    if (Date.now() - lastManualSubmitCaptureAt < 1000) return;

    clearTimeout(pendingLeverCaptureTimer);
    pendingLeverCaptureTimer = setTimeout(() => {
      pendingLeverCaptureTimer = null;
      if (hasVisibleValidationError()) return;

      lastManualSubmitCaptureAt = Date.now();
      sendManualFields(location.href, "lever");
    }, 750);
  }

  function captureJobviteSubmitButtonClick(event) {
    if (!isJobviteApplyPage() || !isJobviteSubmitButton(event.target)) return;
    if (Date.now() - lastManualSubmitCaptureAt < 1000) return;

    clearTimeout(pendingJobviteCaptureTimer);
    pendingJobviteCaptureTimer = setTimeout(() => {
      pendingJobviteCaptureTimer = null;
      if (hasVisibleValidationError()) return;

      lastManualSubmitCaptureAt = Date.now();
      sendManualFields(location.href, "jobvite");
    }, 750);
  }

  function captureBambooHrSubmitButtonClick(event) {
    if (!isBambooHrApplyPage() || !isBambooHrSubmitButton(event.target)) return;
    if (Date.now() - lastManualSubmitCaptureAt < 1000) return;

    clearTimeout(pendingBambooHrCaptureTimer);
    pendingBambooHrCaptureTimer = setTimeout(() => {
      pendingBambooHrCaptureTimer = null;
      if (hasVisibleValidationError()) return;

      lastManualSubmitCaptureAt = Date.now();
      sendManualFields(location.href, "bamboohr");
    }, 750);
  }

  function captureRipplingSubmitButtonClick(event) {
    if (!isRipplingApplyPage() || !isRipplingSubmitButton(event.target)) return;
    if (Date.now() - lastManualSubmitCaptureAt < 1000) return;

    clearTimeout(pendingRipplingCaptureTimer);
    pendingRipplingCaptureTimer = setTimeout(() => {
      pendingRipplingCaptureTimer = null;
      if (hasVisibleValidationError()) return;

      lastManualSubmitCaptureAt = Date.now();
      sendManualFields(location.href, "rippling");
    }, 750);
  }

  function isRecruiteeSubmitButton(target) {
    const button = target instanceof Element
      ? target.closest("button, input[type='submit'], [role='button']")
      : null;

    if (!button) return false;
    const form = recruiteeApplicationForm();
    if (form && !form.contains(button)) return false;

    const text = cleanText(
      button.textContent ||
      button.value ||
      button.getAttribute?.("aria-label")
    ).toLowerCase();

    return button.getAttribute?.("data-testid") === "submit-application-form-button" ||
      button.type === "submit" ||
      /^(send|submit|submit application|apply)$/i.test(text);
  }

  function captureRecruiteeSubmitButtonClick(event) {
    if (!isRecruiteeApplyPage() || !isRecruiteeSubmitButton(event.target)) return;
    if (Date.now() - lastManualSubmitCaptureAt < 1000) return;

    clearTimeout(pendingRecruiteeCaptureTimer);
    pendingRecruiteeCaptureTimer = setTimeout(() => {
      pendingRecruiteeCaptureTimer = null;
      if (hasVisibleValidationError()) return;

      lastManualSubmitCaptureAt = Date.now();
      sendManualFields(submissionUrlForForm(recruiteeApplicationForm()), "recruitee");
    }, 750);
  }

  function captureWorkdaySubmitButtonClick(event) {
    if (!isWorkdayApplyPage() || !isWorkdaySubmitButton(event.target)) return;
    if (!isWorkdayReviewHeadingVisible() || !workdayReviewContainer()) return;
    if (Date.now() - lastManualSubmitCaptureAt < 1000) return;

    clearTimeout(pendingWorkdayCaptureTimer);
    pendingWorkdayCaptureTimer = null;
    lastManualSubmitCaptureAt = Date.now();
    sendManualFields(location.href, "workday");
  }

  function captureGustoSubmitButtonClick(event) {
    if (!isGustoApplyPage() || !isGustoSubmitButton(event.target)) return;
    if (Date.now() - lastManualSubmitCaptureAt < 1000) return;

    lastManualSubmitCaptureAt = Date.now();
    setTimeout(() => {
      if (hasVisibleValidationError()) return;
      sendManualFields(submissionUrlForForm(gustoApplicationForm()), "gusto");
    }, 750);
  }

  function captureApplyToJobSubmitButtonClick(event) {
    if (!isApplyToJobApplyPage() || !isApplyToJobSubmitButton(event.target)) return;
    if (Date.now() - lastManualSubmitCaptureAt < 1000) return;

    clearTimeout(pendingApplyToJobCaptureTimer);
    pendingApplyToJobCaptureTimer = setTimeout(() => {
      pendingApplyToJobCaptureTimer = null;
      if (hasVisibleValidationError()) return;

      lastManualSubmitCaptureAt = Date.now();
      sendManualFields(submissionUrlForForm(applyToJobApplicationForm()), "applytojob");
    }, 750);
  }

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = input instanceof Request ? input.url : input;
    const method = (init?.method || (input instanceof Request && input.method) || "GET").toUpperCase();
    const platform = matchingPlatform(url);

    if (method === "POST" && platform) {
      sendNetworkManualFields(url, platform);

      if (BLOCK_REAL_APPLICATION_SUBMIT) {
        return Promise.resolve(new Response(
          JSON.stringify({
            captured_by_extension: true,
            platform,
            submitted_to_server: false
          }),
          {
            status: 200,
            statusText: "Captured by extension",
            headers: { "Content-Type": "application/json" }
          }
        ));
      }
    }

    return originalFetch.apply(this, arguments).then((response) => {
      try {
        const responseUrl = response.url || new URL(url, location.href).href;
        const hostname = new URL(responseUrl, location.href).hostname;
        if (
          hostname.endsWith("greenhouse.io") ||
          hostname === "jobs.lever.co"
        ) {
          response.clone().text().then(parseAndCacheOptionData).catch(() => {});
        }
      } catch {
        // Leave the page's fetch behavior untouched if response inspection fails.
      }

      return response;
    });
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__applicationCapture = {
      method: String(method).toUpperCase(),
      url: new URL(url, location.href).href,
      platform: matchingPlatform(url)
    };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const request = this.__applicationCapture;
    if (request?.method === "POST" && request.platform) {
      sendNetworkManualFields(request.url, request.platform);

      if (BLOCK_REAL_APPLICATION_SUBMIT) {
        setTimeout(() => {
          this.dispatchEvent(new Event("load"));
          this.dispatchEvent(new Event("loadend"));
        }, 0);
        return;
      }
    }

    this.addEventListener("loadend", () => {
      try {
        if (
          request?.url &&
          (
            new URL(request.url, location.href).hostname.endsWith("greenhouse.io") ||
            new URL(request.url, location.href).hostname === "jobs.lever.co"
          ) &&
          typeof this.responseText === "string"
        ) {
          parseAndCacheOptionData(this.responseText);
        }
      } catch {
        // Leave the page's XHR behavior untouched if response inspection fails.
      }
    });

    return originalSend.apply(this, arguments);
  };

  function startOptionDiscovery() {
    const target = document.documentElement || document;

    scanClassifiedLists();
    scanScriptOptionData();
    scanWindowOptionData();

    new MutationObserver(queueClassifiedListScan).observe(target, {
      childList: true,
      subtree: true
    });
    new MutationObserver(queueDataScan).observe(target, {
      childList: true,
      subtree: true
    });
    new MutationObserver(queueManualCaptureButtonInstall).observe(target, {
      childList: true,
      subtree: true
    });

    document.addEventListener("input", (event) => {
      cacheManualFieldFromControl(event.target);
    }, true);

    document.addEventListener("change", (event) => {
      cacheManualFieldFromControl(event.target);
    }, true);

    document.addEventListener("pointerdown", (event) => {
      cacheManualFieldFromCustomOption(event.target);
    }, true);

    document.addEventListener("click", (event) => {
      cacheManualFieldFromCustomOption(event.target);
    }, true);

    document.addEventListener("click", captureAshbySubmitButtonClick, true);
    document.addEventListener("click", captureLeverSubmitButtonClick, true);
    document.addEventListener("click", captureJobviteSubmitButtonClick, true);
    document.addEventListener("click", captureBambooHrSubmitButtonClick, true);
    document.addEventListener("click", captureRipplingSubmitButtonClick, true);
    document.addEventListener("click", captureRecruiteeSubmitButtonClick, true);
    document.addEventListener("click", captureWorkdaySubmitButtonClick, true);
    document.addEventListener("click", captureGustoSubmitButtonClick, true);
    document.addEventListener("click", captureApplyToJobSubmitButtonClick, true);

    queueManualCaptureButtonInstall();
  }

  startOptionDiscovery();
})();
