const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4000);
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

function writeStaticFrontendDb(db) {
  const staticDb = {
    services: db.services || [],
    categories: db.categories || [],
    categoriesAr: db.categoriesAr || {},
    departments: db.departments || [],
    changeLog: db.changeLog || [],
    auditLog: db.auditLog || [],
    teams: (db.teams || []).map(publicTeam)
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

function publicTeam(team) {
  return {
    id: team.id,
    name: team.name,
    username: team.username,
    role: team.role,
    createdAt: team.createdAt || null,
    updatedAt: team.updatedAt || null,
    updatedBy: team.updatedBy || null
  };
}

function isAdminInput(input) {
  return input?.actorRole === "admin";
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
      if (data.length > 1_000_000) {
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
    processingTime: service.processingTime,
    requirements: service.requirements,
    requirementsAr: service.requirementsAr,
    subServices: service.subServices || [],
    steps: service.steps,
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
    if (!isAdminInput(input)) return sendJson(res, 403, { error: "Only admin can create users" });
    const name = String(input.name || "").trim();
    const username = String(input.username || "").trim();
    const password = String(input.password || "").trim();
    const role = String(input.role || "viewer").trim();
    if (!name || !username || !password) return sendJson(res, 400, { error: "Team name, username, and password are required" });
    if (!["admin", "editor", "viewer"].includes(role)) return sendJson(res, 400, { error: "Role must be admin, editor, or viewer" });
    db.teams = db.teams || [];
    if (db.teams.some(team => normalize(team.username) === normalize(username))) {
      return sendJson(res, 409, { error: "Username already exists" });
    }
    const now = new Date().toISOString();
    const team = { id: slug(username), name, username, password, role, createdAt: now, updatedAt: now, updatedBy: input.createdBy || "AKB Admin" };
    db.teams.push(team);
    addAuditLog(db, { type: "team-created", actor: input.createdBy || "AKB Admin", teamId: team.id, note: `Created login for ${team.name} (${team.username}) with ${team.role} access` });
    writeDb(db);
    return sendJson(res, 201, { team: publicTeam(team) });
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/teams/")) {
    const input = await readBody(req);
    if (!isAdminInput(input)) return sendJson(res, 403, { error: "Only admin can update users" });
    const id = decodeURIComponent(url.pathname.split("/").pop());
    db.teams = db.teams || [];
    const index = db.teams.findIndex(team => team.id === id);
    if (index === -1) return sendJson(res, 404, { error: "User not found" });

    const current = db.teams[index];
    const name = String(input.name ?? current.name).trim();
    const username = String(input.username ?? current.username).trim();
    const role = String(input.role ?? current.role).trim();
    const password = String(input.password || "").trim();
    if (!name || !username) return sendJson(res, 400, { error: "Team name and username are required" });
    if (!["admin", "editor", "viewer"].includes(role)) return sendJson(res, 400, { error: "Role must be admin, editor, or viewer" });
    if (db.teams.some((team, teamIndex) => teamIndex !== index && normalize(team.username) === normalize(username))) {
      return sendJson(res, 409, { error: "Username already exists" });
    }
    if (current.role === "admin" && role !== "admin") {
      const adminCount = db.teams.filter(team => team.role === "admin").length;
      if (adminCount <= 1) return sendJson(res, 400, { error: "AKB must keep at least one admin user" });
    }

    const updated = { ...current, name, username, role, updatedAt: new Date().toISOString(), updatedBy: input.updatedBy || "AKB Admin" };
    if (password) updated.password = password;
    db.teams[index] = updated;
    addAuditLog(db, { type: "team-updated", actor: updated.updatedBy, teamId: updated.id, note: `Updated login for ${updated.name} (${updated.username})${password ? " and reset password" : ""}` });
    writeDb(db);
    return sendJson(res, 200, { team: publicTeam(updated) });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/teams/")) {
    const input = await readBody(req);
    if (!isAdminInput(input)) return sendJson(res, 403, { error: "Only admin can delete users" });
    const id = decodeURIComponent(url.pathname.split("/").pop());
    db.teams = db.teams || [];
    const index = db.teams.findIndex(team => team.id === id);
    if (index === -1) return sendJson(res, 404, { error: "User not found" });
    const team = db.teams[index];
    if (team.role === "admin") {
      const adminCount = db.teams.filter(item => item.role === "admin").length;
      if (adminCount <= 1) return sendJson(res, 400, { error: "AKB must keep at least one admin user" });
    }
    db.teams.splice(index, 1);
    addAuditLog(db, { type: "team-deleted", actor: input.updatedBy || "AKB Admin", teamId: team.id, note: `Deleted login for ${team.name} (${team.username})` });
    writeDb(db);
    return sendJson(res, 200, { deleted: true, teamId: id });
  }

  if (req.method === "GET" && url.pathname === "/api/meta") {
    return sendJson(res, 200, {
      categories: db.categories,
      categoriesAr: db.categoriesAr || {},
      departments: db.departments,
      users: db.users.map(({ password, ...user }) => user),
      teams: (db.teams || []).map(publicTeam)
    });
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
      category: input.category.trim(),
      department: input.department.trim(),
      summary: input.summary.trim(),
      audience: input.audience?.trim() || "Internal employees and call center",
      fees: input.fees?.trim() || "Confirm with operations",
      processingTime: input.processingTime?.trim() || "Confirm with operations",
      requirements: input.requirements || [],
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
      faqs: input.faqs || [],
      callCenterScript: input.callCenterScript?.trim() || "",
      internalNotes: input.internalNotes?.trim() || "",
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
