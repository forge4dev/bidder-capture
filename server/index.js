"use strict";

const express = require("express");
const crypto = require("crypto");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs");

const scrypt = promisify(crypto.scrypt);

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "bidder-dashboard.sqlite");
const DATABASE_URL = process.env.DATABASE_URL || "";
const SERVER_TIME_ZONE = process.env.SERVER_TIME_ZONE || "America/Los_Angeles";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-session-secret-change-me";
const DEFAULT_ADMIN_ID = "admin";
const DEFAULT_ADMIN_PASSWORD = "123456";

let db;
let dbKind = "sqlite";

function oneLine(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatValue(value) {
  if (Array.isArray(value)) return value.map(formatValue).filter(Boolean).join(", ");
  if (value && typeof value === "object") return oneLine(JSON.stringify(value));
  return oneLine(value);
}

function formatLogEntry(id, manualFields, createdAt) {
  const fields = { id, ...manualFields, created_at: createdAt };
  const parts = Object.entries(fields)
    .map(([key, value]) => [oneLine(key), formatValue(value)])
    .filter(([key, value]) => key && value)
    .map(([key, value]) => `${key}: ${value}`);
  return `(${parts.join(", ")})`;
}

function generateMasterId() {
  return `m_${crypto.randomBytes(8).toString("hex")}`;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = await scrypt(String(password), salt, 64);
  return `scrypt$${salt}$${derivedKey.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== "string") return false;

  const [algorithm, salt, expectedHex] = storedHash.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;

  const actual = await scrypt(String(password), salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function signValue(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

function sessionCookieValue(masterId) {
  const value = Buffer.from(JSON.stringify({ master_id: masterId })).toString("base64url");
  return `${value}.${signValue(value)}`;
}

function parseCookies(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const separator = item.indexOf("=");
      if (separator === -1) return cookies;
      cookies[item.slice(0, separator)] = decodeURIComponent(item.slice(separator + 1));
      return cookies;
    }, {});
}

function masterIdFromRequest(request) {
  const cookie = parseCookies(request.headers.cookie).master_session;
  if (!cookie) return null;

  const [value, signature] = cookie.split(".");
  if (!value || !signature || signValue(value) !== signature) return null;

  try {
    const payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return payload.master_id || null;
  } catch {
    return null;
  }
}

function setSessionCookie(response, masterId) {
  response.setHeader(
    "Set-Cookie",
    `master_session=${encodeURIComponent(sessionCookieValue(masterId))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`
  );
}

function clearSessionCookie(response) {
  response.setHeader("Set-Cookie", "master_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function shouldUsePostgresSsl(databaseUrl) {
  if (process.env.DATABASE_SSL === "false") return false;

  try {
    const parsedUrl = new URL(databaseUrl);
    return !["localhost", "127.0.0.1"].includes(parsedUrl.hostname);
  } catch {
    return true;
  }
}

async function initDatabase() {
  if (DATABASE_URL) {
    const { Pool } = require("pg");
    dbKind = "postgres";
    db = new Pool({
      connectionString: DATABASE_URL,
      ssl: shouldUsePostgresSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false
    });
    await db.query(`
      CREATE TABLE IF NOT EXISTS masters (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        master_id TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        bidder_password_hash TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bidding_logs (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        master_id TEXT NOT NULL REFERENCES masters(master_id),
        created_at TEXT NOT NULL,
        manual_fields_json TEXT NOT NULL,
        raw_text TEXT NOT NULL
      );
    `);
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  dbKind = "sqlite";
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS masters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      master_id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      bidder_password_hash TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bidding_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      master_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      manual_fields_json TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      FOREIGN KEY(master_id) REFERENCES masters(master_id)
    );
  `);
}

async function dbGet(sqliteSql, postgresSql, params = []) {
  if (dbKind === "postgres") {
    const result = await db.query(postgresSql, params);
    return result.rows[0] || null;
  }
  return db.prepare(sqliteSql).get(...params) || null;
}

async function dbAll(sqliteSql, postgresSql, params = []) {
  if (dbKind === "postgres") {
    const result = await db.query(postgresSql, params);
    return result.rows;
  }
  return db.prepare(sqliteSql).all(...params);
}

async function dbRun(sqliteSql, postgresSql, params = []) {
  if (dbKind === "postgres") {
    return db.query(postgresSql, params);
  }
  return db.prepare(sqliteSql).run(...params);
}

async function masterByEmail(email) {
  return dbGet(
    "SELECT * FROM masters WHERE lower(email) = lower(?)",
    "SELECT * FROM masters WHERE lower(email) = lower($1)",
    [email]
  );
}

async function masterByMasterId(masterId) {
  return dbGet(
    "SELECT * FROM masters WHERE master_id = ?",
    "SELECT * FROM masters WHERE master_id = $1",
    [masterId]
  );
}

async function createMaster({ email, password }) {
  const masterId = generateMasterId();
  const createdAt = new Date().toISOString();
  const passwordHash = await hashPassword(password);
  await dbRun(
    `
      INSERT INTO masters (master_id, email, password_hash, created_at)
      VALUES (?, ?, ?, ?)
    `,
    `
      INSERT INTO masters (master_id, email, password_hash, created_at)
      VALUES ($1, $2, $3, $4)
    `,
    [masterId, email, passwordHash, createdAt]
  );
  return masterByMasterId(masterId);
}

async function ensureDefaultAdmin() {
  const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
  const createdAt = new Date().toISOString();
  const existing = await masterByEmail(DEFAULT_ADMIN_ID);

  if (existing) {
    await dbRun(
      "UPDATE masters SET master_id = ?, password_hash = ? WHERE id = ?",
      "UPDATE masters SET master_id = $1, password_hash = $2 WHERE id = $3",
      [DEFAULT_ADMIN_ID, passwordHash, existing.id]
    );
    return masterByMasterId(DEFAULT_ADMIN_ID);
  }

  await dbRun(
    `
      INSERT INTO masters (master_id, email, password_hash, created_at)
      VALUES (?, ?, ?, ?)
    `,
    `
      INSERT INTO masters (master_id, email, password_hash, created_at)
      VALUES ($1, $2, $3, $4)
    `,
    [DEFAULT_ADMIN_ID, DEFAULT_ADMIN_ID, passwordHash, createdAt]
  );

  return masterByMasterId(DEFAULT_ADMIN_ID);
}

async function updateBidderPassword(masterId, bidderPassword) {
  const passwordHash = await hashPassword(bidderPassword);
  await dbRun(
    "UPDATE masters SET bidder_password_hash = ? WHERE master_id = ?",
    "UPDATE masters SET bidder_password_hash = $1 WHERE master_id = $2",
    [passwordHash, masterId]
  );
}

async function verifyBidderCredentials(masterUserId, bidderPassword) {
  const userId = oneLine(masterUserId).toLowerCase();
  const master = await masterByEmail(userId);
  if (!master) return null;

  if (!master.bidder_password_hash) {
    return oneLine(bidderPassword) ? null : master;
  }

  const ok = await verifyPassword(bidderPassword, master.bidder_password_hash);
  return ok ? master : null;
}

async function insertBiddingLog(masterId, manualFields) {
  const createdAt = new Date().toISOString();
  const rawText = formatLogEntry(null, manualFields, createdAt);
  let id;

  if (dbKind === "postgres") {
    const result = await db.query(
      `
        INSERT INTO bidding_logs (master_id, created_at, manual_fields_json, raw_text)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `,
      [masterId, createdAt, JSON.stringify(manualFields), rawText]
    );
    id = Number(result.rows[0].id);
  } else {
    const result = db.prepare(`
      INSERT INTO bidding_logs (master_id, created_at, manual_fields_json, raw_text)
      VALUES (?, ?, ?, ?)
    `).run(masterId, createdAt, JSON.stringify(manualFields), rawText);
    id = Number(result.lastInsertRowid);
  }

  const finalRawText = formatLogEntry(id, manualFields, createdAt);
  await dbRun(
    "UPDATE bidding_logs SET raw_text = ? WHERE id = ?",
    "UPDATE bidding_logs SET raw_text = $1 WHERE id = $2",
    [finalRawText, id]
  );
  return { id, entry: finalRawText };
}

async function logsForMaster(masterId) {
  const rows = await dbAll(
    `
      SELECT id, created_at, manual_fields_json, raw_text
      FROM bidding_logs
      WHERE master_id = ?
      ORDER BY id DESC
    `,
    `
      SELECT id, created_at, manual_fields_json, raw_text
      FROM bidding_logs
      WHERE master_id = $1
      ORDER BY id DESC
    `,
    [masterId]
  );

  return rows.map((row) => {
    let manualFields = {};
    try {
      manualFields = JSON.parse(row.manual_fields_json);
    } catch {
      manualFields = {};
    }
    return {
      id: row.id,
      created_at: row.created_at,
      manual_fields: manualFields,
      raw_entry: row.raw_text
    };
  });
}

function paginationFromQuery(query = {}) {
  const allowedPageSizes = [10, 50, 100];
  const requestedPageSize = Number(query.page_size || query.pageSize || 10);
  const pageSize = allowedPageSizes.includes(requestedPageSize) ? requestedPageSize : 10;
  const requestedPage = Number(query.page || 1);
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  return { page, pageSize };
}

async function logsPageForMaster(masterId, { page = 1, pageSize = 10 } = {}) {
  const countRow = await dbGet(
    `
      SELECT COUNT(*) AS count
      FROM bidding_logs
      WHERE master_id = ?
    `,
    `
      SELECT COUNT(*) AS count
      FROM bidding_logs
      WHERE master_id = $1
    `,
    [masterId]
  );
  const totalItems = Number(countRow?.count || 0);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const offset = (safePage - 1) * pageSize;

  const rows = await dbAll(
    `
      SELECT id, created_at, manual_fields_json, raw_text
      FROM bidding_logs
      WHERE master_id = ?
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `,
    `
      SELECT id, created_at, manual_fields_json, raw_text
      FROM bidding_logs
      WHERE master_id = $1
      ORDER BY id DESC
      LIMIT $2 OFFSET $3
    `,
    [masterId, pageSize, offset]
  );

  const records = rows.map((row) => {
    let manualFields = {};
    try {
      manualFields = JSON.parse(row.manual_fields_json);
    } catch {
      manualFields = {};
    }
    return {
      id: row.id,
      created_at: row.created_at,
      manual_fields: manualFields,
      raw_entry: row.raw_text
    };
  });

  return {
    records,
    pagination: {
      page: safePage,
      pageSize,
      totalItems,
      totalPages,
      offset
    }
  };
}

async function allLogs() {
  const rows = await dbAll(
    `
      SELECT id, created_at, manual_fields_json, raw_text
      FROM bidding_logs
      ORDER BY id DESC
    `,
    `
      SELECT id, created_at, manual_fields_json, raw_text
      FROM bidding_logs
      ORDER BY id DESC
    `
  );

  return rows.map((row) => {
    let manualFields = {};
    try {
      manualFields = JSON.parse(row.manual_fields_json);
    } catch {
      manualFields = {};
    }
    return {
      id: row.id,
      created_at: row.created_at,
      manual_fields: manualFields,
      raw_entry: row.raw_text
    };
  });
}

function fieldValue(fields, candidates) {
  for (const key of candidates) {
    const value = fields[key];
    if (value !== undefined && value !== null && String(value).trim()) return formatValue(value);
  }
  return "";
}

function fieldValueByKeyIncludes(fields, marker) {
  const entry = Object.entries(fields).find(([key, value]) => {
    return key.includes(marker) && value !== undefined && value !== null && String(value).trim();
  });
  return entry ? formatValue(entry[1]) : "";
}

function resumeValueFromFields(fields) {
  const directValue = fieldValue(fields, [
    "resume_cv",
    "resume",
    "cv",
    "resume_file",
    "resume_filename",
    "resume_file_name",
    "uploaded_resume",
    "attachment"
  ]);

  if (directValue) return filenameFromUploadText(directValue);

  const resumeLikeEntry = Object.entries(fields).find(([key, value]) => {
    const normalizedKey = oneLine(key).toLowerCase();
    return /resume|cv|attachment|upload/.test(normalizedKey) &&
      value !== undefined &&
      value !== null &&
      String(value).trim();
  });

  return resumeLikeEntry ? filenameFromUploadText(resumeLikeEntry[1]) : "";
}

function filenameFromUploadText(value) {
  const text = oneLine(formatValue(value));
  if (!text) return "";

  const fullFilename = text.match(/([^\\/\n\r]+?\.(?:docx|doc|pdf|txt|rtf|odt|pages))(?=\s*(?:$|,|;|\(|\b(?:successfully uploaded|remove|delete|replace|click|drag|upload)\b))/i);
  if (fullFilename) return oneLine(fullFilename[1]);

  const candidates = text
    .replace(/\bsuccessfully uploaded\b/gi, ",")
    .split(/[,;\n\r]+/)
    .map(oneLine)
    .filter(Boolean);

  for (const candidate of candidates) {
    const match = candidate.match(/([^\\/\n\r]+?\.(?:docx|doc|pdf|txt|rtf|odt|pages))$/i);
    if (match) return oneLine(match[1]);
  }

  const fallback = text.match(/([^\\/\n\r]+?\.(?:docx|doc|pdf|txt|rtf|odt|pages))(?![a-z0-9])/i);
  return fallback ? oneLine(fallback[1]) : text;
}

function companyNameFromBidUrl(url, platform) {
  try {
    const parsedUrl = new URL(url);
    const normalizedPlatform = oneLine(platform).toLowerCase();

    if (normalizedPlatform === "workday" && parsedUrl.hostname.endsWith(".myworkdayjobs.com")) {
      return oneLine(parsedUrl.hostname.split(".")[0]);
    }

    if (normalizedPlatform === "bamboohr" && parsedUrl.hostname.endsWith(".bamboohr.com")) {
      return oneLine(parsedUrl.hostname.split(".")[0]);
    }

    if (normalizedPlatform === "recruitee" && parsedUrl.hostname.endsWith(".recruitee.com")) {
      return oneLine(parsedUrl.hostname.split(".")[0]);
    }

    if (normalizedPlatform === "rippling" && parsedUrl.hostname === "ats.rippling.com") {
      return oneLine(parsedUrl.searchParams.get("jobBoardSlug")) ||
        oneLine(parsedUrl.pathname.split("/").filter(Boolean)[0]);
    }

    if (normalizedPlatform === "greenhouse") {
      return oneLine(parsedUrl.searchParams.get("for"));
    }

    if (normalizedPlatform === "gusto") {
      const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
      const postingsIndex = pathParts.findIndex((part) => part.toLowerCase() === "postings");
      const rawSlug = postingsIndex >= 0 ? oneLine(pathParts[postingsIndex + 1]) : "";
      const slug = rawSlug
        ? decodeURIComponent(rawSlug).replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "")
        : "";
      const firstDash = slug.indexOf("-");
      return firstDash > 0 ? oneLine(slug.slice(0, firstDash)) : "";
    }

    if (normalizedPlatform === "applytojob") {
      const firstHostPart = oneLine(parsedUrl.hostname.split(".")[0]);
      return firstHostPart === "www" || firstHostPart === "applytojob" ? "" : firstHostPart;
    }

    if (
      normalizedPlatform === "lever" ||
      normalizedPlatform === "ashby" ||
      normalizedPlatform === "ashbyhq" ||
      normalizedPlatform === "jobvite"
    ) {
      return oneLine(parsedUrl.pathname.split("/").filter(Boolean)[0]);
    }
  } catch {
    return "";
  }

  return "";
}

function jobTitleFromBidUrl(url, platform) {
  try {
    const parsedUrl = new URL(url);
    const normalizedPlatform = oneLine(platform).toLowerCase();

    if (normalizedPlatform === "applytojob") {
      const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
      const applyIndex = pathParts.findIndex((part) => part.toLowerCase() === "apply");
      return applyIndex >= 0 && pathParts[applyIndex + 2]
        ? oneLine(decodeURIComponent(pathParts[applyIndex + 2]))
        : "";
    }

    if (normalizedPlatform === "gusto") {
      const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
      const postingsIndex = pathParts.findIndex((part) => part.toLowerCase() === "postings");
      const slug = postingsIndex >= 0 ? oneLine(pathParts[postingsIndex + 1]) : "";
      if (!slug) return "";

      const cleanedSlug = decodeURIComponent(slug)
        .replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "")
        .split("-")
        .slice(1)
        .join("-");

      return oneLine(cleanedSlug);
    }

    if (normalizedPlatform === "recruitee") {
      const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
      const offerIndex = pathParts.findIndex((part) => part.toLowerCase() === "o");
      return offerIndex >= 0 && pathParts[offerIndex + 1]
        ? oneLine(decodeURIComponent(pathParts[offerIndex + 1]))
        : "";
    }

    if (normalizedPlatform === "rippling") {
      return "";
    }
  } catch {
    return "";
  }

  return "";
}

function formatServerTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: SERVER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short"
  }).format(date);
}

function summaryForRecord(record) {
  const fields = record.manual_fields || {};
  const platform = fieldValue(fields, ["platform"]);
  const bidUrl = fieldValue(fields, ["bid_url"]);
  return {
    id: record.id,
    platform,
    email: fieldValue(fields, ["email", "email_address"]) || fieldValueByKeyIncludes(fields, "email"),
    ip_address: fieldValue(fields, ["ip_address", "ip", "proxy_ip", "capture_ip"]),
    extension: fieldValue(fields, ["extension_version"]),
    extension_build_timestamp: fieldValue(fields, ["extension_build_timestamp"]),
    resume_cv: resumeValueFromFields(fields),
    company_name: fieldValue(fields, ["company_name", "company"]) || companyNameFromBidUrl(bidUrl, platform),
    job_title: fieldValue(fields, ["job_title", "title", "position"]) || jobTitleFromBidUrl(bidUrl, platform),
    bid_time: formatServerTime(record.created_at || fields.created_at)
  };
}

function extensionDisplay(summary) {
  const version = oneLine(summary.extension);

  if (version) return `v${version}`;
  return "";
}

function platformDisplay(platform) {
  const normalized = oneLine(platform).toLowerCase();
  const platformMap = {
    greenhouse: { icon: "G", label: "Greenhouse", className: "platform-greenhouse" },
    lever: { icon: "L", label: "Lever", className: "platform-lever" },
    ashby: { icon: "A", label: "AshbyHQ", className: "platform-ashby" },
    ashbyhq: { icon: "A", label: "AshbyHQ", className: "platform-ashby" },
    workday: { icon: "W", label: "Workday", className: "platform-workday" },
    gusto: { icon: "Gu", label: "Gusto", className: "platform-gusto" },
    applytojob: { icon: "At", label: "ApplyToJob", className: "platform-applytojob" },
    jobvite: { icon: "J", label: "Jobvite", className: "platform-jobvite" },
    bamboohr: { icon: "B", label: "BambooHR", className: "platform-bamboohr" },
    rippling: { icon: "R", label: "Rippling", className: "platform-rippling" },
    recruitee: { icon: "Re", label: "Recruitee", className: "platform-recruitee" }
  };
  const display = platformMap[normalized] || {
    icon: "?",
    label: platform || "Unknown",
    className: "platform-unknown"
  };
  return `<span class="platform-badge ${display.className}">
    <span class="platform-icon" aria-hidden="true">${escapeHtml(display.icon)}</span>
    <span>${escapeHtml(display.label)}</span>
  </span>`;
}

function titleFromKey(key) {
  const text = oneLine(key);
  if (/\s/.test(text) && !text.includes("_")) return text;

  return text
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bCv\b/g, "CV")
    .replace(/\bUs\b/g, "US")
    .replace(/\bUsa\b/g, "USA");
}

function renderReviewValue(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(/\n+/);
  return values
    .map((item) => escapeHtml(oneLine(item)))
    .filter(Boolean)
    .map((item) => `<div>${item}</div>`)
    .join("");
}

function isScalarReviewObject(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => !item || typeof item !== "object" || Array.isArray(item));
}

function renderReviewField(label, value) {
  if (value === undefined || value === null) {
    return "";
  }

  return `<div class="review-field">
    <div class="review-label">${escapeHtml(titleFromKey(label))}</div>
    <div class="review-value">${renderReviewValue(value)}</div>
  </div>`;
}

function visibleReviewEntries(value, options = {}) {
  const hiddenKeys = new Set(options.hiddenKeys || []);
  return Object.entries(value || {}).filter(([childKey, childValue]) => {
    return !hiddenKeys.has(childKey) &&
      childValue !== undefined &&
      childValue !== null &&
      !(typeof childValue === "object" && !Array.isArray(childValue) && !Object.keys(childValue).length);
  });
}

function renderReviewObject(key, value, depth = 0, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return renderReviewField(key, value);
  }

  const entries = visibleReviewEntries(value, options);
  if (!entries.length) return "";

  if (depth > 0 && isScalarReviewObject(value)) {
    return `<section class="review-card depth-${depth}">
      <h${Math.min(depth + 2, 4)} class="review-card-title">${escapeHtml(titleFromKey(key))}</h${Math.min(depth + 2, 4)}>
      <div class="review-field-grid">
        ${entries.map(([childKey, childValue]) => renderReviewField(childKey, childValue)).join("")}
      </div>
    </section>`;
  }

  const headingClass = depth === 0 ? "review-section-title" : "review-group-title";
  return `<section class="review-section depth-${depth}">
    <h${Math.min(depth + 2, 4)} class="${headingClass}">${escapeHtml(titleFromKey(key))}</h${Math.min(depth + 2, 4)}>
    ${entries.map(([childKey, childValue]) => renderReviewObject(childKey, childValue, depth + 1, options)).join("")}
  </section>`;
}

function renderWorkdayReviewDetails(manualFields) {
  const review = manualFields?.workday_review;
  if (!review || typeof review !== "object" || !Object.keys(review).length) {
    return `<pre>${escapeHtml(JSON.stringify(manualFields || {}, null, 2))}</pre>`;
  }

  return `<div class="workday-review">
    <h2 class="review-title">Review</h2>
    ${Object.entries(review).map(([key, value]) => renderReviewObject(key, value, 0)).join("")}
  </div>`;
}

function renderManualFieldsDetails(manualFields) {
  const platform = titleFromKey(manualFields.platform || "Application");
  const entries = visibleReviewEntries(manualFields, {
    hiddenKeys: ["platform"]
  });

  return `<div class="manual-fields-review">
    <h2 class="review-title">${escapeHtml(platform)} Fields</h2>
    <div class="review-field-grid">
      ${entries.map(([key, value]) => {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return renderReviewObject(key, value, 1);
        }
        return renderReviewField(key, value);
      }).join("")}
    </div>
  </div>`;
}

function renderRecordDetails(record) {
  const manualFields = record.manual_fields || {};
  if (oneLine(manualFields.platform).toLowerCase() === "workday") {
    return renderWorkdayReviewDetails(manualFields);
  }

  return renderManualFieldsDetails(manualFields);
}

function pageUrl(page, pageSize) {
  return `/dashboard?page=${encodeURIComponent(page)}&page_size=${encodeURIComponent(pageSize)}`;
}

function tableUrl(page, pageSize) {
  return `/dashboard/table?page=${encodeURIComponent(page)}&page_size=${encodeURIComponent(pageSize)}`;
}

function renderPaginationControls(pagination) {
  const page = pagination?.page || 1;
  const pageSize = pagination?.pageSize || 10;
  const totalItems = pagination?.totalItems || 0;
  const totalPages = pagination?.totalPages || 1;
  const itemStart = totalItems ? (pagination.offset || 0) + 1 : 0;
  const itemEnd = Math.min((pagination.offset || 0) + pageSize, totalItems);
  const pageSizes = [10, 50, 100];

  return `<div class="pagination-bar" aria-label="Pagination">
    <form class="page-size-form" method="get" action="/dashboard">
      <label for="page-size">Item count per page</label>
      <select id="page-size" name="page_size" onchange="this.form.submit()">
        ${pageSizes.map((size) => `<option value="${size}"${size === pageSize ? " selected" : ""}>${size}</option>`).join("")}
      </select>
      <input type="hidden" name="page" value="1">
    </form>
    <div class="page-number">
      <span>Page number</span>
      <a class="page-link${page <= 1 ? " disabled" : ""}" href="${escapeHtml(pageUrl(Math.max(1, page - 1), pageSize))}" aria-label="Previous page">&lsaquo;</a>
      <form class="page-number-form" method="get" action="/dashboard">
        <input type="number" name="page" min="1" max="${escapeHtml(totalPages)}" value="${escapeHtml(page)}" aria-label="Page number">
        <input type="hidden" name="page_size" value="${escapeHtml(pageSize)}">
      </form>
      <span>of ${escapeHtml(totalPages)}</span>
      <a class="page-link${page >= totalPages ? " disabled" : ""}" href="${escapeHtml(pageUrl(Math.min(totalPages, page + 1), pageSize))}" aria-label="Next page">&rsaquo;</a>
    </div>
    <div class="page-summary">${escapeHtml(itemStart)}-${escapeHtml(itemEnd)} of ${escapeHtml(totalItems)}</div>
  </div>`;
}

function renderDashboardTable(records, pagination = { offset: 0 }) {
  if (!records.length) return "<p>No bidding logs yet.</p>";

  const rows = records.map((record, index) => {
    const summary = summaryForRecord(record);
    const detailsId = `details-${escapeHtml(summary.id || crypto.randomBytes(4).toString("hex"))}`;
    const details = renderRecordDetails(record);
    return `<tr>
  <td><button class="toggle expand-icon" type="button" data-target="${detailsId}" aria-expanded="false" aria-label="Expand row" title="Expand row">&#9656;</button></td>
  <td>${escapeHtml((pagination.offset || 0) + index + 1)}</td>
  <td>${platformDisplay(summary.platform)}</td>
  <td>${escapeHtml(summary.email)}</td>
  <td>${escapeHtml(summary.ip_address)}</td>
  <td>${escapeHtml(extensionDisplay(summary))}</td>
  <td>${escapeHtml(summary.resume_cv)}</td>
  <td>${escapeHtml(summary.company_name)}</td>
  <td>${escapeHtml(summary.job_title)}</td>
  <td>${escapeHtml(summary.bid_time)}</td>
</tr>
<tr id="${detailsId}" class="details-row" hidden>
  <td colspan="10">${details}</td>
</tr>`;
  }).join("\n");

  return `<table>
  <thead>
    <tr>
      <th></th>
      <th>ID</th>
      <th>Platform <span class="platform-help" tabindex="0" aria-label="Supported platforms: Greenhouse, Lever, AshbyHQ, Workday, Gusto, ApplyToJob, Jobvite, BambooHR, Rippling, Recruitee">?
        <span class="platform-help-tooltip" role="tooltip">
          <span>Greenhouse</span>
          <span>Lever</span>
          <span>AshbyHQ</span>
          <span>Workday</span>
          <span>Gusto</span>
          <span>ApplyToJob</span>
          <span>Jobvite</span>
          <span>BambooHR</span>
          <span>Rippling</span>
          <span>Recruitee</span>
        </span>
      </span></th>
      <th>Email</th>
      <th>IP Address</th>
      <th>Extension</th>
      <th>Resume CV</th>
      <th>Company Name</th>
      <th>Job Title</th>
      <th>Bid Time</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>`;
}

function renderDashboardTablePanel(records, pagination) {
  return `<div class="dashboard-table-toolbar">
    <div>${renderPaginationControls(pagination)}</div>
    <button class="dashboard-refresh-button" type="button" data-refresh-table-url="${escapeHtml(tableUrl(pagination.page, pagination.pageSize))}" aria-label="Refresh bidding logs" title="Refresh bidding logs">
      <span aria-hidden="true">&#8635;</span>
    </button>
  </div>
  <div id="dashboard-table-content">${renderDashboardTable(records, pagination)}</div>
  ${renderPaginationControls(pagination)}`;
}

function layout({ title, master, active = "", body }) {
  const nav = master ? `<nav>
    <div class="nav-tabs">
        <a class="${active === "dashboard" ? "active" : ""}" href="/dashboard">Dashboard</a>
        ${active === "dashboard" ? `<button class="refresh-button" type="button" data-refresh-table-url="/dashboard/table" aria-label="Refresh bidding logs" title="Refresh bidding logs"><span aria-hidden="true">↻</span></button>` : ""}
      <a class="${active === "settings" ? "active" : ""}" href="/settings">Setting</a>
    </div>
    <form method="post" action="/signout"><button type="submit">Sign out</button></form>
  </nav>` : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; background: #f7f7fb; color: #171721; }
    h1 { margin-bottom: 8px; }
    .hint, .error, .success { margin-bottom: 20px; }
    .hint { color: #5b5b68; }
    .error { color: #b42318; }
    .success { color: #067647; }
    nav { display: flex; gap: 12px; align-items: center; margin: 0 0 24px; }
    nav a, nav button, .button { border: 1px solid #c8c8dd; border-radius: 8px; background: #fff; color: #171721; padding: 8px 12px; text-decoration: none; cursor: pointer; }
    nav a.active { background: #171721; color: #fff; }
    .nav-tabs { display: flex; gap: 12px; align-items: center; }
    .dashboard-nav-item { display: inline-flex; flex-direction: column; gap: 8px; align-items: center; }
    nav .refresh-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      border-radius: 999px;
      padding: 0;
      font-size: 18px;
      line-height: 1;
    }
    nav .refresh-button { display: none; }
    .dashboard-table-toolbar { display: flex; justify-content: space-between; gap: 14px; align-items: center; margin: 0 0 10px; }
    .dashboard-refresh-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      border: 1px solid #c8c8dd;
      border-radius: 999px;
      background: #fff;
      color: #171721;
      padding: 0;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
    }
    .dashboard-refresh-button:hover { background: #f6f6ff; }
    .dashboard-refresh-button:disabled { cursor: wait; opacity: 0.65; }
    .dashboard-refresh-button.is-refreshing span { animation: spin 0.8s linear infinite; }
    nav form { margin-left: auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .card { background: white; border: 1px solid #ddddea; border-radius: 12px; padding: 22px; max-width: 560px; }
    label { display: block; margin: 14px 0 6px; font-weight: 700; }
    input, select { box-sizing: border-box; width: 100%; border: 1px solid #c8c8dd; border-radius: 8px; padding: 10px 12px; font-size: 15px; background: #fff; }
    .form-actions { margin-top: 18px; }
    .pagination-bar { display: flex; flex-wrap: wrap; gap: 12px 18px; align-items: center; margin: 0 0 12px; color: #4d4d5d; font-size: 13px; }
    .dashboard-table-toolbar .pagination-bar { margin: 0; }
    .page-size-form, .page-number-form { display: inline-flex; gap: 8px; align-items: center; margin: 0; }
    .page-size-form label, .pagination-bar label { display: inline; margin: 0; font-weight: 700; }
    .page-size-form select { width: auto; min-width: 78px; padding: 7px 28px 7px 10px; }
    .page-number { display: inline-flex; gap: 8px; align-items: center; }
    .page-number-form input { width: 72px; padding: 7px 8px; text-align: center; }
    .page-link { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: 1px solid #c8c8dd; border-radius: 999px; background: #fff; color: #171721; text-decoration: none; font-size: 18px; line-height: 1; }
    .page-link:hover { background: #f6f6ff; }
    .page-link.disabled { pointer-events: none; opacity: 0.45; }
    .page-summary { color: #6b6b7a; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #ddddea; border-radius: 10px; overflow: hidden; }
    th, td { border-bottom: 1px solid #ececf4; padding: 10px 12px; text-align: left; vertical-align: top; }
    th { background: #f0f0fa; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: #4d4d5d; }
    tr:last-child td { border-bottom: 0; }
    .toggle { border: 1px solid #c8c8dd; border-radius: 6px; background: #fff; padding: 5px 9px; cursor: pointer; }
    .toggle:hover { background: #f6f6ff; }
    .expand-icon { width: 30px; height: 30px; padding: 0; border-radius: 999px; font-size: 14px; line-height: 1; }
    .platform-badge { display: inline-flex; align-items: center; gap: 7px; border-radius: 999px; padding: 4px 9px 4px 5px; font-weight: 600; white-space: nowrap; }
    .platform-icon { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 999px; font-size: 13px; font-weight: 800; background: rgba(255,255,255,0.75); }
    .platform-help { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 17px; height: 17px; margin-left: 5px; border-radius: 999px; background: #fff; border: 1px solid #b8b8cf; color: #3f3f52; font-size: 12px; font-weight: 800; line-height: 1; cursor: help; vertical-align: middle; }
    .platform-help-tooltip { display: none; position: absolute; left: 50%; top: calc(100% + 8px); transform: translateX(-50%); z-index: 20; min-width: 120px; padding: 9px 11px; border-radius: 8px; background: #171721; color: #fff; font-size: 12px; font-weight: 600; letter-spacing: 0; text-transform: none; box-shadow: 0 8px 24px rgba(0,0,0,0.22); white-space: nowrap; text-align: left; }
    .platform-help-tooltip span { display: block; }
    .platform-help-tooltip span + span { margin-top: 5px; }
    .platform-help-tooltip::before { content: ""; position: absolute; left: 50%; top: -5px; transform: translateX(-50%) rotate(45deg); width: 10px; height: 10px; background: #171721; }
    .platform-help:hover .platform-help-tooltip, .platform-help:focus .platform-help-tooltip { display: block; }
    .platform-greenhouse { background: #e6f6ec; color: #17643a; }
    .platform-lever { background: #eaf0ff; color: #2448a6; }
    .platform-ashby { background: #fff1e5; color: #9a4b12; }
    .platform-workday { background: #e8f4ff; color: #075985; }
    .platform-gusto { background: #f4edff; color: #6d28d9; }
    .platform-applytojob { background: #fff7ed; color: #9a3412; }
    .platform-jobvite { background: #ecfeff; color: #155e75; }
    .platform-bamboohr { background: #edf7ee; color: #256329; }
    .platform-rippling { background: #fef3c7; color: #92400e; }
    .platform-recruitee { background: #eef2ff; color: #3730a3; }
    .platform-unknown { background: #eeeef4; color: #555568; }
    .details-row td { background: #fbfbff; padding: 0; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; background: #171721; color: #f7f7fb; padding: 16px; }
    .workday-review, .manual-fields-review { background: #fff; color: #111827; max-width: 900px; margin: 0 auto; padding: 18px 24px 24px; font-size: 13px; line-height: 1.4; box-shadow: inset 4px 0 0 #2563eb; }
    .manual-fields-review { box-shadow: inset 4px 0 0 #6d28d9; }
    .review-title { text-align: center; font-size: 22px; margin: 0 0 16px; padding-bottom: 14px; border-bottom: 1px solid #e5e7eb; }
    .review-section { margin: 0; padding: 0; }
    .review-section.depth-0 + .review-section.depth-0 { border-top: 1px solid #e5e7eb; margin-top: 18px; padding-top: 14px; }
    .review-section-title { text-align: center; font-size: 22px; margin: 0 0 14px; }
    .review-group-title { color: #4b5563; font-size: 17px; margin: 14px 0 10px; }
    .review-section.depth-2 .review-group-title { color: #111827; font-size: 14px; margin-top: 16px; }
    .review-card { background: #fbfdff; border: 1px solid #e5e7eb; border-radius: 10px; margin: 10px 0 14px; padding: 12px 14px; }
    .review-card-title { color: #111827; font-size: 14px; margin: 0 0 10px; }
    .review-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 14px; }
    .review-field { background: #fff; border: 1px solid #edf0f5; border-radius: 8px; margin: 0 0 10px; padding: 8px 10px; }
    .review-field-grid .review-field { margin: 0; }
    .review-label { color: #374151; font-weight: 700; font-size: 12px; margin-bottom: 4px; }
    .review-value { color: #111827; white-space: normal; overflow-wrap: anywhere; }
    .review-value div + div { margin-top: 2px; }
    code { background: #f0f0fa; border-radius: 6px; padding: 3px 6px; }
  </style>
</head>
<body>
  ${nav}
  ${body}
  <script>
    document.addEventListener("click", (event) => {
      const refreshButton = event.target.closest(".dashboard-refresh-button");
      if (refreshButton) {
        const tableContainer = document.getElementById("dashboard-table-container");
        if (!tableContainer) return;

        refreshButton.disabled = true;
        refreshButton.classList.add("is-refreshing");
        refreshButton.setAttribute("aria-label", "Refreshing bidding logs");

        fetch(refreshButton.dataset.refreshTableUrl || "/dashboard/table", {
          headers: { "Accept": "text/html" },
          credentials: "same-origin"
        })
          .then((response) => {
            if (!response.ok) throw new Error("Refresh failed");
            return response.text();
          })
          .then((html) => {
            tableContainer.innerHTML = html;
          })
          .catch(() => {
            tableContainer.insertAdjacentHTML(
              "afterbegin",
              '<div class="error">Could not refresh bidding logs.</div>'
            );
          })
          .finally(() => {
            refreshButton.disabled = false;
            refreshButton.classList.remove("is-refreshing");
            refreshButton.setAttribute("aria-label", "Refresh bidding logs");
          });
        return;
      }

      const button = event.target.closest(".toggle");
      if (!button) return;
      const row = document.getElementById(button.dataset.target);
      if (!row) return;
      const isHidden = row.hasAttribute("hidden");
      row.toggleAttribute("hidden", !isHidden);
      button.setAttribute("aria-expanded", String(isHidden));
      button.setAttribute("aria-label", isHidden ? "Collapse row" : "Expand row");
      button.setAttribute("title", isHidden ? "Collapse row" : "Expand row");
      button.innerHTML = isHidden ? "&#9662;" : "&#9656;";
    });
  </script>
</body>
</html>`;
}

function renderAuthPage({ title, action, submitLabel, error }) {
  const isSignin = action === "/signin";
  return layout({
    title,
    body: `<h1>${escapeHtml(title)}</h1>
    <div class="card">
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      <form method="post" action="${action}">
        <label>User ID</label>
        <input name="email" type="text" autocomplete="username" value="${isSignin ? DEFAULT_ADMIN_ID : ""}" required>
        <label>Password</label>
        <input name="password" type="password" autocomplete="current-password" value="${isSignin ? DEFAULT_ADMIN_PASSWORD : ""}" required>
        <div class="form-actions"><button class="button" type="submit">${escapeHtml(submitLabel)}</button></div>
      </form>
      <p>${action === "/signin" ? `Need an account? <a href="/signup">Sign up</a>.` : `Already have an account? <a href="/signin">Sign in</a>.`}</p>
    </div>`
  });
}

async function requireMaster(request, response, next) {
  const masterId = masterIdFromRequest(request);
  try {
    const master = masterId ? await masterByMasterId(masterId) : null;
    if (!master) {
      response.redirect("/signin");
      return;
    }
    request.master = master;
    next();
  } catch (error) {
    next(error);
  }
}

function renderDashboardPage({ master = null, records, pagination }) {
  return layout({
    title: "Dashboard",
    master,
    active: "dashboard",
    body: `<div id="dashboard-table-container">${renderDashboardTablePanel(records, pagination)}</div>`
  });
}

function renderSettingsPage({ master, success = false, error = "" }) {
  return layout({
    title: "Setting",
    master,
    active: "settings",
    body: `<h1>Setting</h1>
      <div class="card">
        ${success ? `<div class="success">BIDDER_PASSWORD updated.</div>` : ""}
        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
        <p>Give this Master User ID to the bidder extension:</p>
        <p><code>${escapeHtml(master.email)}</code></p>
        <form method="post" action="/settings/bidder-password">
          <label>BIDDER_PASSWORD</label>
          <input name="bidder_password" type="password" autocomplete="new-password" required>
          <div class="form-actions"><button class="button" type="submit">Save BIDDER_PASSWORD</button></div>
        </form>
      </div>`
  });
}

function createApp() {
  const app = express();

  app.use((request, response, next) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/", (request, response) => {
    response.redirect(masterIdFromRequest(request) ? "/dashboard" : "/signin");
  });

  app.get("/signup", (_request, response) => {
    response.type("html").send(renderAuthPage({ title: "Master Sign Up", action: "/signup", submitLabel: "Sign up" }));
  });

  app.post("/signup", async (request, response) => {
    const email = oneLine(request.body.email).toLowerCase();
    const password = String(request.body.password || "");
    if (!email || password.length < 6) {
      response.status(400).type("html").send(renderAuthPage({ title: "Master Sign Up", action: "/signup", submitLabel: "Sign up", error: "User ID and password with at least 6 characters are required." }));
      return;
    }
    if (await masterByEmail(email)) {
      response.status(409).type("html").send(renderAuthPage({ title: "Master Sign Up", action: "/signup", submitLabel: "Sign up", error: "That User ID is already registered." }));
      return;
    }
    const master = await createMaster({ email, password });
    setSessionCookie(response, master.master_id);
    response.redirect("/settings");
  });

  app.get("/signin", (_request, response) => {
    response.type("html").send(renderAuthPage({ title: "Master Sign In", action: "/signin", submitLabel: "Sign in" }));
  });

  app.post("/signin", async (request, response) => {
    const email = oneLine(request.body.email).toLowerCase();
    const password = String(request.body.password || "");
    const master = await masterByEmail(email);
    const ok = master ? await verifyPassword(password, master.password_hash) : false;
    if (!ok) {
      response.status(401).type("html").send(renderAuthPage({ title: "Master Sign In", action: "/signin", submitLabel: "Sign in", error: "Invalid email or password." }));
      return;
    }
    setSessionCookie(response, master.master_id);
    response.redirect("/dashboard");
  });

  app.post("/signout", (_request, response) => {
    clearSessionCookie(response);
    response.redirect("/signin");
  });

  app.get("/dashboard", requireMaster, async (request, response) => {
    const { page, pageSize } = paginationFromQuery(request.query);
    const { records, pagination } = await logsPageForMaster(request.master.master_id, { page, pageSize });
    response.type("html").send(renderDashboardPage({
      master: request.master,
      records,
      pagination
    }));
  });

  app.get("/dashboard/table", requireMaster, async (request, response) => {
    const { page, pageSize } = paginationFromQuery(request.query);
    const { records, pagination } = await logsPageForMaster(request.master.master_id, { page, pageSize });
    response.type("html").send(renderDashboardTablePanel(records, pagination));
  });

  app.get("/settings", requireMaster, (request, response) => {
    const success = request.query.saved === "1";
    response.type("html").send(renderSettingsPage({
      master: request.master,
      success
    }));
  });

  app.post("/settings/bidder-password", requireMaster, async (request, response) => {
    const bidderPassword = String(request.body.bidder_password || "");
    if (bidderPassword.length < 6) {
      response.status(400).type("html").send(renderSettingsPage({
        master: request.master,
        error: "BIDDER_PASSWORD must be at least 6 characters."
      }));
      return;
    }
    await updateBidderPassword(request.master.master_id, bidderPassword);
    response.redirect("/settings?saved=1");
  });

  app.post("/api/bidder/test-connection", async (request, response) => {
    const master = await verifyBidderCredentials(request.body.master_user_id, request.body.bidder_password);
    if (!master) {
      response.status(401).json({ ok: false, error: "Invalid master_user_id or BIDDER_PASSWORD." });
      return;
    }
    response.json({ ok: true, master_user_id: master.email });
  });

  app.post("/api/bidding-logs", async (request, response) => {
    const master = await verifyBidderCredentials(request.body.master_user_id, request.body.bidder_password);
    if (!master) {
      response.status(401).json({ ok: false, error: "Invalid master_user_id or BIDDER_PASSWORD." });
      return;
    }

    const manualFields = request.body.manual_fields;
    if (!manualFields || typeof manualFields !== "object" || Array.isArray(manualFields)) {
      response.status(400).json({ ok: false, error: "Expected manual_fields object." });
      return;
    }

    const result = await insertBiddingLog(master.master_id, manualFields);
    response.status(201).json({ ok: true, id: result.id });
  });

  return app;
}

async function startServer() {
  await initDatabase();
  await ensureDefaultAdmin();

  createApp().listen(PORT, HOST, () => {
    console.log(`Bidding logs dashboard: http://${HOST}:${PORT}`);
    console.log(dbKind === "postgres"
      ? "Database: Postgres via DATABASE_URL"
      : `SQLite database: ${DB_FILE}`);
    console.log(`Default sign-in: ${DEFAULT_ADMIN_ID} / ${DEFAULT_ADMIN_PASSWORD}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start bidding dashboard:", error);
  process.exitCode = 1;
});
