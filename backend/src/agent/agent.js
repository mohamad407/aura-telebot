"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// ============================================================
// AURA STATIC WEBSITE AGENT
// HTML + CSS + JAVASCRIPT ONLY
// NO REACT
// NO VITE
// NO NPM BUILD
// ============================================================

const ROOT_DIR = path.resolve(__dirname, "..", "projects");

const DEFAULT_GROQ_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const DEFAULT_OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "openrouter/free";

// ------------------------------------------------------------
// Utility
// ------------------------------------------------------------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizeProjectName(name) {
  let value = String(name || "aura-site")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  if (!value) value = "aura-site";

  if (!/^[a-z]/.test(value)) {
    value = `site-${value}`;
  }

  return value.slice(0, 50);
}

function projectDirectory(projectName) {
  return path.join(ROOT_DIR, sanitizeProjectName(projectName));
}

function writeFileSafe(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(content || ""), "utf8");
}

function readFileSafe(filePath) {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function sha1(content) {
  return crypto
    .createHash("sha1")
    .update(Buffer.isBuffer(content) ? content : Buffer.from(content))
    .digest("hex");
}

function redactSecrets(text) {
  if (!text) return text;

  return String(text)
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/gsk_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/vca_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/vcr_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(
      /(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[^"',\s]+/gi,
      "$1=[REDACTED]"
    );
}

function extractJson(text) {
  if (!text) return null;

  let value = String(text).trim();

  // Remove markdown fences.
  value = value
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(value);
  } catch (_) {}

  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");

  if (first !== -1 && last !== -1 && last > first) {
    try {
      return JSON.parse(value.slice(first, last + 1));
    } catch (_) {}
  }

  return null;
}

// ------------------------------------------------------------
// AI Gateway
// ------------------------------------------------------------

function isRateLimitError(error) {
  const message = String(error?.message || error || "").toLowerCase();

  return (
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("rate_limit") ||
    message.includes("too many requests") ||
    message.includes("tokens per day")
  );
}

async function askGroq(prompt) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error("GROQ_API_KEY is missing.");
  }

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_GROQ_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are AURA, an expert frontend engineer. Return only the requested content.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Groq ${response.status}: ${text}`);
  }

  const data = JSON.parse(text);

  return data?.choices?.[0]?.message?.content || "";
}

async function askOpenRouter(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is missing.");
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://telegram.org",
        "X-Title": "AURA Telegram Website Agent",
      },
      body: JSON.stringify({
        model: DEFAULT_OPENROUTER_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are AURA, an expert frontend engineer. Return only the requested JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${text}`);
  }

  const data = JSON.parse(text);

  return data?.choices?.[0]?.message?.content || "";
}

async function askAI(prompt) {
  let groqError = null;

  if (process.env.GROQ_API_KEY) {
    try {
      console.log("🟢 AI Gateway → Groq");
      const result = await askGroq(prompt);

      if (result) {
        console.log("✅ Groq success");
        return result;
      }
    } catch (error) {
      groqError = error;

      console.log("⚠️ Groq failed.");
      console.log(
        redactSecrets(error?.message || String(error))
      );
    }
  }

  if (process.env.OPENROUTER_API_KEY) {
    try {
      console.log("🔵 AI Gateway → OpenRouter");
      const result = await askOpenRouter(prompt);

      if (result) {
        console.log("✅ OpenRouter success");
        return result;
      }
    } catch (error) {
      console.log("⚠️ OpenRouter failed.");
      console.log(
        redactSecrets(error?.message || String(error))
      );
    }
  }

  if (groqError) {
    throw new Error(
      "All configured AI providers failed or are rate-limited."
    );
  }

  throw new Error("No AI provider is configured.");
}

// ------------------------------------------------------------
// Fallback static website
// ------------------------------------------------------------

function fallbackWebsite(prompt, projectName) {
  const safeProject = sanitizeProjectName(projectName);

  const title =
    safeProject
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ") || "AURA Website";

  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >
  <meta
    name="description"
    content="Website generated by AURA"
  >
  <title>${title}</title>
  <link rel="stylesheet" href="./style.css">
</head>

<body>
  <header class="navbar">
    <div class="container nav-inner">
      <a href="#" class="logo">${title}</a>

      <nav>
        <a href="#home">Home</a>
        <a href="#features">Features</a>
        <a href="#about">About</a>
      </nav>
    </div>
  </header>

  <main>
    <section id="home" class="hero">
      <div class="container">
        <span class="badge">Generated by AURA</span>

        <h1>
          Build something
          <span>beautiful.</span>
        </h1>

        <p>
          ${escapeHtml(prompt || "A modern website generated by AURA.")}
        </p>

        <div class="actions">
          <button id="primaryButton">
            Get Started
          </button>

          <a href="#features" class="secondary-button">
            Explore
          </a>
        </div>
      </div>
    </section>

    <section id="features" class="section">
      <div class="container">
        <h2>Features</h2>

        <div class="grid">
          <article class="card">
            <div class="icon">01</div>
            <h3>Modern Design</h3>
            <p>
              Clean, responsive and mobile-friendly interface.
            </p>
          </article>

          <article class="card">
            <div class="icon">02</div>
            <h3>Fast</h3>
            <p>
              Lightweight HTML, CSS and JavaScript.
            </p>
          </article>

          <article class="card">
            <div class="icon">03</div>
            <h3>Ready to Deploy</h3>
            <p>
              Static files can be deployed directly to Vercel.
            </p>
          </article>
        </div>
      </div>
    </section>

    <section id="about" class="section about">
      <div class="container">
        <h2>About</h2>
        <p>
          This website was generated automatically by the AURA
          Telegram AI agent.
        </p>
      </div>
    </section>
  </main>

  <footer>
    <div class="container">
      <p>Generated by AURA • ${new Date().getFullYear()}</p>
    </div>
  </footer>

  <script src="./script.js"></script>
</body>
</html>`;

  const styleCss = `* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html {
  scroll-behavior: smooth;
}

body {
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  background: #070b14;
  color: #f8fafc;
  line-height: 1.6;
}

a {
  color: inherit;
  text-decoration: none;
}

.container {
  width: min(1120px, calc(100% - 40px));
  margin: 0 auto;
}

.navbar {
  position: sticky;
  top: 0;
  z-index: 20;
  backdrop-filter: blur(18px);
  background: rgba(7, 11, 20, 0.8);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.nav-inner {
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 30px;
}

.logo {
  font-size: 20px;
  font-weight: 800;
}

nav {
  display: flex;
  gap: 24px;
}

nav a {
  color: #aeb7c8;
  transition: 0.2s;
}

nav a:hover {
  color: #ffffff;
}

.hero {
  min-height: 720px;
  display: flex;
  align-items: center;
  padding: 90px 0;
  background:
    radial-gradient(
      circle at 50% 20%,
      rgba(99, 102, 241, 0.24),
      transparent 35%
    );
}

.badge {
  display: inline-block;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(99, 102, 241, 0.12);
  border: 1px solid rgba(99, 102, 241, 0.3);
  color: #c7d2fe;
  margin-bottom: 25px;
}

.hero h1 {
  max-width: 850px;
  font-size: clamp(48px, 9vw, 96px);
  line-height: 0.98;
  letter-spacing: -0.06em;
}

.hero h1 span {
  display: block;
  color: #818cf8;
}

.hero p {
  max-width: 680px;
  margin-top: 28px;
  color: #aeb7c8;
  font-size: 18px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 35px;
}

button,
.secondary-button {
  border: 0;
  border-radius: 12px;
  padding: 14px 22px;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
}

button {
  background: #ffffff;
  color: #070b14;
}

.secondary-button {
  border: 1px solid rgba(255,255,255,0.15);
  background: rgba(255,255,255,0.05);
}

.section {
  padding: 100px 0;
}

.section h2 {
  font-size: 42px;
  margin-bottom: 40px;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(3, minmax(0, 1fr));
  gap: 20px;
}

.card {
  padding: 30px;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 20px;
  background: rgba(255,255,255,0.04);
}

.icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: #818cf8;
  color: #070b14;
  font-weight: 800;
  margin-bottom: 20px;
}

.card h3 {
  margin-bottom: 10px;
}

.card p,
.about p {
  color: #aeb7c8;
}

.about {
  background: rgba(255,255,255,0.02);
}

footer {
  padding: 30px 0;
  border-top: 1px solid rgba(255,255,255,0.08);
  color: #7f8a9d;
}

@media (max-width: 760px) {
  nav {
    display: none;
  }

  .grid {
    grid-template-columns: 1fr;
  }

  .hero {
    min-height: 650px;
  }
}`;

  const scriptJs = `document.addEventListener("DOMContentLoaded", () => {
  const button = document.getElementById("primaryButton");

  if (!button) return;

  button.addEventListener("click", () => {
    button.textContent = "Started ✓";

    setTimeout(() => {
      button.textContent = "Get Started";
    }, 1800);
  });
});`;

  return {
    "index.html": indexHtml,
    "style.css": styleCss,
    "script.js": scriptJs,
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ------------------------------------------------------------
// AI generation
// ------------------------------------------------------------

async function generateWebsiteWithAI(prompt, projectName) {
  const safeName = sanitizeProjectName(projectName);

  const aiPrompt = `
You are generating a production-quality STATIC website.

User request:
${prompt}

Project name:
${safeName}

IMPORTANT:
- Generate ONLY plain HTML, CSS and vanilla JavaScript.
- NO React.
- NO JSX.
- NO Vite.
- NO npm.
- NO package.json.
- NO imports.
- NO external build system.
- The website must work by simply opening index.html.
- Use exactly these three files:
  1. index.html
  2. style.css
  3. script.js
- index.html must link ./style.css and ./script.js.
- Do not use markdown.
- Do not include code fences.
- Return ONLY valid JSON.

JSON format:
{
  "index.html": "...",
  "style.css": "...",
  "script.js": "..."
}

Make the website polished, responsive and functional.
`;

  const response = await askAI(aiPrompt);
  const parsed = extractJson(response);

  if (!parsed) {
    throw new Error("AI returned invalid website JSON.");
  }

  const files = {
    "index.html": parsed["index.html"],
    "style.css": parsed["style.css"],
    "script.js": parsed["script.js"],
  };

  if (
    typeof files["index.html"] !== "string" ||
    typeof files["style.css"] !== "string" ||
    typeof files["script.js"] !== "string"
  ) {
    throw new Error("AI response is missing required static files.");
  }

  return files;
}

// ------------------------------------------------------------
// Validation
// ------------------------------------------------------------

function validateWebsiteFiles(files) {
  const errors = [];

  if (!files || typeof files !== "object") {
    errors.push("Website files are missing.");
    return {
      valid: false,
      errors,
    };
  }

  for (const required of ["index.html", "style.css", "script.js"]) {
    if (
      typeof files[required] !== "string" ||
      !files[required].trim()
    ) {
      errors.push(`Missing ${required}.`);
    }
  }

  const html = files["index.html"] || "";
  const css = files["style.css"] || "";
  const js = files["script.js"] || "";

  if (!/<html[\s>]/i.test(html)) {
    errors.push("index.html does not contain an <html> element.");
  }

  if (!/<head[\s>]/i.test(html)) {
    errors.push("index.html does not contain a <head> element.");
  }

  if (!/<body[\s>]/i.test(html)) {
    errors.push("index.html does not contain a <body> element.");
  }

  if (!/stylesheet/i.test(html)) {
    errors.push("index.html does not appear to load style.css.");
  }

  if (!/<script[^>]+src=["']\.?\/?script\.js/i.test(html)) {
    errors.push("index.html does not appear to load script.js.");
  }

  // Detect accidental React/JSX output.
  if (
    /from\s+["']react["']/i.test(html) ||
    /from\s+["']react["']/i.test(js) ||
    /import\s+React/i.test(js) ||
    /<[A-Z][A-Za-z0-9]*/.test(js)
  ) {
    errors.push("React/JSX code detected.");
  }

  if (/package\.json/i.test(html + css + js)) {
    errors.push("package.json content detected in static files.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ------------------------------------------------------------
// Ensure required files
// ------------------------------------------------------------

function ensureRequiredFrontendFiles(projectDir, files, prompt, projectName) {
  ensureDir(projectDir);

  const fallback = fallbackWebsite(prompt, projectName);

  const finalFiles = {
    "index.html":
      typeof files?.["index.html"] === "string" &&
      files["index.html"].trim()
        ? files["index.html"]
        : fallback["index.html"],

    "style.css":
      typeof files?.["style.css"] === "string" &&
      files["style.css"].trim()
        ? files["style.css"]
        : fallback["style.css"],

    "script.js":
      typeof files?.["script.js"] === "string" &&
      files["script.js"].trim()
        ? files["script.js"]
        : fallback["script.js"],
  };

  let validation = validateWebsiteFiles(finalFiles);

  if (!validation.valid) {
    console.log("⚠️ Generated files failed validation.");
    console.log(validation.errors);

    console.log("🛠️ Using safe static fallback.");

    Object.assign(finalFiles, fallback);

    validation = validateWebsiteFiles(finalFiles);
  }

  if (!validation.valid) {
    throw new Error(
      `Static website validation failed: ${validation.errors.join(", ")}`
    );
  }

  writeFileSafe(
    path.join(projectDir, "index.html"),
    finalFiles["index.html"]
  );

  writeFileSafe(
    path.join(projectDir, "style.css"),
    finalFiles["style.css"]
  );

  writeFileSafe(
    path.join(projectDir, "script.js"),
    finalFiles["script.js"]
  );

  return finalFiles;
}

// ------------------------------------------------------------
// Generate frontend
// ------------------------------------------------------------

async function generateFrontendFiles(prompt, projectName) {
  const safeName = sanitizeProjectName(projectName);
  const projectDir = projectDirectory(safeName);

  console.log("");
  console.log("==========================================");
  console.log("🎨 STATIC WEBSITE GENERATION");
  console.log("==========================================");

  console.log(`📦 Project: ${safeName}`);
  console.log(`📂 Root: ${projectDir}`);

  let files = null;

  try {
    console.log("🧠 Asking AI to generate HTML/CSS/JS...");

    files = await generateWebsiteWithAI(
      prompt,
      safeName
    );

    console.log("✅ AI generated static website.");
  } catch (error) {
    console.log("⚠️ AI generation failed.");
    console.log(
      redactSecrets(error?.message || String(error))
    );

    console.log("🛠️ Using fallback static website.");

    files = fallbackWebsite(prompt, safeName);
  }

  const finalFiles = ensureRequiredFrontendFiles(
    projectDir,
    files,
    prompt,
    safeName
  );

  console.log("");
  console.log("==========================================");
  console.log("🔐 VERIFY STATIC WEBSITE");
  console.log("==========================================");

  const verification =
    validateWebsiteFiles(finalFiles);

  if (!verification.valid) {
    throw new Error(
      verification.errors.join("\n")
    );
  }

  console.log("✅ Static website verified.");
  console.log("   ✓ index.html");
  console.log("   ✓ style.css");
  console.log("   ✓ script.js");
  console.log("   ✓ no React");
  console.log("   ✓ no Vite");
  console.log("   ✓ no npm build");

  return {
    projectName: safeName,
    projectDir,
    files: finalFiles,
    verification,
  };
}

// ------------------------------------------------------------
// Static build
// ------------------------------------------------------------

function buildFrontend(projectDir) {
  console.log("");
  console.log("==========================================");
  console.log("🏗️ STEP — STATIC VALIDATION");
  console.log("==========================================");

  const requiredFiles = [
    "index.html",
    "style.css",
    "script.js",
  ];

  for (const file of requiredFiles) {
    const fullPath = path.join(projectDir, file);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Missing required file: ${file}`);
    }

    const stat = fs.statSync(fullPath);

    if (!stat.isFile()) {
      throw new Error(`${file} is not a file.`);
    }

    if (stat.size === 0) {
      throw new Error(`${file} is empty.`);
    }
  }

  const files = {
    "index.html": readFileSafe(
      path.join(projectDir, "index.html")
    ),
    "style.css": readFileSafe(
      path.join(projectDir, "style.css")
    ),
    "script.js": readFileSafe(
      path.join(projectDir, "script.js")
    ),
  };

  const result = validateWebsiteFiles(files);

  if (!result.valid) {
    throw new Error(
      `Static build validation failed:\n${result.errors.join("\n")}`
    );
  }

  console.log("📄 index.html ✓");
  console.log("🎨 style.css ✓");
  console.log("⚙️ script.js ✓");
  console.log("");
  console.log("✅ Static website build successful.");

  return {
    success: true,
    files,
  };
}

// ------------------------------------------------------------
// Vercel helpers
// ------------------------------------------------------------

async function vercelRequest(
  url,
  token,
  options = {}
) {
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(options.headers || {}),
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      text ||
      `Vercel HTTP ${response.status}`;

    throw new Error(
      `Vercel API ${response.status}: ${message}`
    );
  }

  return data;
}

// ------------------------------------------------------------
// Upload file to Vercel
// ------------------------------------------------------------

async function uploadVercelFile(
  token,
  content
) {
  const buffer = Buffer.isBuffer(content)
    ? content
    : Buffer.from(content, "utf8");

  const digest = sha1(buffer);

  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(buffer.length),
    "x-vercel-digest": digest,
  };

  let response = await fetch(
    "https://api.vercel.com/v2/files",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body: buffer,
    }
  );

  if (!response.ok) {
    // Compatibility fallback for older Vercel endpoint.
    response = await fetch(
      "https://api.vercel.com/v2/now/files",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...headers,
        },
        body: buffer,
      }
    );
  }

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Vercel file upload failed (${response.status}): ${text}`
    );
  }

  return {
    sha: digest,
    size: buffer.length,
  };
}

// ------------------------------------------------------------
// Deploy static website
// ------------------------------------------------------------

async function deployToVercel(
  projectDir,
  projectName,
  accessToken
) {
  if (!accessToken) {
    throw new Error(
      "No Vercel access token is available. Connect Vercel first."
    );
  }

  console.log("");
  console.log("==========================================");
  console.log("🚀 VERCEL DEPLOYMENT");
  console.log("==========================================");

  const safeName = sanitizeProjectName(projectName);

  const filesToDeploy = [
    {
      file: "index.html",
      content: readFileSafe(
        path.join(projectDir, "index.html")
      ),
    },
    {
      file: "style.css",
      content: readFileSafe(
        path.join(projectDir, "style.css")
      ),
    },
    {
      file: "script.js",
      content: readFileSafe(
        path.join(projectDir, "script.js")
      ),
    },
  ];

  const deploymentFiles = [];

  for (const item of filesToDeploy) {
    if (!item.content) {
      throw new Error(
        `Cannot deploy empty file: ${item.file}`
      );
    }

    console.log(`⬆️ Uploading ${item.file}...`);

    const uploaded = await uploadVercelFile(
      accessToken,
      item.content
    );

    deploymentFiles.push({
      file: item.file,
      sha: uploaded.sha,
      size: uploaded.size,
    });
  }

  console.log("📦 Creating Vercel deployment...");

  const deployment = await vercelRequest(
    "https://api.vercel.com/v13/deployments",
    accessToken,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: safeName,
        files: deploymentFiles,
        projectSettings: {
          framework: null,
        },
        target: "production",
      }),
    }
  );

  console.log(
    `🆔 Deployment: ${deployment?.id || "unknown"}`
  );

  let deploymentData = deployment;

  if (deployment?.id) {
    try {
      deploymentData = await waitForVercelDeployment(
        accessToken,
        deployment.id
      );
    } catch (error) {
      console.log(
        "⚠️ Could not complete deployment polling:",
        error.message
      );
    }
  }

  const url =
    deploymentData?.url ||
    deployment?.url ||
    null;

  if (!url) {
    throw new Error(
      "Vercel deployment was created but no URL was returned."
    );
  }

  const liveUrl = url.startsWith("http")
    ? url
    : `https://${url}`;

  console.log("");
  console.log("==========================================");
  console.log("🎉 DEPLOYMENT SUCCESS");
  console.log("==========================================");
  console.log(liveUrl);

  return {
    success: true,
    id: deployment?.id,
    url: liveUrl,
    state:
      deploymentData?.readyState ||
      deployment?.readyState ||
      "READY",
  };
}

// ------------------------------------------------------------
// Wait for deployment
// ------------------------------------------------------------

async function waitForVercelDeployment(
  token,
  deploymentId,
  timeoutMs = 300000
) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const data = await vercelRequest(
      `https://api.vercel.com/v13/deployments/${encodeURIComponent(
        deploymentId
      )}`,
      token,
      {
        method: "GET",
      }
    );

    const state =
      data?.readyState ||
      data?.state ||
      "";

    console.log(`⏳ Vercel status: ${state}`);

    if (state === "READY") {
      return data;
    }

    if (
      state === "ERROR" ||
      state === "CANCELED"
    ) {
      throw new Error(
        `Vercel deployment failed with state: ${state}`
      );
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 3000)
    );
  }

  throw new Error(
    "Vercel deployment timed out after 5 minutes."
  );
}

// ------------------------------------------------------------
// No-op compatibility functions
// ------------------------------------------------------------

function verifyFrontend(projectDir) {
  return buildFrontend(projectDir);
}

function normalizeFrontendFiles(files) {
  return {
    "index.html": files?.["index.html"] || "",
    "style.css": files?.["style.css"] || "",
    "script.js": files?.["script.js"] || "",
  };
}

// ------------------------------------------------------------
// Agent entry
// ------------------------------------------------------------

async function runAgent(prompt, options = {}) {
  const projectName =
    sanitizeProjectName(
      options.projectName ||
        extractProjectName(prompt) ||
        "aura-site"
    );

  console.log("");
  console.log("==========================================");
  console.log("🤖 AURA AGENT REQUEST");
  console.log("==========================================");

  console.log(`🎯 Goal: ${prompt}`);
  console.log(`📦 Project: ${projectName}`);

  const generated =
    await generateFrontendFiles(
      prompt,
      projectName
    );

  const build =
    buildFrontend(generated.projectDir);

  return {
    success: true,
    projectName: generated.projectName,
    projectDir: generated.projectDir,
    files: generated.files,
    verification: generated.verification,
    build,
  };
}

// ------------------------------------------------------------
// Project name extraction
// ------------------------------------------------------------

function extractProjectName(prompt) {
  const text = String(prompt || "");

  const match =
    text.match(
      /(?:called|named|name\s+it|project\s+name)\s+["']?([a-zA-Z0-9 _-]{2,50})["']?/i
    );

  if (match?.[1]) {
    return match[1];
  }

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const meaningful = words
    .filter(
      (word) =>
        ![
          "build",
          "make",
          "create",
          "website",
          "site",
          "web",
          "page",
          "me",
          "a",
          "an",
          "the",
          "for",
          "with",
        ].includes(word)
    )
    .slice(0, 3);

  return meaningful.length
    ? meaningful.join("-")
    : "aura-site";
}

// ------------------------------------------------------------
// Exports
// ------------------------------------------------------------

module.exports = {
  runAgent,
  askAI,
  askGroq,
  askOpenRouter,

  generateFrontendFiles,
  ensureRequiredFrontendFiles,

  buildFrontend,
  verifyFrontend,

  deployToVercel,
  waitForVercelDeployment,
  uploadVercelFile,

  sanitizeProjectName,
  normalizeFrontendFiles,
  validateWebsiteFiles,

  fallbackWebsite,
  redactSecrets,
  isRateLimitError,
};
