const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3040);
const ROOT = path.join(__dirname, "..");
const FRONTEND_DIR = path.join(ROOT, "frontend");
const DB_PATH = path.join(ROOT, "database", "akb-db.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

function readDb() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function defaultRoles() {
  return [
    { id: "admin", name: "Admin", permissions: { dashboard: true, servicesView: true, servicesExport: true, servicesCreate: true, servicesEdit: true, servicesDelete: true, usersManage: true, rolesManage: true, activityLog: true, settings: true }, system: true },
    { id: "staff", name: "Staff", permissions: { dashboard: true, servicesView: true, servicesExport: true, servicesCreate: true, servicesEdit: true, servicesDelete: true, usersManage: false, rolesManage: false, activityLog: false, settings: false }, system: true },
    { id: "callcenter", name: "Call Center", permissions: { dashboard: false, servicesView: true, servicesExport: true, servicesCreate: false, servicesEdit: false, servicesDelete: false, usersManage: false, rolesManage: false, activityLog: false, settings: false }, system: true }
  ];
}

function ensureRoles(db) {
  const existing = Array.isArray(db.roles) ? db.roles : [];
  const byId = new Map(existing.map(role => [role.id, role]));
  for (const role of defaultRoles()) {
    const current = byId.get(role.id) || {};
    byId.set(role.id, { ...role, ...current, permissions: { ...role.permissions, ...(current.permissions || {}) }, system: true });
  }
  db.roles = Array.from(byId.values());
  return db.roles;
}

function publicRole(role) {
  return { id: role.id, name: role.name, permissions: role.permissions || {}, system: Boolean(role.system) };
}

function writeStaticFrontendDb(db) {
  ensureRoles(db);
  const staticDb = {
    services: db.services || [],
    categories: db.categories || [],
    categoriesAr: db.categoriesAr || {},
    departments: db.departments || [],
    changeLog: db.changeLog || [],
    auditLog: db.auditLog || [],
    teams: (db.teams || []).map(publicTeam),
    roles: (db.roles || []).map(publicRole)
  };
  fs.writeFileSync(
    path.join(FRONTEND_DIR, "services-data.js"),
    `window.AKB_STATIC_DB = ${JSON.stringify(staticDb, null, 2)};\n`
  );
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  writeStaticFrontendDb(db);
}

function backupFilename() {
  return `akb-db-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
}

function validateImportedDb(input) {
  if (!input || typeof input !== "object") return "Backup file must be a JSON object";
  if (!Array.isArray(input.services)) return "Backup JSON must include a services array";
  if (!Array.isArray(input.categories)) return "Backup JSON must include a categories array";
  if (!Array.isArray(input.departments)) return "Backup JSON must include a departments array";
  for (const service of input.services) {
    if (!service || typeof service !== "object" || !service.id || !service.title) return "Every service must include id and title";
  }
  return "";
}

function normalizedImportedDb(input, currentDb) {
  const imported = { ...input };
  imported.users = Array.isArray(imported.users) ? imported.users : (currentDb.users || []);
  imported.teams = Array.isArray(imported.teams) ? imported.teams : (currentDb.teams || []);
  imported.roles = Array.isArray(imported.roles) ? imported.roles : (currentDb.roles || []);
  imported.changeLog = Array.isArray(imported.changeLog) ? imported.changeLog : [];
  imported.auditLog = Array.isArray(imported.auditLog) ? imported.auditLog : [];
  imported.categoriesAr = imported.categoriesAr || {};
  ensureRoles(imported);
  return imported;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function sendPdf(res, filename, buffer) {
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9_.-]/g, "-")}"`,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(buffer);
}

function plainText(value) {
  return String(value || "")
    .replace(/[\u0600-\u06FF]/g, "")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pdfEscape(value) {
  return plainText(value).replace(/[\\()]/g, "\\$&");
}

function wrapText(value, width = 92) {
  const words = plainText(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (test.length <= width || !line) line = test;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : ["Not added"];
}

function pdfServiceFilename(service, subService) {
  const raw = [service.title, subService?.title].filter(Boolean).join("-") || "AKB-Service";
  const safe = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "akb-service";
  return `AKB-${safe}-${new Date().toISOString().slice(0, 10)}.pdf`;
}

function serviceExportSections(service, subService) {
  const validation = subService?.validation || {};
  const feeItems = subService?.feeItems || [];
  const feeLines = subService?.feeMatrix
    ? (subService.feeMatrix.rows || []).map(row => {
      const cells = (subService.feeMatrix.columns || []).map(column => `${column.label || column.labelAr}: ${row.values?.[column.key] || "-"}`);
      return `${row.label || row.labelAr}: ${cells.join(" | ")}`;
    })
    : feeItems.length
      ? feeItems.map(item => `${item.label || item.name || "Fee"}: ${item.amount || "Confirm"}${item.appliesWhen ? ` | Applies when: ${item.appliesWhen}` : ""}`)
      : [subService?.fees || service.fees || "Confirm with operations"];
  return [
    ["Service", [service.title]],
    ["Exact Service", [subService?.title || service.title]],
    ["Category", [service.category]],
    ["Department", [service.department]],
    ["Summary", [subService?.summary || service.summary]],
    ["Processing Time", [subService?.processingTime || service.processingTime || "Confirm with operations"]],
    ["Fees", feeLines],
    ["Validation", [
      `Gender: ${validation.gender || "Not specified"}`,
      `Nationality: ${validation.nationality || "Not specified"}`,
      `Age: ${validation.age || "Not specified"}`,
      validation.notes || "No validation notes added"
    ]],
    ["Requirements", subService?.requirements || service.requirements || []],
    ["Employee Steps", subService?.steps || service.steps || []],
    ["Call Center Script", [subService?.callCenterScript || service.callCenterScript || "Not added"]],
    ["Internal Notes", [subService?.internalNotes || service.internalNotes || "Not added"]],
    ["Escalation", [service.escalationContact || "Not added"]]
  ];
}

function buildServicePdf(service, subService) {
  const pageW = 595.28;
  const pageH = 841.89;
  const margin = 46;
  const lines = [];
  lines.push({ type: "title", text: subService?.title || service.title });
  lines.push({ type: "meta", text: "AKB - Aamer Knowledge Base | Internal company document" });
  lines.push({ type: "gap" });
  for (const [title, values] of serviceExportSections(service, subService)) {
    lines.push({ type: "section", text: title });
    const items = Array.isArray(values) && values.length ? values : ["Not added"];
    for (const item of items) {
      for (const wrapped of wrapText(item)) lines.push({ type: "body", text: wrapped });
    }
    lines.push({ type: "gap" });
  }

  const pages = [];
  let current = [];
  let y = 730;
  for (const line of lines) {
    const h = line.type === "title" ? 28 : line.type === "section" ? 22 : line.type === "gap" ? 10 : 16;
    if (y - h < 88 && current.length) {
      pages.push(current);
      current = [];
      y = 730;
    }
    current.push(line);
    y -= h;
  }
  if (current.length) pages.push(current);

  const objects = [];
  const pageNums = [];
  const fontRegular = 1;
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const fontBold = 2;
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

  pages.forEach((pageLines, pageIndex) => {
    const commands = [];
    commands.push("q 0.96 0.97 0.99 rg 0 0 595.28 841.89 re f Q");
    commands.push("q 0.04 0.12 0.23 rg 0 786 595.28 55 re f Q");
    commands.push("q 0.79 0.13 0.20 rg 0 779 595.28 7 re f Q");
    commands.push("BT /F2 24 Tf 1 1 1 rg 46 808 Td (AAMER AKB) Tj ET");
    commands.push("BT /F1 10 Tf 1 1 1 rg 46 794 Td (Internal Knowledge Base) Tj ET");
    commands.push("q 0.04 0.12 0.23 rg 0 0 595.28 48 re f Q");
    commands.push(`BT /F1 8 Tf 1 1 1 rg 46 28 Td (${pdfEscape("Aamer Knowledge Base | Internal company document | For employees and call center only")}) Tj ET`);
    commands.push(`BT /F1 8 Tf 1 1 1 rg 504 28 Td (${pageIndex + 1} / ${pages.length}) Tj ET`);
    commands.push("q 0.88 0.90 0.94 rg 78 275 440 130 re f Q");
    commands.push("BT /F2 72 Tf 0.80 0.13 0.20 rg 168 340 Td (AKB) Tj ET");
    commands.push("BT /F2 52 Tf 0.04 0.12 0.23 rg 144 292 Td (AAMER) Tj ET");
    let textY = 742;
    for (const line of pageLines) {
      if (line.type === "gap") { textY -= 10; continue; }
      if (line.type === "title") {
        commands.push(`BT /F2 20 Tf 0.04 0.12 0.23 rg ${margin} ${textY} Td (${pdfEscape(line.text)}) Tj ET`);
        textY -= 28;
      } else if (line.type === "meta") {
        commands.push(`BT /F1 10 Tf 0.79 0.13 0.20 rg ${margin} ${textY} Td (${pdfEscape(line.text)}) Tj ET`);
        textY -= 18;
      } else if (line.type === "section") {
        commands.push(`q 0.93 0.95 0.97 rg ${margin} ${textY - 4} 504 18 re f Q`);
        commands.push(`q 0.79 0.13 0.20 rg ${margin} ${textY - 4} 4 18 re f Q`);
        commands.push(`BT /F2 11 Tf 0.04 0.12 0.23 rg ${margin + 10} ${textY} Td (${pdfEscape(line.text)}) Tj ET`);
        textY -= 22;
      } else {
        commands.push(`BT /F1 10 Tf 0.08 0.12 0.12 rg ${margin + 10} ${textY} Td (${pdfEscape("- " + line.text)}) Tj ET`);
        textY -= 16;
      }
    }
    const content = commands.join("\n");
    const contentObj = objects.length + 1;
    objects.push(`<< /Length ${Buffer.byteLength(content, "binary")} >>\nstream\n${content}\nendstream`);
    const pageObj = objects.length + 1;
    pageNums.push(pageObj);
    objects.push(`<< /Type /Page /Parent PAGES_REF 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentObj} 0 R >>`);
  });

  const pagesObj = objects.length + 1;
  objects.push(`<< /Type /Pages /Kids [${pageNums.map(num => `${num} 0 R`).join(" ")}] /Count ${pageNums.length} >>`);
  const catalogObj = objects.length + 1;
  objects.push(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  for (let i = 0; i < objects.length; i += 1) objects[i] = objects[i].replaceAll("PAGES_REF", String(pagesObj));
  let pdf = "%PDF-1.4\n%AKB\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf, "binary")); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { pdf += `${String(offset).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObj} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

function normalizeRoleValue(role) {
  if (role === "editor") return "staff";
  if (role === "viewer") return "callcenter";
  return slug(role || "callcenter");
}

function roleExists(db, roleId) {
  return ensureRoles(db).some(role => role.id === normalizeRoleValue(roleId));
}

function publicTeam(team) {
  return {
    id: team.id,
    name: team.name,
    username: team.username,
    role: normalizeRoleValue(team.role),
    email: team.email || "",
    phone: team.phone || "",
    createdAt: team.createdAt || null,
    updatedAt: team.updatedAt || null,
    updatedBy: team.updatedBy || null
  };
}

function hasRolePermission(db, roleId, permission) {
  const normalized = normalizeRoleValue(roleId);
  if (normalized === "admin") return true;
  const role = ensureRoles(db).find(item => item.id === normalized);
  return Boolean(role?.permissions?.[permission]);
}

function isAdminInput(input, db, permission = "rolesManage") {
  return normalizeRoleValue(input?.actorRole) === "admin" || hasRolePermission(db, input?.actorRole, permission);
}

function addAuditLog(db, entry) {
  db.auditLog = db.auditLog || [];
  db.auditLog.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...entry
  });
}

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || crypto.randomUUID();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 15_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function textForService(service) {
  const subServiceText = (service.subServices || []).map(subService => [
    subService.title,
    subService.titleAr,
    subService.summary,
    subService.summaryAr,
    subService.fees,
    subService.feesAr,
    subService.processingTime,
    subService.processingTimeAr,
    subService.requirements?.join(" "),
    subService.requirementsAr?.join(" "),
    subService.steps?.join(" "),
    subService.stepsAr?.join(" "),
    subService.validation?.gender,
    subService.validation?.nationality,
    subService.validation?.age,
    subService.validation?.notes,
    subService.validationAr?.gender,
    subService.validationAr?.nationality,
    subService.validationAr?.age,
    subService.validationAr?.notes,
    subService.callCenterScript,
    subService.callCenterScriptAr,
    subService.internalNotes,
    subService.internalNotesAr
  ].join(" ")).join(" ");

  return [
    service.title,
    service.titleAr,
    service.category,
    service.categoryAr,
    service.department,
    service.summary,
    service.summaryAr,
    service.audience,
    service.tags?.join(" "),
    service.requirements?.join(" "),
    service.requirementsAr?.join(" "),
    service.steps?.join(" "),
    service.faqs?.map(faq => `${faq.question} ${faq.answer}`).join(" "),
    service.callCenterScript,
    service.callCenterScriptAr,
    service.internalNotes,
    service.internalNotesAr,
    service.escalationContact,
    subServiceText
  ].join(" ");
}

function serviceHasSubService(service, subServiceId) {
  if (!subServiceId) return true;
  return (service.subServices || []).some(item => normalize(item.id) === normalize(subServiceId));
}

function serviceMatchesValidation(service, filters) {
  const gender = normalize(filters.gender);
  const nationality = normalize(filters.nationality);
  if (!gender && !nationality) return true;
  return (service.subServices || []).some(item => {
    const itemGender = normalize(item.validation?.gender || "Any");
    const itemNationality = normalize(item.validation?.nationality || "All nationalities");
    const genderOk = !gender || itemGender === "any" || itemGender === gender;
    const nationalityOk = !nationality || itemNationality === "all nationalities" || itemNationality.includes(nationality);
    return genderOk && nationalityOk;
  });
}

function searchServices(db, query, filters) {
  const q = normalize(query);
  const category = normalize(filters.category);
  const department = normalize(filters.department);
  const status = normalize(filters.status || "published");
  const subServiceId = filters.subServiceId || "";

  return db.services
    .filter(service => !status || normalize(service.status) === status)
    .filter(service => !category || normalize(service.category) === category)
    .filter(service => !department || normalize(service.department) === department)
    .filter(service => serviceHasSubService(service, subServiceId))
    .filter(service => serviceMatchesValidation(service, filters))
    .filter(service => !q || normalize(textForService(service)).includes(q))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function formatAed(amount) {
  const number = Number(amount);
  if (!Number.isFinite(number) || number <= 0) return "";
  return `AED ${number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function feeAmounts(value) {
  const text = String(value || "");
  return [...text.matchAll(/(?:AED|درهم)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/gi)]
    .map(match => {
      const amount = Number(match[1].replace(/,/g, ""));
      const before = text.slice(Math.max(0, match.index - 45), match.index).toLowerCase();
      const after = text.slice(match.index, Math.min(text.length, match.index + 80)).toLowerCase();
      return amount === 500 && /reject|rejection|رفض/.test(before + after) ? null : amount;
    })
    .filter(amount => Number.isFinite(amount) && amount > 0);
}

function buildPricing(service) {
  return {
    currency: "AED",
    serviceFee: feeAmounts(service.fees)[0] || null,
    subServiceFees: (service.subServices || []).map(subService => ({
      subServiceId: subService.id,
      title: subService.title,
      amount: feeAmounts(subService.fees)[0] || null,
      currency: "AED"
    }))
  };
}

function applyServicePrices(service, prices = []) {
  const byId = new Map();
  const byTitle = new Map();
  for (const item of prices) {
    const amount = Number(item.amount ?? item.price ?? item.value);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const clean = { ...item, amount };
    if (item.subServiceId || item.id) byId.set(String(item.subServiceId || item.id), clean);
    if (item.title || item.name) byTitle.set(normalize(item.title || item.name), clean);
  }
  service.subServices = (service.subServices || []).map(subService => {
    const item = byId.get(String(subService.id || "")) || byTitle.get(normalize(subService.title));
    if (!item) return subService;
    const amountText = formatAed(item.amount);
    return {
      ...subService,
      fees: amountText,
      feeItems: [{ label: subService.title + " fee", amount: amountText, appliesWhen: subService.title }]
    };
  });
  service.pricing = buildPricing(service);
}

function publicService(service) {
  return {
    id: service.id,
    title: service.title,
    titleAr: service.titleAr,
    category: service.category,
    categoryAr: service.categoryAr,
    department: service.department,
    summary: service.summary,
    summaryAr: service.summaryAr,
    audience: service.audience,
    fees: service.fees,
    feeMatrix: service.feeMatrix,
    pricing: service.pricing || buildPricing(service),
    processingTime: service.processingTime,
    requirements: service.requirements,
    requirementsAr: service.requirementsAr,
    subServices: service.subServices || [],
    steps: service.steps,
    stepsAr: service.stepsAr,
    faqs: service.faqs,
    callCenterScript: service.callCenterScript,
    callCenterScriptAr: service.callCenterScriptAr,
    internalNotes: service.internalNotes,
    internalNotesAr: service.internalNotesAr,
    escalationContact: service.escalationContact,
    escalationContactAr: service.escalationContactAr,
    tags: service.tags,
    status: service.status,
    updatedAt: service.updatedAt,
    updatedBy: service.updatedBy
  };
}

function validateService(input) {
  const required = ["title", "category", "department", "summary"];
  for (const key of required) {
    if (!String(input[key] || "").trim()) {
      return `${key} is required`;
    }
  }
  return null;
}

async function handleApi(req, res, url) {
  const db = readDb();

  if (req.method === "POST" && url.pathname === "/api/login") {
    const input = await readBody(req);
    const username = normalize(input.username);
    const password = String(input.password || "");
    const team = (db.teams || []).find(item => normalize(item.username) === username && item.password === password);
    if (!team) {
      addAuditLog(db, { type: "login-failed", actor: username || "unknown", note: "Failed login attempt" });
      writeDb(db);
      return sendJson(res, 401, { error: "Invalid team username or password" });
    }
    addAuditLog(db, { type: "login", actor: team.name, teamId: team.id, note: `Logged in as ${team.name}` });
    writeDb(db);
    return sendJson(res, 200, { team: publicTeam(team) });
  }

  if (req.method === "GET" && url.pathname === "/api/teams") {
    return sendJson(res, 200, { teams: (db.teams || []).map(publicTeam) });
  }

  if (req.method === "POST" && url.pathname === "/api/teams") {
    const input = await readBody(req);
    if (!isAdminInput(input, db, "usersManage")) return sendJson(res, 403, { error: "Only admin can create users" });
    const name = String(input.name || "").trim();
    const username = String(input.username || "").trim();
    const password = String(input.password || "").trim();
    const role = normalizeRoleValue(String(input.role || "callcenter").trim());
    const email = String(input.email || "").trim();
    const phone = String(input.phone || "").trim();
    if (!name || !username || !password) return sendJson(res, 400, { error: "Team name, username, and password are required" });
    if (!roleExists(db, role)) return sendJson(res, 400, { error: "Role does not exist" });
    db.teams = db.teams || [];
    if (db.teams.some(team => normalize(team.username) === normalize(username))) {
      return sendJson(res, 409, { error: "Username already exists" });
    }
    const now = new Date().toISOString();
    const team = { id: slug(username), name, username, password, role, email, phone, createdAt: now, updatedAt: now, updatedBy: input.createdBy || "AKB Admin" };
    db.teams.push(team);
    addAuditLog(db, { type: "team-created", actor: input.createdBy || "AKB Admin", teamId: team.id, note: `Created login for ${team.name} (${team.username}) with ${team.role} access` });
    writeDb(db);
    return sendJson(res, 201, { team: publicTeam(team) });
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/teams/")) {
    const input = await readBody(req);
    if (!isAdminInput(input, db, "usersManage")) return sendJson(res, 403, { error: "Only admin can update users" });
    const id = decodeURIComponent(url.pathname.split("/").pop());
    db.teams = db.teams || [];
    const index = db.teams.findIndex(team => team.id === id);
    if (index === -1) return sendJson(res, 404, { error: "User not found" });

    const current = db.teams[index];
    const name = String(input.name ?? current.name).trim();
    const username = String(input.username ?? current.username).trim();
    const role = normalizeRoleValue(String(input.role ?? current.role).trim());
    const email = String(input.email ?? current.email ?? "").trim();
    const phone = String(input.phone ?? current.phone ?? "").trim();
    const password = String(input.password || "").trim();
    if (!name || !username) return sendJson(res, 400, { error: "Team name and username are required" });
    if (!roleExists(db, role)) return sendJson(res, 400, { error: "Role does not exist" });
    if (db.teams.some((team, teamIndex) => teamIndex !== index && normalize(team.username) === normalize(username))) {
      return sendJson(res, 409, { error: "Username already exists" });
    }
    if (normalizeRoleValue(current.role) === "admin" && role !== "admin") {
      const adminCount = db.teams.filter(team => normalizeRoleValue(team.role) === "admin").length;
      if (adminCount <= 1) return sendJson(res, 400, { error: "AKB must keep at least one admin user" });
    }

    const updated = { ...current, name, username, role, email, phone, updatedAt: new Date().toISOString(), updatedBy: input.updatedBy || "AKB Admin" };
    if (password) updated.password = password;
    db.teams[index] = updated;
    addAuditLog(db, { type: "team-updated", actor: updated.updatedBy, teamId: updated.id, note: `Updated login for ${updated.name} (${updated.username})${password ? " and reset password" : ""}` });
    writeDb(db);
    return sendJson(res, 200, { team: publicTeam(updated) });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/teams/")) {
    const input = await readBody(req);
    if (!isAdminInput(input, db, "usersManage")) return sendJson(res, 403, { error: "Only admin can delete users" });
    const id = decodeURIComponent(url.pathname.split("/").pop());
    db.teams = db.teams || [];
    const index = db.teams.findIndex(team => team.id === id);
    if (index === -1) return sendJson(res, 404, { error: "User not found" });
    const team = db.teams[index];
    if (normalizeRoleValue(team.role) === "admin") {
      const adminCount = db.teams.filter(item => normalizeRoleValue(item.role) === "admin").length;
      if (adminCount <= 1) return sendJson(res, 400, { error: "AKB must keep at least one admin user" });
    }
    db.teams.splice(index, 1);
    addAuditLog(db, { type: "team-deleted", actor: input.updatedBy || "AKB Admin", teamId: team.id, note: `Deleted login for ${team.name} (${team.username})` });
    writeDb(db);
    return sendJson(res, 200, { deleted: true, teamId: id });
  }

  if (req.method === "GET" && url.pathname === "/api/backup-json") {
    const backup = readDb();
    const filename = backupFilename();
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    return res.end(JSON.stringify(backup, null, 2));
  }

  if (req.method === "POST" && url.pathname === "/api/import-json") {
    const input = await readBody(req);
    if (!isAdminInput(input, db, "settings")) return sendJson(res, 403, { error: "Only admin can import database backups" });
    const importedRaw = input.database || input.db || input.backup || input;
    const error = validateImportedDb(importedRaw);
    if (error) return sendJson(res, 400, { error });
    const backupDir = path.join(ROOT, "database", "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, backupFilename()), JSON.stringify(db, null, 2));
    const imported = normalizedImportedDb(importedRaw, db);
    imported.auditLog = imported.auditLog || [];
    imported.auditLog.unshift({ id: crypto.randomUUID(), type: "database-import", actor: input.actor || input.updatedBy || "AKB Admin", at: new Date().toISOString(), note: "Imported database JSON backup" });
    writeDb(imported);
    return sendJson(res, 200, { ok: true, services: imported.services.length, departments: imported.departments.length });
  }

  if (req.method === "GET" && url.pathname === "/api/meta") {
    return sendJson(res, 200, {
      categories: db.categories,
      categoriesAr: db.categoriesAr || {},
      departments: db.departments,
      users: db.users.map(({ password, ...user }) => user),
      teams: (db.teams || []).map(publicTeam),
      roles: ensureRoles(db).map(publicRole)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/roles") {
    return sendJson(res, 200, { roles: ensureRoles(db).map(publicRole) });
  }

  if (req.method === "POST" && url.pathname === "/api/roles") {
    const input = await readBody(req);
    if (!isAdminInput(input, db, "rolesManage")) return sendJson(res, 403, { error: "Only admin can create roles" });
    const id = slug(input.id || input.key || input.name);
    const name = String(input.name || "").trim();
    if (!id || !name) return sendJson(res, 400, { error: "Role name and key are required" });
    ensureRoles(db);
    if (db.roles.some(role => role.id === id)) return sendJson(res, 409, { error: "Role already exists" });
    const role = { id, name, permissions: input.permissions || {}, system: false };
    db.roles.push(role);
    addAuditLog(db, { type: "role-created", actor: input.updatedBy || "AKB Admin", note: "Created role " + role.name });
    writeDb(db);
    return sendJson(res, 201, { role: publicRole(role) });
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/roles/")) {
    const input = await readBody(req);
    if (!isAdminInput(input, db, "rolesManage")) return sendJson(res, 403, { error: "Only admin can update roles" });
    const id = decodeURIComponent(url.pathname.split("/").pop());
    ensureRoles(db);
    const index = db.roles.findIndex(role => role.id === id);
    if (index === -1) return sendJson(res, 404, { error: "Role not found" });
    const current = db.roles[index];
    const newId = current.system ? current.id : slug(input.id || input.key || current.id);
    const name = String(input.name || current.name || "").trim();
    if (!newId || !name) return sendJson(res, 400, { error: "Role name and key are required" });
    if (newId !== current.id && db.roles.some(role => role.id === newId)) return sendJson(res, 409, { error: "Role key already exists" });
    const updated = { ...current, id: newId, name, permissions: input.permissions || current.permissions || {} };
    db.roles[index] = updated;
    if (newId !== current.id) db.teams = (db.teams || []).map(team => normalizeRoleValue(team.role) === current.id ? { ...team, role: newId } : team);
    addAuditLog(db, { type: "role-updated", actor: input.updatedBy || "AKB Admin", note: "Updated role " + updated.name });
    writeDb(db);
    return sendJson(res, 200, { role: publicRole(updated) });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/roles/")) {
    const input = await readBody(req);
    if (!isAdminInput(input, db, "rolesManage")) return sendJson(res, 403, { error: "Only admin can delete roles" });
    const id = decodeURIComponent(url.pathname.split("/").pop());
    ensureRoles(db);
    const index = db.roles.findIndex(role => role.id === id);
    if (index === -1) return sendJson(res, 404, { error: "Role not found" });
    const role = db.roles[index];
    if (role.system) return sendJson(res, 400, { error: "System roles cannot be deleted" });
    if ((db.teams || []).some(team => normalizeRoleValue(team.role) === id)) return sendJson(res, 400, { error: "Move users to another role before deleting" });
    db.roles.splice(index, 1);
    addAuditLog(db, { type: "role-deleted", actor: input.updatedBy || "AKB Admin", note: "Deleted role " + role.name });
    writeDb(db);
    return sendJson(res, 200, { deleted: true, roleId: id });
  }

  if (req.method === "GET" && url.pathname === "/api/services") {
    const services = searchServices(db, url.searchParams.get("q"), {
      category: url.searchParams.get("category"),
      department: url.searchParams.get("department"),
      subServiceId: url.searchParams.get("subService"),
      gender: url.searchParams.get("gender"),
      nationality: url.searchParams.get("nationality"),
      status: url.searchParams.get("status")
    }).map(publicService);
    return sendJson(res, 200, { services });
  }


  if (req.method === "GET" && url.pathname.startsWith("/api/services/") && url.pathname.endsWith("/export")) {
    const parts = url.pathname.split("/");
    const id = decodeURIComponent(parts[3] || "");
    const service = db.services.find(item => item.id === id);
    if (!service) return sendJson(res, 404, { error: "Service not found" });
    const subServiceId = url.searchParams.get("subService") || "";
    const subServices = service.subServices || [];
    const subService = subServices.find(item => item.id === subServiceId) || subServices[0] || null;
    const filename = pdfServiceFilename(service, subService);
    return sendPdf(res, filename, buildServicePdf(service, subService));
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/services/")) {
    const id = url.pathname.split("/").pop();
    const service = db.services.find(item => item.id === id);
    if (!service) return sendJson(res, 404, { error: "Service not found" });
    return sendJson(res, 200, { service: publicService(service) });
  }

  if (req.method === "POST" && url.pathname === "/api/services") {
    const input = await readBody(req);
    const error = validateService(input);
    if (error) return sendJson(res, 400, { error });

    const now = new Date().toISOString();
    const service = {
      id: crypto.randomUUID(),
      title: input.title.trim(),
      titleAr: input.titleAr?.trim() || "",
      category: input.category.trim(),
      department: input.department.trim(),
      summary: input.summary.trim(),
      summaryAr: input.summaryAr?.trim() || "",
      audience: input.audience?.trim() || "Internal employees and call center",
      fees: input.fees?.trim() || "Confirm with operations",
      processingTime: input.processingTime?.trim() || "Confirm with operations",
      requirements: input.requirements || [],
      requirementsAr: input.requirementsAr || [],
      subServices: input.subServices || (input.requirements || []).map((title, index) => ({
        id: crypto.randomUUID(),
        title,
        fees: input.fees?.trim() || "Confirm with operations",
        processingTime: input.processingTime?.trim() || "Confirm with operations",
        requirements: ["Employee-confirmed requirements will be added here."],
        steps: [],
        validation: { gender: "Any", nationality: "All nationalities", age: "Not specified yet", notes: "No validation restriction confirmed yet." }
      })),
      steps: input.steps || [],
      stepsAr: input.stepsAr || [],
      faqs: input.faqs || [],
      callCenterScript: input.callCenterScript?.trim() || "",
      callCenterScriptAr: input.callCenterScriptAr?.trim() || "",
      internalNotes: input.internalNotes?.trim() || "",
      internalNotesAr: input.internalNotesAr?.trim() || "",
      escalationContact: input.escalationContact?.trim() || "",
      tags: input.tags || [],
      status: input.status || "published",
      updatedAt: now,
      updatedBy: input.updatedBy || "AKB Admin"
    };

    db.services.push(service);
    db.changeLog.unshift({
      id: crypto.randomUUID(),
      serviceId: service.id,
      action: "created",
      actor: service.updatedBy,
      at: now,
      note: `Created ${service.title}`
    });
    addAuditLog(db, { type: "service-created", actor: service.updatedBy, serviceId: service.id, note: `Created service ${service.title}` });
    writeDb(db);
    return sendJson(res, 201, { service: publicService(service) });
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/services/") && url.pathname.endsWith("/prices")) {
    const parts = url.pathname.split("/");
    const id = decodeURIComponent(parts[3]);
    const index = db.services.findIndex(item => item.id === id);
    if (index === -1) return sendJson(res, 404, { error: "Service not found" });
    const input = await readBody(req);
    applyServicePrices(db.services[index], input.prices || input.subServiceFees || []);
    db.services[index].updatedAt = new Date().toISOString();
    db.services[index].updatedBy = input.updatedBy || "AKB Admin";
    db.changeLog.unshift({
      id: crypto.randomUUID(),
      serviceId: id,
      action: "updated",
      actor: db.services[index].updatedBy,
      at: db.services[index].updatedAt,
      note: `Updated prices for ${db.services[index].title}`
    });
    addAuditLog(db, { type: "service-prices-updated", actor: db.services[index].updatedBy, serviceId: id, note: `Updated prices for ${db.services[index].title}` });
    writeDb(db);
    return sendJson(res, 200, { service: publicService(db.services[index]) });
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/services/")) {
    const id = url.pathname.split("/").pop();
    const index = db.services.findIndex(item => item.id === id);
    if (index === -1) return sendJson(res, 404, { error: "Service not found" });

    const input = await readBody(req);
    const merged = { ...db.services[index], ...input };
    const error = validateService(merged);
    if (error) return sendJson(res, 400, { error });

    merged.updatedAt = new Date().toISOString();
    merged.updatedBy = input.updatedBy || "AKB Admin";
    db.services[index] = merged;
    db.changeLog.unshift({
      id: crypto.randomUUID(),
      serviceId: merged.id,
      action: "updated",
      actor: merged.updatedBy,
      at: merged.updatedAt,
      note: `Updated ${merged.title}`
    });
    addAuditLog(db, { type: "service-updated", actor: merged.updatedBy, serviceId: merged.id, note: `Updated service ${merged.title}` });
    writeDb(db);
    return sendJson(res, 200, { service: publicService(merged) });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/services/")) {
    const id = url.pathname.split("/").pop();
    const index = db.services.findIndex(item => item.id === id);
    if (index === -1) return sendJson(res, 404, { error: "Service not found" });

    const [service] = db.services.splice(index, 1);
    const now = new Date().toISOString();
    db.changeLog.unshift({
      id: crypto.randomUUID(),
      serviceId: service.id,
      action: "deleted",
      actor: "AKB Admin",
      at: now,
      note: `Deleted ${service.title}`
    });
    addAuditLog(db, { type: "service-deleted", actor: "AKB Admin", serviceId: service.id, note: `Deleted service ${service.title}` });
    writeDb(db);
    return sendJson(res, 200, { deleted: true, serviceId: id });
  }

  if (req.method === "GET" && url.pathname === "/api/change-log") {
    return sendJson(res, 200, { changeLog: (db.changeLog || []).slice(0, 100) });
  }

  if (req.method === "GET" && url.pathname === "/api/audit-log") {
    return sendJson(res, 200, { auditLog: (db.auditLog || []).slice(0, 100) });
  }

  return sendJson(res, 404, { error: "API route not found" });
}

function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(FRONTEND_DIR, requestedPath));
  if (!filePath.startsWith(FRONTEND_DIR)) {
    return sendText(res, 403, "Forbidden");
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      fs.readFile(path.join(FRONTEND_DIR, "index.html"), (indexError, indexContent) => {
        if (indexError) return sendText(res, 404, "Not found");
        res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
        res.end(indexContent);
      });
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`AKB is running at http://localhost:${PORT}`);
});
