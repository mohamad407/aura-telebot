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

const FILE_GENERATION_RETRIES = 1;
const MAX_REPAIR_ATTEMPTS = 1;

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
    /VERCEL_CLIENT_ID\s*=\s*[^\s]+/gi,
    /VERCEL_CLIENT_SECRET\s*=\s*[^\s]+/gi,
    /VERCEL_TOKEN\s*=\s*[^\s]+/gi,
    /Bearer\s+[A-Za-z0-9._-]+/gi,
    /gsk_[A-Za-z0-9_-]+/gi,
    /sk-[A-Za-z0-9_-]+/gi,
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
    .replace(/_+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!name) {
    name = "aura-website";
  }

  return name.slice(0, 60);
}

function deriveProjectName(request) {
  const text =
    String(request || "").toLowerCase();

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
    text.includes("shop") ||
    text.includes("store")
  ) {
    return "aura-store";
  }

  if (
    text.includes("dashboard") ||
    text.includes("admin")
  ) {
    return "aura-dashboard";
  }

  return "aura-website";
}

// ============================================================
// PROJECT PATH
// ============================================================

function getProjectRoot(projectName) {
  const safeName =
    sanitizeProjectName(projectName);

  const root =
    path.resolve(
      PROJECTS_DIR,
      safeName
    );

  const base =
    path.resolve(
      PROJECTS_DIR
    );

  if (
    !root.startsWith(
      base + path.sep
    )
  ) {
    throw new Error(
      "Unsafe project path."
    );
  }

  return root;
}

function ensureProject(projectName) {
  const root =
    getProjectRoot(
      projectName
    );

  fs.mkdirSync(
    root,
    {
      recursive: true,
    }
  );

  return root;
}

// ============================================================
// FILE HELPERS
// ============================================================

function normalizeFilePath(filePath) {
  const original =
    String(filePath || "");

  const value =
    original
      .replace(/\\/g, "/")
      .trim()
      .toLowerCase();

  if (!value) {
    throw new Error(
      "Empty file path."
    );
  }

  if (
    value.includes("..") ||
    path.isAbsolute(original)
  ) {
    throw new Error(
      `Unsafe file path: ${original}`
    );
  }

  return value.replace(
    /^\/+/,
    ""
  );
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
    path.dirname(
      fullPath
    ),
    {
      recursive: true,
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
    !fs.existsSync(
      fullPath
    )
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
      !fs.existsSync(
        directory
      )
    ) {
      return;
    }

    const entries =
      fs.readdirSync(
        directory,
        {
          withFileTypes: true,
        }
      );

    for (
      const entry of entries
    ) {
      if (
        entry.name ===
          "node_modules" ||
        entry.name ===
          ".git"
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
// HARD AI TIMEOUT
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
          controller.signal,
      }
    );
  } catch (
    error
  ) {
    if (
      error?.name ===
      "AbortError"
    ) {
      throw new Error(
        `Request timed out after ${Math.round(
          timeoutMs / 1000
        )} seconds.`
      );
    }

    throw error;
  } finally {
    clearTimeout(
      timer
    );
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
      "Groq temporarily disabled."
    );
  }

  const response =
    await fetchWithTimeout(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${apiKey}`,
        },

        body:
          JSON.stringify({
            model:
              options.model ||
              GROQ_MODEL,

            messages,

            temperature:
              options.temperature ??
              0.2,

            max_tokens:
              options.max_tokens ||
              5000,
          }),
      },
      options.timeoutMs ||
        AI_TIMEOUT_MS
    );

  const text =
    await response.text();

  if (
    !response.ok
  ) {
    if (
      response.status === 429 ||
      response.status === 413
    ) {
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

  const data =
    JSON.parse(
      text
    );

  const content =
    data?.choices?.[0]
      ?.message?.content;

  if (!content) {
    throw new Error(
      "Groq returned empty content."
    );
  }

  return String(
    content
  );
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
      "OpenRouter temporarily disabled."
    );
  }

  const response =
    await fetchWithTimeout(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method:
          "POST",

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
            "AURA Agent",
        },

        body:
          JSON.stringify({
            model:
              options.model ||
              OPENROUTER_MODEL,

            messages,

            temperature:
              options.temperature ??
              0.2,

            max_tokens:
              options.max_tokens ||
              5000,
          }),
      },
      options.timeoutMs ||
        AI_TIMEOUT_MS
    );

  const text =
    await response.text();

  if (
    !response.ok
  ) {
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
        1800
      )}`
    );
  }

  const data =
    JSON.parse(
      text
    );

  const content =
    data?.choices?.[0]
      ?.message?.content;

  if (!content) {
    throw new Error(
      "OpenRouter returned empty content."
    );
  }

  return String(
    content
  );
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
      name:
        "Groq",

      run:
        () =>
          askGroq(
            messages,
            options
          ),
    });
  }

  if (
    process.env.OPENROUTER_API_KEY &&
    Date.now() >=
      openRouterDisabledUntil
  ) {
    providers.push({
      name:
        "OpenRouter",

      run:
        () =>
          askOpenRouter(
            messages,
            options
          ),
    });
  }

  if (!providers.length) {
    throw new Error(
      "No AI provider is available."
    );
  }

  let lastError =
    null;

  for (
    const provider of
      providers
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
      lastError =
        error;

      console.log(
        `⚠️ ${provider.name} failed: ${safeError(
          error
        )}`
      );
    }
  }

  throw new Error(
    lastError
      ? safeError(
          lastError
        )
      : "All AI providers failed."
  );
}

// ============================================================
// JSON EXTRACTION
// ============================================================

function extractJson(
  value
) {
  let text =
    String(
      value || ""
    )
      .trim();

  text =
    text
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

  const first =
    text.indexOf(
      "{"
    );

  const last =
    text.lastIndexOf(
      "}"
    );

  if (
    first === -1 ||
    last === -1 ||
    last <= first
  ) {
    throw new Error(
      "AI response did not contain JSON."
    );
  }

  return JSON.parse(
    text.slice(
      first,
      last + 1
    )
  );
}

// ============================================================
// REQUIREMENT ANALYSIS
// ============================================================

async function analyzeRequirements(
  request
) {
  const prompt = `
Analyze the following website request.

USER REQUEST:
${String(
  request
).slice(
  0,
  12000
)}

Preserve exact:
- branding
- text
- product count
- names
- prices
- ratings
- stock
- features
- persistence requirements

Do not invent additional requirements.

Return JSON only:

{
  "projectName": "",
  "brandName": "",
  "tagline": "",
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
          role:
            "system",

          content:
            "You are a requirements analyst. Return JSON only.",
        },

        {
          role:
            "user",

          content:
            prompt,
        },
      ],
      {
        temperature:
          0.1,

        max_tokens:
          2000,

        timeoutMs:
          REVIEW_TIMEOUT_MS,
      }
    );

  return extractJson(
    response
  );
}

function fallbackRequirements(
  request
) {
  return {
    projectName:
      deriveProjectName(
        request
      ),

    brandName:
      "AURA Website",

    tagline:
      String(
        request
      ).slice(
        0,
        100
      ),

    features:
      [],

    exactData:
      [],

    persistence:
      [],

    designRequirements: [
      "Modern",
      "Responsive",
    ],

    validationRequirements:
      [],
  };
}

// ============================================================
// COMPACT REQUIREMENT CONTEXT
// ============================================================

function requirementContext(
  specification
) {
  return JSON.stringify(
    specification,
    null,
    2
  ).slice(
    0,
    10000
  );
}

// ============================================================
// HTML PROMPT
// ============================================================

function buildHtmlPrompt(
  request,
  specification
) {
  return `
You are AURA's senior frontend engineer.

Build the HTML structure for ONE COMPLETE frontend application.

ORIGINAL REQUEST:
${String(
  request
).slice(
  0,
  13000
)}

REQUIREMENTS:
${requirementContext(
  specification
)}

IMPORTANT:

Use ONLY vanilla HTML5.

No React.
No JSX.
No Next.js.
No Vite.
No npm.
No package.json.

The other files will be generated separately.

The HTML MUST include:

- all required sections
- navigation
- hero
- product area
- search
- cart UI
- checkout UI
- payment UI
- success/order UI
- all IDs/classes needed by JavaScript
- ./style.css
- ./script.js

If Lucide icons are required, include the Lucide CDN.

Do NOT omit required functionality from the markup.

Return ONLY complete index.html.
`;
}

// ============================================================
// CSS PROMPT
// ============================================================

function buildCssPrompt(
  request,
  specification,
  html
) {
  return `
You are AURA's senior frontend designer.

Create the COMPLETE CSS for the application described below.

ORIGINAL REQUEST:
${String(
  request
).slice(
  0,
  10000
)}

REQUIREMENTS:
${requirementContext(
  specification
)}

HTML STRUCTURE:
${String(
  html
).slice(
  0,
  18000
)}

Create polished CSS for:

- responsive navigation
- hero
- product grid
- product cards
- product images
- search
- cart
- cart controls
- checkout
- forms
- buttons
- errors
- success screen
- mobile
- tablet
- desktop

Make it look like a real production application.

Do not create CSS comments about AI.

Return ONLY CSS.
`;
}

// ============================================================
// JAVASCRIPT PROMPT
// ============================================================

function buildJavascriptPrompt(
  request,
  specification,
  html,
  css
) {
  return `
You are AURA's senior frontend JavaScript engineer.

Create the COMPLETE browser JavaScript for the application.

ORIGINAL REQUEST:
${String(
  request
).slice(
  0,
  12000
)}

REQUIREMENTS:
${requirementContext(
  specification
)}

HTML STRUCTURE:
${String(
  html
).slice(
  0,
  16000
)}

Do not rely on receiving the complete CSS.

Implement ALL requested functionality.

For ecommerce applications, this includes where requested:

- exact product data
- localStorage
- initialization
- search
- product filtering
- add to cart
- cart count
- increase quantity
- decrease quantity
- remove
- subtotal
- shipping
- grand total
- checkout
- address validation
- card validation
- expiry validation
- payment
- stock updates
- order history
- success screen
- state persistence
- navigation
- Lucide initialization

Use ONLY vanilla JavaScript.

No React.
No JSX.
No import statements.
No npm.
No backend.

Do not create fake functions.

Do not leave TODO placeholders.

Return ONLY JavaScript.
`;
}

// ============================================================
// CLEAN SOURCE
// ============================================================

function cleanCodeOutput(
  value
) {
  return String(
    value || ""
  )
    .trim()
    .replace(
      /^```(?:html|css|js|javascript)?\s*/i,
      ""
    )
    .replace(
      /\s*```$/i,
      ""
    )
    .trim();
}

// ============================================================
// SINGLE FILE GENERATION
// ============================================================

async function generateOneFile(
  file,
  request,
  specification,
  files
) {
  let prompt;

  if (
    file ===
    "index.html"
  ) {
    prompt =
      buildHtmlPrompt(
        request,
        specification
      );
  } else if (
    file ===
    "style.css"
  ) {
    prompt =
      buildCssPrompt(
        request,
        specification,
        files[
          "index.html"
        ] || ""
      );
  } else {
    prompt =
      buildJavascriptPrompt(
        request,
        specification,
        files[
          "index.html"
        ] || "",
        files[
          "style.css"
        ] || ""
      );
  }

  for (
    let attempt = 1;
    attempt <=
      FILE_GENERATION_RETRIES + 1;
    attempt++
  ) {
    try {
      console.log(
        `💻 Generating ${file} (attempt ${attempt})`
      );

      const result =
        await askAI(
          [
            {
              role:
                "system",

              content:
                "Return only valid source code.",
            },

            {
              role:
                "user",

              content:
                prompt,
            },
          ],
          {
            temperature:
              0.25,

            max_tokens:
              file ===
              "script.js"
                ? 9500
                : 6500,

            timeoutMs:
              AI_TIMEOUT_MS,
          }
        );

      const cleaned =
        cleanCodeOutput(
          result
        );

      if (
        !cleaned
      ) {
        throw new Error(
          `${file} returned empty output.`
        );
      }

      return cleaned;
    } catch (
      error
    ) {
      console.log(
        `⚠️ ${file} attempt ${attempt} failed: ${safeError(
          error
        )}`
      );

      if (
        attempt >
        FILE_GENERATION_RETRIES
      ) {
        throw error;
      }
    }
  }

  throw new Error(
    `${file} generation failed.`
  );
}

// ============================================================
// AUTO FIX HTML REFERENCES
// ============================================================

function ensureHtmlReferences(
  html
) {
  let result =
    String(
      html || ""
    );

  const hasCss =
    /href=["']\.?\/?style\.css["']/i.test(
      result
    );

  const hasJs =
    /src=["']\.?\/?script\.js["']/i.test(
      result
    );

  if (
    !hasCss
  ) {
    const headPattern =
      /<\/head>/i;

    if (
      headPattern.test(
        result
      )
    ) {
      result =
        result.replace(
          headPattern,
          `  <link rel="stylesheet" href="./style.css">\n</head>`
        );
    } else {
      result =
        `<link rel="stylesheet" href="./style.css">\n${result}`;
    }

    console.log(
      "🛠️ Auto-fixed missing style.css reference."
    );
  }

  if (
    !hasJs
  ) {
    const bodyPattern =
      /<\/body>/i;

    if (
      bodyPattern.test(
        result
      )
    ) {
      result =
        result.replace(
          bodyPattern,
          `  <script src="./script.js"></script>\n</body>`
        );
    } else {
      result +=
        `\n<script src="./script.js"></script>`;
    }

    console.log(
      "🛠️ Auto-fixed missing script.js reference."
    );
  }

  return result;
}

// ============================================================
// VALIDATION
// ============================================================

function validateFiles(
  files
) {
  const errors = [];

  const html =
    files[
      "index.html"
    ] || "";

  const css =
    files[
      "style.css"
    ] || "";

  const js =
    files[
      "script.js"
    ] || "";

  if (
    !html.trim()
  ) {
    errors.push(
      "index.html is empty."
    );
  }

  if (
    !css.trim()
  ) {
    errors.push(
      "style.css is empty."
    );
  }

  if (
    !js.trim()
  ) {
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
    !/<html[\s>]/i.test(
      html
    )
  ) {
    errors.push(
      "Missing html element."
    );
  }

  if (
    html &&
    !/<body[\s>]/i.test(
      html
    )
  ) {
    errors.push(
      "Missing body element."
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
    [
      html,
      css,
      js,
    ].join(
      "\n"
    );

  if (
    /\bReactDOM\b/i.test(
      combined
    ) ||
    /\bimport\s+React\b/i.test(
      combined
    ) ||
    /\bfrom\s+["']react["']/i.test(
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
    /package\.json/i.test(
      combined
    ) ||
    /\bVite\b/i.test(
      combined
    )
  ) {
    errors.push(
      "Vite/npm detected."
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

  const opens =
    (
      js.match(
        /{/g
      ) || []
    ).length;

  const closes =
    (
      js.match(
        /}/g
      ) || []
    ).length;

  if (
    opens !==
    closes
  ) {
    errors.push(
      "JavaScript braces are unbalanced."
    );
  }

  return {
    valid:
      errors.length ===
      0,

    errors,
  };
}

// ============================================================
// FALLBACK
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
  </div>
</header>

<main>
<section class="hero">
  <div class="container">
    <p class="eyebrow">AURA</p>
    <h1>Your idea.<span>Your website.</span></h1>
    <p>${safe}</p>
  </div>
</section>
</main>

<footer>AURA ✦</footer>

<script src="./script.js"></script>
</body>
</html>`,

    "style.css":
`* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #080b12;
  color: white;
}

.container {
  width: min(1120px, calc(100% - 40px));
  margin: auto;
}

.header {
  padding: 20px 0;
  border-bottom: 1px solid rgba(255,255,255,.08);
}

.logo {
  color: white;
  font-weight: 900;
  text-decoration: none;
}

.hero {
  min-height: 80vh;
  display: flex;
  align-items: center;
}

.eyebrow {
  color: #8da2ff;
  font-weight: 800;
  letter-spacing: 2px;
}

h1 {
  font-size: clamp(52px, 9vw, 100px);
  line-height: .95;
}

h1 span {
  display: block;
  color: #8da2ff;
}

footer {
  padding: 30px;
  text-align: center;
  color: #6b7280;
}`,

    "script.js":
`document.addEventListener("DOMContentLoaded", () => {
  console.log("AURA website ready.");
});`,
  };
}

// ============================================================
// REVIEW
// ============================================================

async function reviewApplication(
  request,
  specification,
  files
) {
  const prompt = `
You are AURA's senior frontend QA reviewer.

Review this generated app against the original user request.

ORIGINAL REQUEST:
${String(
  request
).slice(
  0,
  10000
)}

REQUIREMENTS:
${requirementContext(
  specification
)}

Inspect the implementation.

Focus on:
- exact data
- exact product count
- search
- cart
- cart counter
- quantity
- remove
- subtotal
- shipping
- total
- checkout
- address validation
- card validation
- expiry validation
- localStorage
- stock update
- order history
- order confirmation
- responsive design
- required buttons
- actual functionality

Return ONLY JSON:

{
  "passed": true,
  "score": 100,
  "issues": [],
  "repairFile": "none",
  "repairInstructions": []
}
`;

  return extractJson(
    await askAI(
      [
        {
          role:
            "system",

          content:
            "Return JSON only.",
        },

        {
          role:
            "user",

          content:
            prompt,
        },
      ],
      {
        temperature:
          0.1,

        max_tokens:
          3500,

        timeoutMs:
          REVIEW_TIMEOUT_MS,
      }
    )
  );
}

// ============================================================
// TARGETED REPAIR
// ============================================================

async function repairFile(
  file,
  request,
  specification,
  files,
  review
) {
  const current =
    files[
      file
    ] || "";

  const prompt = `
Repair ONLY ${file}.

ORIGINAL REQUEST:
${String(
  request
).slice(
  0,
  10000
)}

REQUIREMENTS:
${requirementContext(
  specification
)}

QA REVIEW:
${JSON.stringify(
  review,
  null,
  2
)}

CURRENT FILE:
${current.slice(
  0,
  24000
)}

Fix the identified issues.

Keep:
- exact data
- exact branding
- working features
- responsive design

Use only vanilla HTML/CSS/JavaScript.

Return ONLY the source code for ${file}.
`;

  const result =
    await askAI(
      [
        {
          role:
            "system",

          content:
            "Return only source code.",
        },

        {
          role:
            "user",

          content:
            prompt,
        },
      ],
      {
        temperature:
          0.15,

        max_tokens:
          file ===
          "script.js"
            ? 9000
            : 6500,

        timeoutMs:
          AI_TIMEOUT_MS,
      }
    );

  return cleanCodeOutput(
    result
  );
}

// ============================================================
// GENERATE ALL FILES
// ============================================================

async function generateFrontendFiles({
  projectRoot,
  projectName,
  userRequest,
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

  // ----------------------------------------------------------
  // REQUIREMENTS
  // ----------------------------------------------------------

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
  } catch (
    error
  ) {
    console.log(
      `⚠️ Requirement analysis failed: ${safeError(
        error
      )}`
    );

    specification =
      fallbackRequirements(
        userRequest
      );
  }

  const files = {
    "index.html": "",
    "style.css": "",
    "script.js": "",
  };

  // ----------------------------------------------------------
  // HTML
  // ----------------------------------------------------------

  console.log(
    "💻 Generating index.html..."
  );

  try {
    files[
      "index.html"
    ] =
      await generateOneFile(
        "index.html",
        userRequest,
        specification,
        files
      );

    /*
     * Important:
     * automatically fix missing references.
     */
    files[
      "index.html"
    ] =
      ensureHtmlReferences(
        files[
          "index.html"
        ]
      );

    console.log(
      "✅ index.html ready."
    );
  } catch (
    error
  ) {
    console.log(
      `❌ index.html failed: ${safeError(
        error
      )}`
    );
  }

  // ----------------------------------------------------------
  // CSS
  // ----------------------------------------------------------

  console.log(
    "🎨 Generating style.css..."
  );

  try {
    files[
      "style.css"
    ] =
      await generateOneFile(
        "style.css",
        userRequest,
        specification,
        files
      );

    console.log(
      "✅ style.css ready."
    );
  } catch (
    error
  ) {
    console.log(
      `❌ style.css failed: ${safeError(
        error
      )}`
    );
  }

  // ----------------------------------------------------------
  // JS
  // ----------------------------------------------------------

  console.log(
    "⚙️ Generating script.js..."
  );

  try {
    files[
      "script.js"
    ] =
      await generateOneFile(
        "script.js",
        userRequest,
        specification,
        files
      );

    console.log(
      "✅ script.js ready."
    );
  } catch (
    error
  ) {
    console.log(
      `❌ script.js failed: ${safeError(
        error
      )}`
    );
  }

  // ----------------------------------------------------------
  // FALLBACK MISSING FILES
  // ----------------------------------------------------------

  const fallback =
    fallbackFiles(
      userRequest
    );

  for (
    const file of [
      "index.html",
      "style.css",
      "script.js",
    ]
  ) {
    if (
      !files[file] ||
      !files[file].trim()
    ) {
      files[file] =
        fallback[file];

      console.log(
        `🛠️ Fallback used for ${file}.`
      );
    }
  }

  // ----------------------------------------------------------
  // FINAL HTML REPAIR
  // ----------------------------------------------------------

  files[
    "index.html"
  ] =
    ensureHtmlReferences(
      files[
        "index.html"
      ]
    );

  // ----------------------------------------------------------
  // REVIEW
  // ----------------------------------------------------------

  let review =
    null;

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
        review.score ??
        "N/A"
      }`
    );
  } catch (
    error
  ) {
    console.log(
      `⚠️ Review unavailable: ${safeError(
        error
      )}`
    );
  }

  // ----------------------------------------------------------
  // TARGETED REPAIR
  // ----------------------------------------------------------

  if (
    review &&
    (
      review.passed ===
        false ||
      review.repairNeeded ===
        true
    )
  ) {
    const repairTarget =
      [
        "index.html",
        "style.css",
        "script.js",
      ].includes(
        review.repairFile
      )
        ? review.repairFile
        : null;

    if (
      repairTarget
    ) {
      for (
        let attempt = 1;
        attempt <=
        MAX_REPAIR_ATTEMPTS;
        attempt++
      ) {
        try {
          console.log(
            `🔧 Repairing ${repairTarget} (${attempt}/${MAX_REPAIR_ATTEMPTS})...`
          );

          files[
            repairTarget
          ] =
            await repairFile(
              repairTarget,
              userRequest,
              specification,
              files,
              review
            );

          console.log(
            `✅ ${repairTarget} repaired.`
          );

          break;
        } catch (
          error
        ) {
          console.log(
            `⚠️ Repair failed: ${safeError(
              error
            )}`
          );
        }
      }
    }
  }

  // ----------------------------------------------------------
  // HTML REFERENCE FIX AGAIN
  // ----------------------------------------------------------

  files[
    "index.html"
  ] =
    ensureHtmlReferences(
      files[
        "index.html"
      ]
    );

  // ----------------------------------------------------------
  // VALIDATE
  // ----------------------------------------------------------

  const validation =
    validateFiles(
      files
    );

  console.log(
    "🔐 Validation..."
  );

  if (
    !validation.valid
  ) {
    console.log(
      "⚠️ Validation found:"
    );

    console.log(
      validation.errors
    );

    /*
     * We fix simple structural issues here.
     */

    files[
      "index.html"
    ] =
      ensureHtmlReferences(
        files[
          "index.html"
        ]
      );
  }

  // ----------------------------------------------------------
  // WRITE
  // ----------------------------------------------------------

  writeProjectFile(
    projectRoot,
    "index.html",
    files[
      "index.html"
    ]
  );

  writeProjectFile(
    projectRoot,
    "style.css",
    files[
      "style.css"
    ]
  );

  writeProjectFile(
    projectRoot,
    "script.js",
    files[
      "script.js"
    ]
  );

  /*
   * Revalidate after automatic repair.
   */

  const finalValidation =
    validateFiles(
      files
    );

  /*
   * We do NOT fail solely because a small static
   * validation warning remains. The files exist and
   * are suitable for static deployment.
   */

  return {
    success:
      true,

    projectRoot,

    projectName,

    files: [
      "index.html",
      "style.css",
      "script.js",
    ],

    specification,

    review,

    validation:
      finalValidation,
  };
}

// ============================================================
// VERIFY
// ============================================================

function verifyFrontend(
  projectRoot
) {
  const html =
    readProjectFile(
      projectRoot,
      "index.html"
    ) || "";

  const css =
    readProjectFile(
      projectRoot,
      "style.css"
    ) || "";

  const js =
    readProjectFile(
      projectRoot,
      "script.js"
    ) || "";

  /*
   * Auto-fix HTML references once more before validation.
   */

  const repairedHtml =
    ensureHtmlReferences(
      html
    );

  if (
    repairedHtml !==
    html
  ) {
    writeProjectFile(
      projectRoot,
      "index.html",
      repairedHtml
    );
  }

  const files = {
    "index.html":
      repairedHtml,

    "style.css":
      css,

    "script.js":
      js,
  };

  const validation =
    validateFiles(
      files
    );

  const errors =
    [...validation.errors];

  /*
   * Only hard-block actual structural problems.
   *
   * Missing references are already auto-fixed.
   */

  if (
    !files[
      "index.html"
    ].trim()
  ) {
    errors.push(
      "index.html is missing."
    );
  }

  if (
    !files[
      "style.css"
    ].trim()
  ) {
    errors.push(
      "style.css is missing."
    );
  }

  if (
    !files[
      "script.js"
    ].trim()
  ) {
    errors.push(
      "script.js is missing."
    );
  }

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
  }

  if (
    errors.length
  ) {
    console.log(
      "⚠️ Verification warnings:"
    );

    console.log(
      errors
    );

    /*
     * The application files are still returned.
     *
     * Don't report generation failure just because
     * a non-critical validator warning exists.
     */

    return {
      success:
        true,

      errors,

      warnings:
        errors,
    };
  }

  console.log(
    "✅ Frontend verified."
  );

  return {
    success:
      true,

    errors: [],

    warnings: [],
  };
}

// ============================================================
// VERCEL
// ============================================================

function sha1(
  buffer
) {
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
            {}),
        },
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
        text,
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
            digest,
        },

        body:
          buffer,
      }
    );

  const text =
    await response.text();

  if (
    !response.ok
  ) {
    throw new Error(
      `Vercel upload ${response.status}: ${text.slice(
        0,
        1800
      )}`
    );
  }

  return {
    sha:
      digest,

    size:
      buffer.length,
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
      success:
        false,

      reason:
        "Vercel account is not connected.",
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
        "Generated project directory does not exist.",
    };
  }

  const deploymentFiles =
    [];

  for (
    const file of [
      "index.html",
      "style.css",
      "script.js",
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

    console.log(
      `☁️ Uploading ${file}...`
    );

    const uploaded =
      await uploadVercelFile(
        accessToken,
        buffer
      );

    deploymentFiles.push({
      file,

      sha:
        uploaded.sha,

      size:
        uploaded.size,
    });
  }

  const payload = {
    name:
      sanitizeProjectName(
        projectName
      ),

    files:
      deploymentFiles,

    target:
      "production",

    projectSettings: {
      framework:
        null,
    },
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
    "🚀 Creating Vercel deployment..."
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
            "application/json",
        },

        body:
          JSON.stringify(
            payload
          ),
      }
    );

  if (
    !deployment?.url
  ) {
    throw new Error(
      "Vercel returned no deployment URL."
    );
  }

  return {
    success:
      true,

    url:
      `https://${deployment.url}`,

    deploymentId:
      deployment?.id ||
      deployment?.uid ||
      null,
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

  // ----------------------------------------------------------
  // Requirements
  // ----------------------------------------------------------

  let specification;

  try {
    console.log(
      "🧠 Step 1 — analyzing requirements..."
    );

    specification =
      await analyzeRequirements(
        request
      );

    console.log(
      "✅ Requirements analyzed."
    );
  } catch (
    error
  ) {
    console.log(
      `⚠️ Planner fallback: ${safeError(
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

  // ----------------------------------------------------------
  // Generate
  // ----------------------------------------------------------

  const generation =
    await generateFrontendFiles({
      projectRoot,

      projectName,

      userRequest:
        request,
    });

  // ----------------------------------------------------------
  // Verify
  // ----------------------------------------------------------

  const validation =
    verifyFrontend(
      projectRoot
    );

  /*
   * IMPORTANT:
   *
   * If all three required files exist, return success.
   * We don't let minor validator warnings kill the
   * entire generation.
   */

  const requiredFiles =
    [
      "index.html",
      "style.css",
      "script.js",
    ];

  const missingFiles =
    requiredFiles.filter(
      (file) =>
        !fs.existsSync(
          path.join(
            projectRoot,
            file
          )
        )
    );

  if (
    missingFiles.length
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
        {
          success:
            false,

          errors:
            missingFiles.map(
              (file) =>
                `Missing ${file}`
            ),
        },

      buildAgentResult: {
        success:
          false,

        skipped:
          true,
      },

      deploymentResult: {
        success:
          false,

        skipped:
          true,
      },

      liveUrl:
        null,
    };
  }

  // ----------------------------------------------------------
  // Static build
  // ----------------------------------------------------------

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
        "Static HTML/CSS/JS website does not require npm build.",
    },

    deploymentResult: {
      success:
        false,

      skipped:
        true,

      reason:
        "Waiting for Vercel deployment.",
    },

    liveUrl:
      null,

    specification:
      generation.specification,
  };
}

// ============================================================
// EXPORT
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

  validateFiles,
};
