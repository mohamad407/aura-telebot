"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// ============================================================
// AURA AI APPLICATION AGENT
// ============================================================
//
// User request
//      ↓
// Requirement analysis
//      ↓
// Whole application generation
//      ↓
// HTML + CSS + JavaScript
//      ↓
// Requirement review
//      ↓
// Automatic repair
//      ↓
// Static validation
//      ↓
// Ready for Vercel
//
// Generated applications:
// - HTML
// - CSS
// - Vanilla JavaScript
//
// No React
// No JSX
// No Vite
// No package.json
// No npm build
// ============================================================

const PROJECTS_DIR = path.resolve(
  __dirname,
  "../projects"
);

const AI_TIMEOUT_MS = 120000;
const MAX_REVIEW_REPAIRS = 2;

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
// SAFE LOGGING
// ============================================================

function redactSecrets(value) {
  let text = String(value || "");

  const patterns = [
    /TELEGRAM_BOT_TOKEN\s*=\s*[^\s]+/gi,
    /GROQ_API_KEY\s*=\s*[^\s]+/gi,
    /OPENROUTER_API_KEY\s*=\s*[^\s]+/gi,
    /VERCEL_CLIENT_SECRET\s*=\s*[^\s]+/gi,
    /VERCEL_TOKEN\s*=\s*[^\s]+/gi,
    /Bearer\s+[A-Za-z0-9._-]+/gi,
    /sk-[A-Za-z0-9_-]+/gi,
    /gsk_[A-Za-z0-9_-]+/gi
  ];

  for (const pattern of patterns) {
    text = text.replace(
      pattern,
      "[REDACTED]"
    );
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

// ============================================================
// HTML ESCAPE
// IMPORTANT: fixes "escapeHtml is not defined"
// ============================================================

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================
// PROJECT NAME
// ============================================================

function sanitizeProjectName(input) {
  let name = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/g, "")
    .replace(/-+$/g, "")
    .replace(/-+/g, "-");

  if (!name) {
    name = "aura-website";
  }

  if (name.length > 60) {
    name = name.slice(0, 60);
  }

  return name;
}

function deriveProjectName(userRequest) {
  const text = String(
    userRequest || ""
  ).toLowerCase();

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
    text.includes("e-commerce")
  ) {
    return "aura-store";
  }

  if (
    text.includes("shop") ||
    text.includes("store")
  ) {
    return "aura-store";
  }

  return "aura-website";
}

// ============================================================
// PROJECT PATH
// ============================================================

function getProjectRoot(projectName) {
  const safeName =
    sanitizeProjectName(projectName);

  const projectRoot =
    path.resolve(
      PROJECTS_DIR,
      safeName
    );

  const projectsRoot =
    path.resolve(
      PROJECTS_DIR
    );

  if (
    !projectRoot.startsWith(
      projectsRoot + path.sep
    )
  ) {
    throw new Error(
      "Unsafe project directory."
    );
  }

  return projectRoot;
}

function ensureProject(projectName) {
  const projectRoot =
    getProjectRoot(projectName);

  fs.mkdirSync(
    projectRoot,
    {
      recursive: true
    }
  );

  return projectRoot;
}

// ============================================================
// FILE PATH SECURITY
// ============================================================

function normalizeFilePath(filePath) {
  let value = String(filePath || "")
    .replace(/\\/g, "/")
    .trim()
    .toLowerCase();

  value = value.replace(
    /^\/+/,
    ""
  );

  if (!value) {
    throw new Error(
      "Invalid file path."
    );
  }

  if (
    value.includes("..") ||
    path.isAbsolute(filePath)
  ) {
    throw new Error(
      `Unsafe file path: ${filePath}`
    );
  }

  return value;
}

function writeProjectFile(
  projectRoot,
  filePath,
  content
) {
  const safePath =
    normalizeFilePath(
      filePath
    );

  const fullPath =
    path.resolve(
      projectRoot,
      safePath
    );

  if (
    !fullPath.startsWith(
      projectRoot + path.sep
    )
  ) {
    throw new Error(
      `Unsafe output path: ${safePath}`
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

  console.log(
    `📄 Created: ${safePath}`
  );
}

function readProjectFile(
  projectRoot,
  filePath
) {
  const safePath =
    normalizeFilePath(
      filePath
    );

  const fullPath =
    path.resolve(
      projectRoot,
      safePath
    );

  if (
    !fs.existsSync(fullPath)
  ) {
    return null;
  }

  if (
    !fs.statSync(fullPath).isFile()
  ) {
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
  const files = [];

  function walk(directory) {
    if (
      !fs.existsSync(directory)
    ) {
      return;
    }

    const entries =
      fs.readdirSync(
        directory,
        {
          withFileTypes: true
        }
      );

    for (const entry of entries) {
      if (
        entry.name ===
          "node_modules" ||
        entry.name === ".git"
      ) {
        continue;
      }

      const fullPath =
        path.join(
          directory,
          entry.name
        );

      if (
        entry.isDirectory()
      ) {
        walk(fullPath);
      } else {
        files.push(
          path
            .relative(
              projectRoot,
              fullPath
            )
            .replace(
              /\\/g,
              "/"
            )
            .toLowerCase()
        );
      }
    }
  }

  walk(projectRoot);

  return files;
}

// ============================================================
// HTTP FETCH
// ============================================================

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = AI_TIMEOUT_MS
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
        signal:
          controller.signal
      }
    );
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
  const apiKey =
    process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is missing."
    );
  }

  if (
    Date.now() <
    groqDisabledUntil
  ) {
    throw new Error(
      "Groq temporarily disabled because of rate limit."
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
            `Bearer ${apiKey}`
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
            12000
        })
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    if (
      response.status === 429
    ) {
      groqDisabledUntil =
        Date.now() +
        GROQ_COOLDOWN_MS;
    }

    throw new Error(
      `Groq ${response.status}: ${text.slice(
        0,
        1500
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
    data?.choices?.[0]
      ?.message?.content;

  if (
    !content ||
    !String(content).trim()
  ) {
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
  const apiKey =
    process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is missing."
    );
  }

  if (
    Date.now() <
    openRouterDisabledUntil
  ) {
    throw new Error(
      "OpenRouter temporarily disabled because of rate limit."
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
            `Bearer ${apiKey}`,

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
            12000
        })
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    if (
      response.status === 429
    ) {
      openRouterDisabledUntil =
        Date.now() +
        OPENROUTER_COOLDOWN_MS;
    }

    throw new Error(
      `OpenRouter ${response.status}: ${text.slice(
        0,
        1500
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
    data?.choices?.[0]
      ?.message?.content;

  if (
    !content ||
    !String(content).trim()
  ) {
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
    Date.now() >=
      groqDisabledUntil
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
    Date.now() >=
      openRouterDisabledUntil
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

  let lastError =
    null;

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
    } catch (
      error
    ) {
      lastError = error;

      console.log(
        `⚠️ ${provider.name} failed.`
      );

      console.log(
        safeError(error)
      );
    }
  }

  throw new Error(
    `All AI providers failed. ${
      lastError
        ? safeError(lastError)
        : ""
    }`
  );
}

// ============================================================
// JSON EXTRACTION
// ============================================================

function extractJson(
  content
) {
  let text =
    String(
      content || ""
    ).trim();

  text = text
    .replace(
      /^```json\s*/i,
      ""
    )
    .replace(
      /^```\s*/i,
      ""
    )
    .replace(
      /\s*```$/i,
      ""
    )
    .trim();

  const start =
    text.indexOf("{");

  const end =
    text.lastIndexOf("}");

  if (
    start === -1 ||
    end === -1 ||
    end <= start
  ) {
    throw new Error(
      "AI response did not contain a JSON object."
    );
  }

  const jsonText =
    text.slice(
      start,
      end + 1
    );

  try {
    return JSON.parse(
      jsonText
    );
  } catch (
    error
  ) {
    throw new Error(
      `AI returned invalid JSON: ${error.message}`
    );
  }
}

// ============================================================
// REQUIREMENTS ANALYZER
// ============================================================

async function analyzeRequirements(
  userRequest
) {
  const prompt = `
You are AURA's senior product requirements analyst.

Convert the user's request into a complete, precise implementation specification.

USER REQUEST:
${String(
  userRequest
).slice(
  0,
  18000
)}

RULES:

1. Preserve exact branding.
2. Preserve exact data.
3. Preserve exact product count when specified.
4. Preserve exact prices.
5. Preserve exact ratings.
6. Preserve exact stock values.
7. Preserve requested features.
8. Preserve persistence requirements.
9. Preserve requested interactions.
10. Do not invent a backend when the user asked frontend-only.
11. Do not replace vanilla HTML/CSS/JS with React.
12. Do not simplify a complex application into a landing page.

Return ONLY JSON:

{
  "projectName": "",
  "brand": {
    "name": "",
    "tagline": ""
  },
  "pages": [],
  "features": [],
  "data": [],
  "persistence": [],
  "uiRequirements": [],
  "validationRequirements": [],
  "specialRequirements": []
}
`;

  const response =
    await askAI(
      [
        {
          role: "system",
          content:
            "You are a senior requirements analyst. Return JSON only."
        },

        {
          role: "user",
          content:
            prompt
        }
      ],
      {
        temperature: 0.1,
        max_tokens: 5000
      }
    );

  return extractJson(
    response
  );
}

function fallbackRequirements(
  userRequest
) {
  return {
    projectName:
      deriveProjectName(
        userRequest
      ),

    brand: {
      name:
        "AURA Website",

      tagline:
        String(
          userRequest
        ).slice(
          0,
          120
        )
    },

    pages: [
      "Home"
    ],

    features: [
      "Responsive navigation",
      "Hero section",
      "Main content",
      "Interactive controls"
    ],

    data: [],

    persistence: [],

    uiRequirements: [
      "Modern",
      "Clean",
      "Responsive",
      "Mobile friendly"
    ],

    validationRequirements: [
      "No broken required features."
    ],

    specialRequirements: []
  };
}

// ============================================================
// COMPLETE APPLICATION GENERATOR
// ============================================================

async function generateCompleteApplication(
  userRequest,
  specification,
  projectName
) {
  const prompt = `
You are AURA's senior frontend engineer.

You are building ONE COMPLETE FRONTEND APPLICATION.

Do NOT treat this as three unrelated file-generation tasks.

USER REQUEST:
${String(
  userRequest
).slice(
  0,
  18000
)}

STRUCTURED REQUIREMENTS:
${JSON.stringify(
  specification,
  null,
  2
)}

PROJECT NAME:
${projectName}

============================================================
TECHNOLOGY
============================================================

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
- backend code

============================================================
FILES
============================================================

Return exactly:

index.html
style.css
script.js

They must work together as ONE application.

============================================================
IMPLEMENTATION REQUIREMENTS
============================================================

Implement ALL explicit requirements.

Do not omit features.

Do not replace real functionality with fake buttons.

If the request says localStorage:
actually use localStorage.

If it says exact products:
use exactly those products.

If it says exact price:
preserve the price.

If it says exact stock:
preserve the stock.

If it says checkout:
implement checkout.

If it says payment validation:
implement validation.

If it says order history:
implement order history.

If it says search:
implement real-time search.

If it says cart:
implement a real cart.

If it says responsive:
make it genuinely responsive.

============================================================
DESIGN
============================================================

Build a polished production-style UI.

Use:

- strong visual hierarchy
- responsive spacing
- good typography
- clean cards
- polished buttons
- hover states
- focus states
- mobile layout
- accessible labels
- sensible transitions
- modern color palette
- realistic product/image areas where appropriate

Do not make it look like a generic generated template.

============================================================
LUCIDE ICONS
============================================================

If Lucide icons are requested, use the browser CDN:

<script src="https://unpkg.com/lucide@latest"></script>

Use data-lucide icons and initialize:

lucide.createIcons();

Do not use React icon libraries.

============================================================
DATA PERSISTENCE
============================================================

When localStorage is requested, design a clear persistence layer.

Example:

localStorage keys may include:

- aura_cart
- aura_products
- aura_orders
- aura_checkout

Use JSON.parse/JSON.stringify safely.

Handle malformed localStorage data.

============================================================
QUALITY
============================================================

Every visible interactive control must have working JavaScript.

Do not create:

- fake Add to Cart buttons
- fake quantity controls
- fake checkout
- fake payment
- fake search
- fake navigation

============================================================
OUTPUT
============================================================

Return ONLY JSON:

{
  "index.html": "...",
  "style.css": "...",
  "script.js": "..."
}

Do not return Markdown fences.

Do not add explanations.

Do not add metadata.

Do not add:

"User Safety: safe"

"Safety: safe"

"As an AI"

or similar text.
`;

  const response =
    await askAI(
      [
        {
          role: "system",
          content:
            "You are an expert senior frontend engineer. Return JSON only."
        },

        {
          role: "user",
          content:
            prompt
        }
      ],
      {
        temperature: 0.25,
        max_tokens: 30000
      }
    );

  const data =
    extractJson(
      response
    );

  const required = [
    "index.html",
    "style.css",
    "script.js"
  ];

  for (
    const file of required
  ) {
    if (
      typeof data[file] !==
      "string" ||
      !data[file].trim()
    ) {
      throw new Error(
        `Generated ${file} is missing or empty.`
      );
    }
  }

  return {
    "index.html":
      data[
        "index.html"
      ],

    "style.css":
      data[
        "style.css"
      ],

    "script.js":
      data[
        "script.js"
      ]
  };
}

// ============================================================
// BASIC STATIC VALIDATION
// ============================================================

function validateStaticFiles(
  files
) {
  const errors = [];

  const html =
    files?.[
      "index.html"
    ] || "";

  const css =
    files?.[
      "style.css"
    ] || "";

  const js =
    files?.[
      "script.js"
    ] || "";

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
      "index.html is missing DOCTYPE."
    );
  }

  if (
    html &&
    !/<html[\s>]/i.test(
      html
    )
  ) {
    errors.push(
      "index.html is missing html element."
    );
  }

  if (
    html &&
    !/<body[\s>]/i.test(
      html
    )
  ) {
    errors.push(
      "index.html is missing body element."
    );
  }

  if (
    html &&
    !/style\.css/i.test(
      html
    )
  ) {
    errors.push(
      "index.html does not reference style.css."
    );
  }

  if (
    html &&
    !/script\.js/i.test(
      html
    )
  ) {
    errors.push(
      "index.html does not reference script.js."
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
    /\bReact\b/i.test(
      combined
    ) ||
    /\.jsx\b/i.test(
      combined
    )
  ) {
    errors.push(
      "React/JSX content detected."
    );
  }

  if (
    /package\.json/i.test(
      combined
    ) ||
    /npm install/i.test(
      combined
    ) ||
    /vite/i.test(
      combined
    )
  ) {
    errors.push(
      "Framework/build-tool content detected."
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
// FALLBACK APP
// ============================================================

function fallbackFiles(
  userRequest
) {
  const safeRequest =
    escapeHtml(
      userRequest
    );

  const indexHtml =
`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >

  <meta
    name="description"
    content="Website created by AURA"
  >

  <title>AURA Website</title>

  <link
    rel="stylesheet"
    href="./style.css"
  >
</head>

<body>

<header class="site-header">
  <div class="container nav">

    <a
      href="#home"
      class="logo"
    >
      AURA
    </a>

    <nav
      class="nav-links"
    >
      <a href="#home">
        Home
      </a>

      <a href="#features">
        Features
      </a>

      <a href="#contact">
        Contact
      </a>
    </nav>

    <button
      id="menuButton"
      class="menu-button"
      type="button"
      aria-label="Open menu"
    >
      ☰
    </button>

  </div>
</header>

<main>

<section
  id="home"
  class="hero"
>

  <div class="container hero-inner">

    <p class="eyebrow">
      CREATED WITH AURA
    </p>

    <h1>
      Your idea.
      <span>Your website.</span>
    </h1>

    <p class="hero-copy">
      ${safeRequest}
    </p>

    <a
      class="primary-button"
      href="#features"
    >
      Explore
    </a>

  </div>

</section>

<section
  id="features"
  class="section"
>

  <div class="container">

    <p class="eyebrow">
      FEATURES
    </p>

    <h2>
      Clean. Fast. Modern.
    </h2>

    <div class="cards">

      <article class="card">
        <span class="card-number">
          01
        </span>

        <h3>
          Modern Design
        </h3>

        <p>
          Polished responsive interface.
        </p>
      </article>

      <article class="card">
        <span class="card-number">
          02
        </span>

        <h3>
          Interactive
        </h3>

        <p>
          Browser-based functionality.
        </p>
      </article>

      <article class="card">
        <span class="card-number">
          03
        </span>

        <h3>
          Ready to Deploy
        </h3>

        <p>
          Lightweight static architecture.
        </p>
      </article>

    </div>

  </div>

</section>

<section
  id="contact"
  class="section contact"
>

  <div class="container">

    <p class="eyebrow">
      CONTACT
    </p>

    <h2>
      Let's build something.
    </h2>

    <button
      id="contactButton"
      class="primary-button"
      type="button"
    >
      Get Started
    </button>

  </div>

</section>

</main>

<footer>
  <div class="container">
    Built with AURA ✦
  </div>
</footer>

<script
  src="./script.js"
></script>

</body>
</html>`;

  const styleCss =
`* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;

  font-family:
    Inter,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  background: #070b12;
  color: #ffffff;
}

a {
  color: inherit;
  text-decoration: none;
}

button {
  font: inherit;
}

.container {
  width:
    min(
      1120px,
      calc(100% - 40px)
    );

  margin:
    0 auto;
}

.site-header {
  position: sticky;
  top: 0;
  z-index: 50;

  background:
    rgba(
      7,
      11,
      18,
      0.86
    );

  backdrop-filter:
    blur(18px);

  border-bottom:
    1px solid
    rgba(
      255,
      255,
      255,
      0.08
    );
}

.nav {
  min-height: 72px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    space-between;
}

.logo {
  font-weight: 900;
  letter-spacing: 2px;
}

.nav-links {
  display:
    flex;

  gap:
    24px;
}

.nav-links a {
  color:
    #aeb7c8;
}

.menu-button {
  display:
    none;

  border:
    0;

  background:
    transparent;

  color:
    #ffffff;
}

.hero {
  min-height:
    82vh;

  display:
    flex;

  align-items:
    center;

  background:
    radial-gradient(
      circle at 50% 0%,
      rgba(
        99,
        102,
        241,
        0.24
      ),
      transparent 50%
    );
}

.hero-inner {
  padding:
    100px 0;
}

.eyebrow {
  color:
    #8da2ff;

  font-size:
    12px;

  font-weight:
    800;

  letter-spacing:
    2px;
}

h1 {
  max-width:
    900px;

  margin:
    18px 0;

  font-size:
    clamp(
      52px,
      9vw,
      104px
    );

  line-height:
    0.95;

  letter-spacing:
    -0.06em;
}

h1 span {
  display:
    block;

  color:
    #8da2ff;
}

.hero-copy {
  max-width:
    680px;

  color:
    #aeb7c8;

  font-size:
    19px;

  line-height:
    1.7;
}

.primary-button {
  display:
    inline-flex;

  align-items:
    center;

  justify-content:
    center;

  min-height:
    48px;

  padding:
    0 22px;

  margin-top:
    24px;

  border:
    0;

  border-radius:
    12px;

  background:
    #ffffff;

  color:
    #070b12;

  font-weight:
    800;

  cursor:
    pointer;
}

.section {
  padding:
    100px 0;

  border-top:
    1px solid
    rgba(
      255,
      255,
      255,
      0.07
    );
}

.section h2,
.contact h2 {
  margin:
    16px 0 0;

  font-size:
    clamp(
      36px,
      6vw,
      64px
    );

  line-height:
    1;
}

.cards {
  margin-top:
    50px;

  display:
    grid;

  grid-template-columns:
    repeat(
      3,
      minmax(
        0,
        1fr
      )
    );

  gap:
    20px;
}

.card {
  padding:
    30px;

  min-height:
    220px;

  border:
    1px solid
    rgba(
      255,
      255,
      255,
      0.08
    );

  border-radius:
    22px;

  background:
    rgba(
      255,
      255,
      255,
      0.035
    );
}

.card-number {
  color:
    #8da2ff;

  font-weight:
    900;

  display:
    block;

  margin-bottom:
    34px;
}

.card h3 {
  font-size:
    24px;
}

.card p {
  color:
    #aeb7c8;
}

.contact {
  text-align:
    center;
}

footer {
  padding:
    30px 0;

  color:
    #697386;

  text-align:
    center;

  border-top:
    1px solid
    rgba(
      255,
      255,
      255,
      0.07
    );
}

@media (
  max-width: 720px
) {
  .nav-links {
    display:
      none;
  }

  .menu-button {
    display:
      block;
  }

  .cards {
    grid-template-columns:
      1fr;
  }
}`;

  const scriptJs =
`document.addEventListener(
  "DOMContentLoaded",
  () => {
    const contactButton =
      document.getElementById(
        "contactButton"
      );

    if (contactButton) {
      contactButton.addEventListener(
        "click",
        () => {
          alert(
            "Thanks for getting started!"
          );
        }
      );
    }

    const menuButton =
      document.getElementById(
        "menuButton"
      );

    if (menuButton) {
      menuButton.addEventListener(
        "click",
        () => {
          const nav =
            document.querySelector(
              ".nav-links"
            );

          if (nav) {
            nav.classList.toggle(
              "mobile-open"
            );
          }
        }
      );
    }
  }
);`;

  return {
    "index.html":
      indexHtml,

    "style.css":
      styleCss,

    "script.js":
      scriptJs
  };
}

// ============================================================
// AI REVIEWER
// ============================================================

async function reviewApplication(
  userRequest,
  specification,
  files
) {
  const prompt = `
You are AURA's senior frontend QA engineer.

Review this COMPLETE application against the user's original request.

ORIGINAL REQUEST:
${String(
  userRequest
).slice(
  0,
  18000
)}

REQUIREMENTS:
${JSON.stringify(
  specification,
  null,
  2
)}

INDEX.HTML:
${files["index.html"]}

STYLE.CSS:
${files["style.css"]}

SCRIPT.JS:
${files["script.js"]}

Return ONLY JSON:

{
  "passed": true,
  "score": 100,
  "missingRequirements": [],
  "brokenFeatures": [],
  "designProblems": [],
  "repairNeeded": false,
  "repairInstructions": []
}

Be strict.

Check:

- exact branding
- exact text
- exact product count
- exact product data
- search
- cart
- cart count
- quantity
- remove
- subtotal
- shipping
- total
- checkout
- card validation
- payment validation
- stock management
- localStorage
- order history
- navigation
- responsive design
- button behavior
- missing IDs
- missing selectors
- broken functions
- missing script references
- invalid JavaScript
- React/JSX
- Vite
- npm

Do not invent requirements.
`;

  const response =
    await askAI(
      [
        {
          role:
            "system",

          content:
            "You are a strict senior frontend QA engineer. Return JSON only."
        },

        {
          role:
            "user",

          content:
            prompt
        }
      ],
      {
        temperature:
          0.1,

        max_tokens:
          9000
      }
    );

  return extractJson(
    response
  );
}

// ============================================================
// REPAIRER
// ============================================================

async function repairApplication(
  userRequest,
  specification,
  files,
  review
) {
  const prompt = `
You are AURA's senior frontend repair engineer.

Repair the COMPLETE application.

ORIGINAL USER REQUEST:
${String(
  userRequest
).slice(
  0,
  18000
)}

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

CURRENT INDEX.HTML:
${files["index.html"]}

CURRENT STYLE.CSS:
${files["style.css"]}

CURRENT SCRIPT.JS:
${files["script.js"]}

Repair EVERY identified issue.

Do not remove existing working features.

Do not replace real features with placeholders.

Keep exact user data.

Keep exact branding.

Keep the interface polished.

Keep responsive behavior.

Use only HTML/CSS/vanilla JavaScript.

No React.

No JSX.

No Vite.

No npm.

No package.json.

No backend.

No AI metadata.

Return ONLY JSON:

{
  "index.html": "...",
  "style.css": "...",
  "script.js": "..."
}
`;

  const response =
    await askAI(
      [
        {
          role:
            "system",

          content:
            "You are a senior frontend repair engineer. Return JSON only."
        },

        {
          role:
            "user",

          content:
            prompt
        }
      ],
      {
        temperature:
          0.15,

        max_tokens:
          30000
      }
    );

  const result =
    extractJson(
      response
    );

  const required = [
    "index.html",
    "style.css",
    "script.js"
  ];

  for (
    const file of required
  ) {
    if (
      typeof result[file] !==
        "string" ||
      !result[file].trim()
    ) {
      throw new Error(
        `Repair response missing ${file}.`
      );
    }
  }

  return {
    "index.html":
      result[
        "index.html"
      ],

    "style.css":
      result[
        "style.css"
      ],

    "script.js":
      result[
        "script.js"
      ]
  };
}

// ============================================================
// COMPLETE APPLICATION VALIDATION
// ============================================================

function validateApplication(
  files
) {
  const errors = [];

  const staticResult =
    validateStaticFiles(
      files
    );

  if (
    !staticResult.valid
  ) {
    errors.push(
      ...staticResult.errors
    );
  }

  return {
    success:
      errors.length === 0,

    errors
  };
}

// ============================================================
// WRITE COMPLETE APP
// ============================================================

function writeApplication(
  projectRoot,
  files
) {
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
}

// ============================================================
// GENERATE FRONTEND
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
    "🎨 WHOLE APPLICATION GENERATION"
  );

  console.log(
    "=========================================="
  );

  let specification;

  try {
    console.log(
      "🧠 Analyzing requirements..."
    );

    specification =
      await analyzeRequirements(
        userRequest
      );

    console.log(
      "✅ Requirements analyzed."
    );
  } catch (
    error
  ) {
    console.log(
      "⚠️ Requirements analysis failed."
    );

    console.log(
      safeError(error)
    );

    specification =
      fallbackRequirements(
        userRequest
      );
  }

  let files;

  try {
    console.log(
      "💻 Generating complete application..."
    );

    files =
      await generateCompleteApplication(
        userRequest,
        specification,
        projectName
      );

    console.log(
      "✅ Complete application generated."
    );
  } catch (
    error
  ) {
    console.log(
      "⚠️ Complete generation failed."
    );

    console.log(
      safeError(error)
    );

    console.log(
      "🛠️ Using fallback application."
    );

    files =
      fallbackFiles(
        userRequest
      );
  }

  // =========================================================
  // REVIEW + REPAIR
  // =========================================================

  let reviewPassed =
    false;

  let repairAttempts =
    0;

  for (
    let attempt = 0;
    attempt <=
      MAX_REVIEW_REPAIRS;
    attempt++
  ) {
    const staticValidation =
      validateApplication(
        files
      );

    if (
      !staticValidation.success
    ) {
      console.log(
        "⚠️ Static validation issues:"
      );

      console.log(
        staticValidation.errors
      );
    }

    try {
      console.log(
        `🔍 Reviewing application (${attempt + 1}/${MAX_REVIEW_REPAIRS + 1})...`
      );

      const review =
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

      const valid =
        staticValidation.success;

      const aiPassed =
        review.passed === true &&
        review.repairNeeded !==
          true;

      if (
        valid &&
        aiPassed
      ) {
        console.log(
          "✅ Application review passed."
        );

        reviewPassed =
          true;

        break;
      }

      if (
        attempt >=
        MAX_REVIEW_REPAIRS
      ) {
        break;
      }

      console.log(
        "🔧 Repairing application..."
      );

      files =
        await repairApplication(
          userRequest,
          specification,
          files,
          review
        );

      repairAttempts++;

      console.log(
        "✅ Application repaired."
      );
    } catch (
      error
    ) {
      console.log(
        "⚠️ Review/repair unavailable:"
      );

      console.log(
        safeError(error)
      );

      /*
       * If static structure is valid,
       * don't destroy the generated app
       * because the reviewer hit a rate limit.
       */

      if (
        validateApplication(
          files
        ).success
      ) {
        reviewPassed =
          true;

        break;
      }
    }
  }

  // =========================================================
  // FINAL VALIDATION
  // =========================================================

  let finalValidation =
    validateApplication(
      files
    );

  if (
    !finalValidation.success
  ) {
    console.log(
      "⚠️ Final validation failed."
    );

    console.log(
      finalValidation.errors
    );

    console.log(
      "🛠️ Using fallback application."
    );

    files =
      fallbackFiles(
        userRequest
      );

    finalValidation =
      validateApplication(
        files
      );
  }

  writeApplication(
    projectRoot,
    files
  );

  console.log(
    "✅ Website files written."
  );

  return {
    success:
      finalValidation.success,

    projectRoot,

    projectName,

    files: [
      "index.html",
      "style.css",
      "script.js"
    ],

    specification,

    reviewPassed,

    repairAttempts
  };
}

// ============================================================
// VERIFY FRONTEND
// ============================================================

function verifyFrontend(
  projectRoot
) {
  console.log("");
  console.log(
    "=========================================="
  );

  console.log(
    "🔐 STATIC WEBSITE VERIFICATION"
  );

  console.log(
    "=========================================="
  );

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
    validateApplication(
      files
    );

  const errors =
    [...validation.errors];

  const allFiles =
    listProjectFiles(
      projectRoot
    );

  for (
    const file of allFiles
  ) {
    if (
      file.endsWith(".jsx") ||
      file.endsWith(".tsx")
    ) {
      errors.push(
        `React file found: ${file}`
      );
    }

    if (
      file === "package.json" ||
      file.endsWith(
        "package-lock.json"
      )
    ) {
      errors.push(
        `NPM file found: ${file}`
      );
    }

    if (
      file.startsWith(".env")
    ) {
      errors.push(
        `Environment file found: ${file}`
      );
    }
  }

  if (
    errors.length > 0
  ) {
    console.log(
      "❌ Verification failed."
    );

    console.log(
      errors
    );

    return {
      success:
        false,

      errors,

      warnings: []
    };
  }

  console.log(
    "✅ Static website verified."
  );

  return {
    success:
      true,

    errors: [],

    warnings: []
  };
}

// ============================================================
// SHA1
// ============================================================

function sha1(buffer) {
  return crypto
    .createHash(
      "sha1"
    )
    .update(
      buffer
    )
    .digest(
      "hex"
    );
}

// ============================================================
// VERCEL REQUEST
// ============================================================

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
        ? JSON.parse(
            text
          )
        : {};
  } catch {
    data = {
      raw:
        text
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

// ============================================================
// VERCEL FILE UPLOAD
// ============================================================

async function uploadVercelFile(
  token,
  buffer
) {
  const digest =
    sha1(
      buffer
    );

  const response =
    await fetch(
      "https://api.vercel.com/v2/files",
      {
        method:
          "POST",

        headers: {
          Authorization:
            `Bearer ${token}`,

          "Content-Type":
            "application/octet-stream",

          "Content-Length":
            String(
              buffer.length
            ),

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
      `Vercel file upload failed (${response.status}): ${text.slice(
        0,
        2000
      )}`
    );
  }

  return {
    sha:
      digest,

    size:
      buffer.length
  };
}

// ============================================================
// DEPLOY TO VERCEL
// ============================================================

async function deployToVercel(
  projectRoot,
  projectName,
  accessToken,
  teamId = null
) {
  console.log("");
  console.log(
    "=========================================="
  );

  console.log(
    "🚀 VERCEL DEPLOYMENT"
  );

  console.log(
    "=========================================="
  );

  if (
    !accessToken
  ) {
    return {
      success:
        false,

      reason:
        "No Vercel access token."
    };
  }

  if (
    !projectRoot ||
    !fs.existsSync(
      projectRoot
    )
  ) {
    return {
      success:
        false,

      reason:
        "Generated project directory does not exist."
    };
  }

  const safeProjectName =
    sanitizeProjectName(
      projectName
    );

  const requiredFiles = [
    "index.html",
    "style.css",
    "script.js"
  ];

  const files = [];

  for (
    const file of requiredFiles
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

    console.log(
      `☁️ Uploading ${file}...`
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
      safeProjectName,

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

  if (
    teamId
  ) {
    endpoint +=
      `?teamId=${encodeURIComponent(
        teamId
      )}`;
  }

  console.log(
    `🚀 Creating Vercel deployment: ${safeProjectName}`
  );

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

  const deploymentUrl =
    deployment?.url
      ? `https://${deployment.url}`
      : null;

  if (
    !deploymentUrl
  ) {
    throw new Error(
      "Vercel did not return a deployment URL."
    );
  }

  console.log(
    `🌐 Live URL: ${deploymentUrl}`
  );

  return {
    success:
      true,

    url:
      deploymentUrl,

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
// MAIN AGENT
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

  // ==========================================================
  // REQUIREMENT ANALYSIS
  // ==========================================================

  let specification;

  try {
    specification =
      await analyzeRequirements(
        request
      );
  } catch (
    error
  ) {
    console.log(
      "⚠️ Requirements analysis failed."
    );

    console.log(
      safeError(error)
    );

    specification =
      fallbackRequirements(
        request
      );
  }

  const projectName =
    sanitizeProjectName(
      specification?.projectName ||
        deriveProjectName(
          request
        )
    );

  const projectRoot =
    ensureProject(
      projectName
    );

  console.log(
    `📦 Project: ${projectName}`
  );

  console.log(
    `📍 Project root: ${projectRoot}`
  );

  // ==========================================================
  // GENERATE
  // ==========================================================

  const generation =
    await generateFrontendFiles({
      projectRoot,

      projectName,

      userRequest:
        request
    });

  // ==========================================================
  // VERIFY
  // ==========================================================

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
          true,

        reason:
          "Static website verification failed."
      },

      deploymentResult: {
        success:
          false,

        skipped:
          true,

        reason:
          "Deployment blocked because validation failed."
      },

      liveUrl:
        null,

      repairAttempts:
        generation.repairAttempts
    };
  }

  // ==========================================================
  // STATIC BUILD
  // ==========================================================

  const buildResult = {
    success:
      true,

    skipped:
      true,

    reason:
      "Static HTML/CSS/JS application requires no npm build."
  };

  // ==========================================================
  // RETURN
  // ==========================================================

  return {
    success:
      true,

    projectName,

    projectRoot,

    /*
     * Compatibility with server.js versions
     * that use projectDir.
     */
    projectDir:
      projectRoot,

    files:
      generation.files,

    validationResult:
      validation,

    buildAgentResult:
      buildResult,

    deploymentResult: {
      success:
        false,

      skipped:
        true,

      reason:
        "Waiting for Vercel deployment."
    },

    liveUrl:
      null,

    repairAttempts:
      generation.repairAttempts,

    specification:
      generation.specification
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

  redactSecrets,

  askAI,

  validateStaticFiles,

  listProjectFiles,

  escapeHtml
};
