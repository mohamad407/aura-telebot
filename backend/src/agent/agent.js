"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// ============================================================
// AURA AGENT
// ============================================================

const PROJECTS_DIR = path.resolve(
  __dirname,
  "../projects"
);

const AI_TIMEOUT_MS = 90000;
const REVIEW_TIMEOUT_MS = 60000;

const GROQ_MODEL =
  process.env.GROQ_MODEL ||
  "openai/gpt-oss-120b";

const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL ||
  "openrouter/free";

const GROQ_COOLDOWN_MS = 60000;
const OPENROUTER_COOLDOWN_MS = 60000;

let groqDisabledUntil = 0;
let openRouterDisabledUntil = 0;

// ============================================================
// HELPERS
// ============================================================

function redactSecrets(value) {
  let text = String(value || "");

  const patterns = [
    /TELEGRAM_BOT_TOKEN\s*=\s*[^\s]+/gi,
    /GROQ_API_KEY\s*=\s*[^\s]+/gi,
    /OPENROUTER_API_KEY\s*=\s*[^\s]+/gi,
    /VERCEL_CLIENT_SECRET\s*=\s*[^\s]+/gi,
    /VERCEL_TOKEN\s*=\s*[^\s]+/gi,
    /Authorization:\s*Bearer\s+[^\s]+/gi,
    /Bearer\s+[A-Za-z0-9._-]+/gi
  ];

  for (const pattern of patterns) {
    text = text.replace(pattern, "[REDACTED]");
  }

  return text;
}

function safeError(error) {
  return redactSecrets(
    error?.message ||
      String(error) ||
      "Unknown error"
  );
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sanitizeProjectName(input) {
  let name = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!name) {
    name = "aura-website";
  }

  return name.slice(0, 60);
}

function deriveProjectName(request) {
  const text = String(request || "").toLowerCase();

  if (text.includes("portfolio")) {
    return "aura-portfolio";
  }

  if (text.includes("amazon")) {
    return "amazon-clone";
  }

  if (text.includes("sneaker")) {
    return "sneaker-store";
  }

  if (
    text.includes("ecommerce") ||
    text.includes("e-commerce") ||
    text.includes("store") ||
    text.includes("shop")
  ) {
    return "aura-store";
  }

  return "aura-website";
}

// ============================================================
// PROJECT PATHS
// ============================================================

function getProjectRoot(projectName) {
  const safeName = sanitizeProjectName(projectName);

  const root = path.resolve(
    PROJECTS_DIR,
    safeName
  );

  const base = path.resolve(
    PROJECTS_DIR
  );

  if (!root.startsWith(base + path.sep)) {
    throw new Error("Unsafe project path.");
  }

  return root;
}

function ensureProject(projectName) {
  const root = getProjectRoot(projectName);

  fs.mkdirSync(root, {
    recursive: true
  });

  return root;
}

function normalizeFilePath(filePath) {
  const value = String(filePath || "")
    .replace(/\\/g, "/")
    .trim()
    .toLowerCase();

  if (
    !value ||
    value.includes("..") ||
    path.isAbsolute(value)
  ) {
    throw new Error(
      `Unsafe file path: ${filePath}`
    );
  }

  return value.replace(/^\/+/, "");
}

function writeProjectFile(
  projectRoot,
  filePath,
  content
) {
  const safePath =
    normalizeFilePath(filePath);

  const fullPath =
    path.resolve(
      projectRoot,
      safePath
    );

  if (!fullPath.startsWith(projectRoot + path.sep)) {
    throw new Error(
      `Unsafe project file path: ${safePath}`
    );
  }

  fs.mkdirSync(
    path.dirname(fullPath),
    {
      recursive: true
    }
  );

  fs.writeFileSync(
    fullPath,
    String(content || ""),
    "utf8"
  );
}

function readProjectFile(
  projectRoot,
  filePath
) {
  const safePath =
    normalizeFilePath(filePath);

  const fullPath =
    path.resolve(
      projectRoot,
      safePath
    );

  if (!fs.existsSync(fullPath)) {
    return null;
  }

  return fs.readFileSync(
    fullPath,
    "utf8"
  );
}

function listProjectFiles(
  projectRoot
) {
  const result = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) {
      return;
    }

    for (
      const entry of fs.readdirSync(
        dir,
        {
          withFileTypes: true
        }
      )
    ) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git"
      ) {
        continue;
      }

      const fullPath =
        path.join(
          dir,
          entry.name
        );

      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        result.push(
          path
            .relative(
              projectRoot,
              fullPath
            )
            .replace(/\\/g, "/")
            .toLowerCase()
        );
      }
    }
  }

  walk(projectRoot);

  return result;
}

// ============================================================
// AI FETCH WITH HARD TIMEOUT
// ============================================================

async function fetchWithTimeout(
  url,
  options,
  timeoutMs
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal: controller.signal
      }
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        `AI request timed out after ${timeoutMs / 1000} seconds.`
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// GROQ
// ============================================================

async function askGroq(
  messages,
  options = {}
) {
  const key =
    process.env.GROQ_API_KEY;

  if (!key) {
    throw new Error(
      "GROQ_API_KEY is missing."
    );
  }

  if (Date.now() < groqDisabledUntil) {
    throw new Error(
      "Groq is temporarily disabled because of rate limiting."
    );
  }

  const response =
    await fetchWithTimeout(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${key}`
        },

        body: JSON.stringify({
          model:
            options.model ||
            GROQ_MODEL,

          messages,

          temperature:
            options.temperature ??
            0.2,

          max_tokens:
            options.max_tokens ||
            7000
        })
      },
      options.timeoutMs ||
        AI_TIMEOUT_MS
    );

  const text =
    await response.text();

  if (!response.ok) {
    if (response.status === 429) {
      groqDisabledUntil =
        Date.now() +
        GROQ_COOLDOWN_MS;
    }

    throw new Error(
      `Groq ${response.status}: ${text.slice(
        0,
        1800
      )}`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "Groq returned invalid JSON."
    );
  }

  const content =
    data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(
      "Groq returned empty content."
    );
  }

  return String(content);
}

// ============================================================
// OPENROUTER
// ============================================================

async function askOpenRouter(
  messages,
  options = {}
) {
  const key =
    process.env.OPENROUTER_API_KEY;

  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY is missing."
    );
  }

  if (Date.now() < openRouterDisabledUntil) {
    throw new Error(
      "OpenRouter is temporarily disabled because of rate limiting."
    );
  }

  const response =
    await fetchWithTimeout(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${key}`,

          "HTTP-Referer":
            process.env.OPENROUTER_SITE_URL ||
            "https://aura-telebot.onrender.com",

          "X-Title":
            process.env.OPENROUTER_APP_NAME ||
            "AURA Agent"
        },

        body: JSON.stringify({
          model:
            options.model ||
            OPENROUTER_MODEL,

          messages,

          temperature:
            options.temperature ??
            0.2,

          max_tokens:
            options.max_tokens ||
            7000
        })
      },
      options.timeoutMs ||
        AI_TIMEOUT_MS
    );

  const text =
    await response.text();

  if (!response.ok) {
    if (response.status === 429) {
      openRouterDisabledUntil =
        Date.now() +
        OPENROUTER_COOLDOWN_MS;
    }

    throw new Error(
      `OpenRouter ${response.status}: ${text.slice(
        0,
        1800
      )}`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "OpenRouter returned invalid JSON."
    );
  }

  const content =
    data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(
      "OpenRouter returned empty content."
    );
  }

  return String(content);
}

// ============================================================
// AI GATEWAY
// ============================================================

async function askAI(
  messages,
  options = {}
) {
  const providers = [];

  if (
    process.env.GROQ_API_KEY &&
    Date.now() >= groqDisabledUntil
  ) {
    providers.push({
      name: "Groq",
      run: () =>
        askGroq(
          messages,
          options
        )
    });
  }

  if (
    process.env.OPENROUTER_API_KEY &&
    Date.now() >= openRouterDisabledUntil
  ) {
    providers.push({
      name: "OpenRouter",
      run: () =>
        askOpenRouter(
          messages,
          options
        )
    });
  }

  if (!providers.length) {
    throw new Error(
      "No AI provider is currently available."
    );
  }

  let lastError = null;

  for (
    const provider of providers
  ) {
    try {
      console.log(
        `🔵 AI Gateway → ${provider.name}`
      );

      const result =
        await provider.run();

      console.log(
        `✅ AI Gateway → ${provider.name} success`
      );

      return result;
    } catch (error) {
      lastError = error;

      console.log(
        `⚠️ ${provider.name} failed: ${safeError(
          error
        )}`
      );
    }
  }

  throw new Error(
    lastError
      ? safeError(lastError)
      : "All AI providers failed."
  );
}

// ============================================================
// JSON PARSER
// ============================================================

function extractJson(
  value
) {
  let text =
    String(value || "")
      .trim();

  text =
    text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

  const first =
    text.indexOf("{");

  const last =
    text.lastIndexOf("}");

  if (
    first === -1 ||
    last === -1 ||
    last <= first
  ) {
    throw new Error(
      "AI response does not contain a JSON object."
    );
  }

  try {
    return JSON.parse(
      text.slice(
        first,
        last + 1
      )
    );
  } catch (error) {
    throw new Error(
      `Invalid AI JSON: ${error.message}`
    );
  }
}

// ============================================================
// REQUIREMENT ANALYSIS
// ============================================================

async function analyzeRequirements(
  request
) {
  const prompt = `
Analyze this website request and create a precise implementation specification.

USER REQUEST:
${String(request).slice(0, 14000)}

Preserve every explicit requirement.

If the request says EXACTLY 3 products,
the specification MUST keep exactly 3.

If it provides exact:
- names
- prices
- ratings
- stock
- text

preserve them exactly.

If it requests:
- localStorage
- cart
- checkout
- payment validation
- order history
- search

include all of them.

Return ONLY JSON:

{
  "projectName": "",
  "brand": {
    "name": "",
    "tagline": ""
  },
  "features": [],
  "exactData": [],
  "persistence": [],
  "designRequirements": [],
  "validationRequirements": []
}
`;

  const response =
    await askAI(
      [
        {
          role: "system",
          content:
            "You are a senior frontend product analyst. Return JSON only."
        },
        {
          role: "user",
          content:
            prompt
        }
      ],
      {
        temperature: 0.1,
        max_tokens: 4500,
        timeoutMs: REVIEW_TIMEOUT_MS
      }
    );

  return extractJson(response);
}

function fallbackRequirements(
  request
) {
  return {
    projectName:
      deriveProjectName(request),

    brand: {
      name:
        "AURA Website",

      tagline:
        String(request).slice(
          0,
          120
        )
    },

    features: [],
    exactData: [],
    persistence: [],
    designRequirements: [
      "Modern",
      "Responsive",
      "Professional"
    ],
    validationRequirements: []
  };
}

// ============================================================
// FILE PROMPT
// ============================================================

function buildFilePrompt(
  file,
  request,
  specification,
  existingFiles
) {
  const common = `
You are AURA's senior frontend engineer.

Build ONE COMPLETE frontend application.

Original user request:
${String(request).slice(0, 14000)}

Structured requirements:
${JSON.stringify(
  specification,
  null,
  2
)}

TECHNOLOGY:

Use ONLY:
- HTML5
- CSS3
- Vanilla JavaScript

Do NOT use:
- React
- JSX
- Next.js
- Vite
- npm
- package.json
- TypeScript
- Node
- Express

The user explicitly wants a frontend-only application.

The application must be production-quality, responsive,
functional, polished, and visually coherent.

Do not simplify the request.

Do not invent replacement data.

Do not add random products when the user specifies exact products.

Do not create fake buttons.

All interactive features must work.

Use localStorage wherever the user requires persistence.

If Lucide icons are requested, use the browser CDN and
initialize lucide.createIcons().

Current other files:

INDEX:
${String(
  existingFiles["index.html"] || ""
).slice(0, 12000)}

CSS:
${String(
  existingFiles["style.css"] || ""
).slice(0, 12000)}

JS:
${String(
  existingFiles["script.js"] || ""
).slice(0, 18000)}
`;

  if (file === "index.html") {
    return `
${common}

Generate ONLY the complete index.html.

Requirements:
- valid HTML5
- semantic structure
- responsive application layout
- all required sections
- all IDs/classes needed by JavaScript
- link ./style.css
- load ./script.js
- include Lucide CDN if requested
- no markdown
- no JSON
- no explanation

Return only HTML.
`;
  }

  if (file === "style.css") {
    return `
${common}

Generate ONLY the complete style.css.

Requirements:
- polished visual design
- responsive desktop/tablet/mobile
- modern spacing
- strong hierarchy
- polished cards
- buttons
- forms
- state screens
- cart UI
- checkout UI
- success UI
- no framework
- no explanation

Return only CSS.
`;
  }

  return `
${common}

Generate ONLY the complete script.js.

Requirements:
- implement every requested interaction
- real search
- real cart
- real quantity changes
- real remove
- real totals
- checkout state
- validation
- payment flow
- order history
- localStorage persistence
- stock handling
- buttons must work
- no external JS packages except requested Lucide CDN
- no React
- no imports
- no npm

Do not return fake event handlers.

Return only JavaScript.
`;
}

// ============================================================
// CLEAN AI FILE OUTPUT
// ============================================================

function cleanCodeOutput(
  value
) {
  let text =
    String(
      value || ""
    ).trim();

  text =
    text
      .replace(/^```[a-z0-9_-]*\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

  return text;
}

// ============================================================
// SINGLE FILE GENERATION
// ============================================================

async function generateSingleFile(
  file,
  request,
  specification,
  existingFiles
) {
  const prompt =
    buildFilePrompt(
      file,
      request,
      specification,
      existingFiles
    );

  const response =
    await askAI(
      [
        {
          role: "system",
          content:
            "Return only valid source code for the requested file."
        },
        {
          role: "user",
          content:
            prompt
        }
      ],
      {
        temperature:
          0.25,

        max_tokens:
          file === "script.js"
            ? 11000
            : 7000,

        timeoutMs:
          AI_TIMEOUT_MS
      }
    );

  return cleanCodeOutput(
    response
  );
}

// ============================================================
// STATIC VALIDATION
// ============================================================

function validateFiles(
  files
) {
  const errors = [];

  const html =
    files["index.html"] || "";

  const css =
    files["style.css"] || "";

  const js =
    files["script.js"] || "";

  if (!html.trim()) {
    errors.push(
      "index.html is empty."
    );
  }

  if (!css.trim()) {
    errors.push(
      "style.css is empty."
    );
  }

  if (!js.trim()) {
    errors.push(
      "script.js is empty."
    );
  }

  if (
    html &&
    !/<!doctype html>/i.test(
      html
    )
  ) {
    errors.push(
      "Missing HTML doctype."
    );
  }

  if (
    html &&
    !/style\.css/i.test(
      html
    )
  ) {
    errors.push(
      "style.css is not referenced."
    );
  }

  if (
    html &&
    !/script\.js/i.test(
      html
    )
  ) {
    errors.push(
      "script.js is not referenced."
    );
  }

  const combined =
    html +
    "\n" +
    css +
    "\n" +
    js;

  if (
    /\bReactDOM\b/i.test(
      combined
    ) ||
    /\bimport\s+React\b/i.test(
      combined
    ) ||
    /\.jsx\b/i.test(
      combined
    )
  ) {
    errors.push(
      "React/JSX detected."
    );
  }

  if (
    /\bVite\b/i.test(
      combined
    ) ||
    /package\.json/i.test(
      combined
    )
  ) {
    errors.push(
      "Vite/npm content detected."
    );
  }

  if (
    /User Safety:/i.test(
      combined
    ) ||
    /Safety:\s*(safe|unsafe)/i.test(
      combined
    )
  ) {
    errors.push(
      "AI metadata detected."
    );
  }

  const braceOpen =
    (
      js.match(
        /{/g
      ) || []
    ).length;

  const braceClose =
    (
      js.match(
        /}/g
      ) || []
    ).length;

  if (
    braceOpen !==
    braceClose
  ) {
    errors.push(
      "JavaScript braces are unbalanced."
    );
  }

  const parenOpen =
    (
      js.match(
        /\(/g
      ) || []
    ).length;

  const parenClose =
    (
      js.match(
        /\)/g
      ) || []
    ).length;

  if (
    parenOpen !==
    parenClose
  ) {
    errors.push(
      "JavaScript parentheses are unbalanced."
    );
  }

  return {
    valid:
      errors.length === 0,

    errors
  };
}

// ============================================================
// REVIEW APP
// ============================================================

async function reviewApplication(
  request,
  specification,
  files
) {
  const prompt = `
Act as a senior frontend QA engineer.

Review this complete website against the ORIGINAL user request.

ORIGINAL REQUEST:
${String(request).slice(0, 14000)}

REQUIREMENTS:
${JSON.stringify(
  specification,
  null,
  2
)}

HTML:
${files["index.html"]}

CSS:
${files["style.css"]}

JAVASCRIPT:
${files["script.js"]}

Check especially:
- exact product data
- exact product count
- search
- cart
- quantity controls
- remove
- subtotal
- shipping
- grand total
- checkout
- card validation
- expiry validation
- localStorage
- order history
- stock updates
- working buttons
- responsive layout
- requested visual design

Return ONLY:

{
  "passed": true,
  "score": 100,
  "issues": [],
  "repairFile": "none",
  "repairInstructions": []
}
`;

  const response =
    await askAI(
      [
        {
          role: "system",
          content:
            "You are a senior frontend QA engineer. Return JSON only."
        },
        {
          role: "user",
          content:
            prompt
        }
      ],
      {
        temperature: 0.1,
        max_tokens: 5000,
        timeoutMs:
          REVIEW_TIMEOUT_MS
      }
    );

  return extractJson(
    response
  );
}

// ============================================================
// REPAIR ONE FILE ONLY
// ============================================================

async function repairFile(
  file,
  request,
  specification,
  files,
  review
) {
  const prompt = `
Repair ONLY ${file} in this frontend application.

ORIGINAL REQUEST:
${String(request).slice(0, 14000)}

REQUIREMENTS:
${JSON.stringify(
  specification,
  null,
  2
)}

QA REVIEW:
${JSON.stringify(
  review,
  null,
  2
)}

CURRENT ${file}:
${files[file]}

OTHER FILES FOR COMPATIBILITY:

index.html:
${files["index.html"]}

style.css:
${files["style.css"]}

script.js:
${files["script.js"]}

Rules:
- preserve working functionality
- fix all listed issues
- keep exact user requirements
- vanilla HTML/CSS/JS only
- no React
- no Vite
- no npm
- no package.json
- return ONLY the repaired ${file}
- no markdown
- no explanation
`;

  const response =
    await askAI(
      [
        {
          role: "system",
          content:
            "Return only repaired source code."
        },
        {
          role: "user",
          content:
            prompt
        }
      ],
      {
        temperature: 0.15,
        max_tokens:
          file === "script.js"
            ? 11000
            : 8000,
        timeoutMs:
          AI_TIMEOUT_MS
      }
    );

  return cleanCodeOutput(
    response
  );
}

// ============================================================
// SAFE FALLBACK
// ============================================================

function fallbackFiles(
  request
) {
  const safe =
    escapeHtml(
      request
    );

  return {
    "index.html":
`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AURA Website</title>
<link rel="stylesheet" href="./style.css">
</head>
<body>

<header class="header">
  <div class="container nav">
    <a href="#" class="logo">AURA</a>

    <nav>
      <a href="#home">Home</a>
      <a href="#about">About</a>
    </nav>
  </div>
</header>

<main>

<section id="home" class="hero">
  <div class="container">
    <span class="eyebrow">AURA</span>

    <h1>
      Your idea.
      <span>Your website.</span>
    </h1>

    <p>${safe}</p>

    <a href="#about" class="button">
      Explore
    </a>
  </div>
</section>

<section id="about" class="section">
  <div class="container">
    <span class="eyebrow">ABOUT</span>

    <h2>
      Built with AURA.
    </h2>

    <p>
      A modern responsive website generated by AURA.
    </p>
  </div>
</section>

</main>

<footer>
  Built with AURA ✦
</footer>

<script src="./script.js"></script>
</body>
</html>`,

    "style.css":
`* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  font-family: Inter, system-ui, sans-serif;
  background: #080b12;
  color: white;
}

a {
  color: inherit;
  text-decoration: none;
}

.container {
  width: min(1120px, calc(100% - 40px));
  margin: auto;
}

.header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: rgba(8, 11, 18, .9);
  border-bottom: 1px solid rgba(255,255,255,.08);
}

.nav {
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.logo {
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 2px;
}

nav {
  display: flex;
  gap: 24px;
}

nav a {
  color: #b6c0d1;
}

.hero {
  min-height: 85vh;
  display: flex;
  align-items: center;
}

.hero h1 {
  max-width: 900px;
  margin: 20px 0;
  font-size: clamp(52px, 8vw, 100px);
  line-height: .95;
  letter-spacing: -.06em;
}

.hero h1 span {
  display: block;
  color: #8da2ff;
}

.hero p {
  max-width: 650px;
  color: #b6c0d1;
  line-height: 1.7;
  font-size: 18px;
}

.eyebrow {
  color: #8da2ff;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 2px;
}

.button {
  display: inline-block;
  margin-top: 25px;
  padding: 14px 22px;
  border-radius: 12px;
  background: white;
  color: #080b12;
  font-weight: 800;
}

.section {
  padding: 100px 0;
  border-top: 1px solid rgba(255,255,255,.08);
}

.section h2 {
  font-size: clamp(38px, 6vw, 64px);
}

.section p {
  color: #b6c0d1;
}

footer {
  padding: 30px;
  text-align: center;
  color: #667085;
  border-top: 1px solid rgba(255,255,255,.08);
}

@media (max-width: 700px) {
  nav {
    display: none;
  }
}`,

    "script.js":
`document.addEventListener("DOMContentLoaded", () => {
  console.log("AURA website ready.");
});`
  };
}

// ============================================================
// GENERATE COMPLETE WEBSITE
// ============================================================

async function generateFrontendFiles({
  projectRoot,
  projectName,
  userRequest
}) {
  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    "🎨 AURA STATIC APP GENERATION"
  );
  console.log(
    "=========================================="
  );

  let specification;

  try {
    console.log(
      "🧠 Step 1 — analyzing requirements..."
    );

    specification =
      await analyzeRequirements(
        userRequest
      );

    console.log(
      "✅ Requirements analyzed."
    );
  } catch (error) {
    console.log(
      "⚠️ Requirement analysis fallback:"
    );

    console.log(
      safeError(error)
    );

    specification =
      fallbackRequirements(
        userRequest
      );
  }

  const files = {
    "index.html": "",
    "style.css": "",
    "script.js": ""
  };

  // ==========================================================
  // FILE 1 — HTML
  // ==========================================================

  console.log(
    "💻 Generating index.html..."
  );

  try {
    files["index.html"] =
      await generateSingleFile(
        "index.html",
        userRequest,
        specification,
        files
      );

    console.log(
      "✅ index.html ready."
    );
  } catch (error) {
    console.log(
      `⚠️ index.html failed: ${safeError(
        error
      )}`
    );
  }

  // ==========================================================
  // FILE 2 — CSS
  // ==========================================================

  console.log(
    "🎨 Generating style.css..."
  );

  try {
    files["style.css"] =
      await generateSingleFile(
        "style.css",
        userRequest,
        specification,
        files
      );

    console.log(
      "✅ style.css ready."
    );
  } catch (error) {
    console.log(
      `⚠️ style.css failed: ${safeError(
        error
      )}`
    );
  }

  // ==========================================================
  // FILE 3 — JAVASCRIPT
  // ==========================================================

  console.log(
    "⚙️ Generating script.js..."
  );

  try {
    files["script.js"] =
      await generateSingleFile(
        "script.js",
        userRequest,
        specification,
        files
      );

    console.log(
      "✅ script.js ready."
    );
  } catch (error) {
    console.log(
      `⚠️ script.js failed: ${safeError(
        error
      )}`
    );
  }

  // ==========================================================
  // FALLBACK MISSING FILES
  // ==========================================================

  const fallback =
    fallbackFiles(
      userRequest
    );

  for (
    const file of [
      "index.html",
      "style.css",
      "script.js"
    ]
  ) {
    if (
      !files[file] ||
      !files[file].trim()
    ) {
      files[file] =
        fallback[file];

      console.log(
        `🛠️ Fallback used for ${file}`
      );
    }
  }

  // ==========================================================
  // REVIEW
  // ==========================================================

  let review = null;

  try {
    console.log(
      "🔍 Reviewing application..."
    );

    review =
      await reviewApplication(
        userRequest,
        specification,
        files
      );

    console.log(
      `📊 Review score: ${
        review.score ?? "N/A"
      }`
    );
  } catch (error) {
    console.log(
      `⚠️ Review unavailable: ${safeError(
        error
      )}`
    );
  }

  // ==========================================================
  // REPAIR
  // ==========================================================

  if (
    review &&
    (
      review.repairNeeded === true ||
      review.passed === false
    )
  ) {
    const repairFileName =
      [
        "index.html",
        "style.css",
        "script.js"
      ].includes(
        review.repairFile
      )
        ? review.repairFile
        : null;

    if (repairFileName) {
      try {
        console.log(
          `🔧 Repairing ${repairFileName}...`
        );

        files[
          repairFileName
        ] =
          await repairFile(
            repairFileName,
            userRequest,
            specification,
            files,
            review
          );

        console.log(
          `✅ ${repairFileName} repaired.`
        );
      } catch (error) {
        console.log(
          `⚠️ Repair failed: ${safeError(
            error
          )}`
        );
      }
    }
  }

  // ==========================================================
  // FINAL VALIDATION
  // ==========================================================

  let validation =
    validateFiles(
      files
    );

  if (
    !validation.valid
  ) {
    console.log(
      "⚠️ Final validation failed:"
    );

    console.log(
      validation.errors
    );

    /*
     * Do not replace the entire website with the fallback
     * just because one generated file has a static issue.
     *
     * We only fallback missing/empty files.
     */

    const fallback2 =
      fallbackFiles(
        userRequest
      );

    for (
      const file of [
        "index.html",
        "style.css",
        "script.js"
      ]
    ) {
      if (
        !files[file] ||
        !files[file].trim()
      ) {
        files[file] =
          fallback2[file];
      }
    }

    validation =
      validateFiles(
        files
      );
  }

  // ==========================================================
  // WRITE FILES
  // ==========================================================

  writeProjectFile(
    projectRoot,
    "index.html",
    files["index.html"]
  );

  writeProjectFile(
    projectRoot,
    "style.css",
    files["style.css"]
  );

  writeProjectFile(
    projectRoot,
    "script.js",
    files["script.js"]
  );

  console.log(
    "✅ Website generation completed."
  );

  return {
    success:
      validation.valid,

    projectRoot,

    projectName,

    files: [
      "index.html",
      "style.css",
      "script.js"
    ],

    specification,

    review,

    validation
  };
}

// ============================================================
// VERIFY
// ============================================================

function verifyFrontend(
  projectRoot
) {
  const files = {
    "index.html":
      readProjectFile(
        projectRoot,
        "index.html"
      ) || "",

    "style.css":
      readProjectFile(
        projectRoot,
        "style.css"
      ) || "",

    "script.js":
      readProjectFile(
        projectRoot,
        "script.js"
      ) || ""
  };

  const validation =
    validateFiles(
      files
    );

  const errors =
    [
      ...validation.errors
    ];

  const projectFiles =
    listProjectFiles(
      projectRoot
    );

  for (
    const file of projectFiles
  ) {
    if (
      file.endsWith(
        ".jsx"
      ) ||
      file.endsWith(
        ".tsx"
      )
    ) {
      errors.push(
        `React file found: ${file}`
      );
    }

    if (
      file ===
        "package.json" ||
      file.endsWith(
        "package-lock.json"
      )
    ) {
      errors.push(
        `NPM file found: ${file}`
      );
    }

    if (
      file.startsWith(
        ".env"
      )
    ) {
      errors.push(
        `Environment file found: ${file}`
      );
    }
  }

  return {
    success:
      errors.length === 0,

    errors,

    warnings: []
  };
}

// ============================================================
// VERCEL
// ============================================================

function sha1(buffer) {
  return crypto
    .createHash("sha1")
    .update(buffer)
    .digest("hex");
}

async function vercelRequest(
  url,
  token,
  options = {}
) {
  const response =
    await fetch(
      url,
      {
        ...options,

        headers: {
          Authorization:
            `Bearer ${token}`,

          ...(options.headers ||
            {})
        }
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data =
      text
        ? JSON.parse(text)
        : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (
    !response.ok
  ) {
    throw new Error(
      `Vercel API ${response.status}: ${
        data?.error?.message ||
        data?.error?.code ||
        text
      }`
    );
  }

  return data;
}

async function uploadVercelFile(
  token,
  buffer
) {
  const digest =
    sha1(buffer);

  const response =
    await fetch(
      "https://api.vercel.com/v2/files",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${token}`,

          "Content-Type":
            "application/octet-stream",

          "Content-Length":
            String(buffer.length),

          "x-vercel-digest":
            digest
        },

        body:
          buffer
      }
    );

  const text =
    await response.text();

  if (
    !response.ok
  ) {
    throw new Error(
      `Vercel file upload ${response.status}: ${text.slice(
        0,
        1500
      )}`
    );
  }

  return {
    sha: digest,
    size:
      buffer.length
  };
}

async function deployToVercel(
  projectRoot,
  projectName,
  accessToken,
  teamId = null
) {
  if (!accessToken) {
    return {
      success: false,
      reason:
        "Vercel account is not connected."
    };
  }

  if (
    !projectRoot ||
    !fs.existsSync(projectRoot)
  ) {
    return {
      success: false,
      reason:
        "Generated project directory does not exist."
    };
  }

  const files = [];

  for (
    const file of [
      "index.html",
      "style.css",
      "script.js"
    ]
  ) {
    const fullPath =
      path.join(
        projectRoot,
        file
      );

    if (
      !fs.existsSync(
        fullPath
      )
    ) {
      throw new Error(
        `Missing deployment file: ${file}`
      );
    }

    const buffer =
      fs.readFileSync(
        fullPath
      );

    const uploaded =
      await uploadVercelFile(
        accessToken,
        buffer
      );

    files.push({
      file,

      sha:
        uploaded.sha,

      size:
        uploaded.size
    });
  }

  const payload = {
    name:
      sanitizeProjectName(
        projectName
      ),

    files,

    target:
      "production",

    projectSettings: {
      framework:
        null
    }
  };

  let endpoint =
    "https://api.vercel.com/v13/deployments";

  if (teamId) {
    endpoint +=
      `?teamId=${encodeURIComponent(
        teamId
      )}`;
  }

  const deployment =
    await vercelRequest(
      endpoint,
      accessToken,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(
            payload
          )
      }
    );

  const url =
    deployment?.url
      ? `https://${deployment.url}`
      : null;

  if (!url) {
    throw new Error(
      "Vercel did not return a deployment URL."
    );
  }

  return {
    success:
      true,

    url,

    deploymentId:
      deployment?.id ||
      deployment?.uid ||
      null,

    state:
      deployment?.readyState ||
      "BUILDING"
  };
}

// ============================================================
// MAIN
// ============================================================

async function runAgent(
  userRequest
) {
  const request =
    String(
      userRequest || ""
    ).trim();

  if (!request) {
    throw new Error(
      "User request is empty."
    );
  }

  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    "🤖 AURA AGENT"
  );
  console.log(
    "=========================================="
  );

  console.log(
    `🎯 Goal: ${request}`
  );

  let specification;

  try {
    specification =
      await analyzeRequirements(
        request
      );
  } catch (error) {
    console.log(
      `⚠️ Planner failed: ${safeError(
        error
      )}`
    );

    specification =
      fallbackRequirements(
        request
      );
  }

  const projectName =
    sanitizeProjectName(
      specification.projectName ||
        deriveProjectName(
          request
        )
    );

  const projectRoot =
    ensureProject(
      projectName
    );

  const generation =
    await generateFrontendFiles({
      projectRoot,

      projectName,

      userRequest:
        request
    });

  const validation =
    verifyFrontend(
      projectRoot
    );

  if (
    !validation.success
  ) {
    return {
      success:
        false,

      projectName,

      projectRoot,

      projectDir:
        projectRoot,

      files:
        generation.files,

      validationResult:
        validation,

      buildAgentResult: {
        success:
          false,

        skipped:
          true
      },

      deploymentResult: {
        success:
          false,

        skipped:
          true
      },

      liveUrl:
        null
    };
  }

  return {
    success:
      true,

    projectName,

    projectRoot,

    projectDir:
      projectRoot,

    files:
      generation.files,

    validationResult:
      validation,

    buildAgentResult: {
      success:
        true,

      skipped:
        true,

      reason:
        "Static HTML/CSS/JS requires no npm build."
    },

    deploymentResult: {
      success:
        false,

      skipped:
        true,

      reason:
        "Waiting for Vercel deployment."
    },

    liveUrl:
      null
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  runAgent,

  generateFrontendFiles,

  verifyFrontend,

  deployToVercel,

  uploadVercelFile,

  sanitizeProjectName,

  listProjectFiles,

  redactSecrets,

  askAI,

  escapeHtml,

  validateFiles
};
