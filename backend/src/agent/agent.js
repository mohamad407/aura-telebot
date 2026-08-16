"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// ============================================================
// AURA AI APPLICATION AGENT
// ============================================================
//
// Architecture:
//
// USER REQUEST
//      ↓
// REQUIREMENT ANALYSIS
//      ↓
// WHOLE APP GENERATION
//      ↓
// HTML + CSS + JAVASCRIPT
//      ↓
// REQUIREMENT REVIEW
//      ↓
// AUTOMATIC REPAIR
//      ↓
// STATIC VALIDATION
//      ↓
// READY FOR VERCEL
//
// Generated apps do NOT use:
// - React
// - JSX
// - Vite
// - npm
// - package.json
// - backend
//
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
// LOGGING
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
    /gsk_[A-Za-z0-9_-]+/gi,
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
    getProjectRoot(
      projectName
    );

  fs.mkdirSync(
    projectRoot,
    {
      recursive: true,
    }
  );

  return projectRoot;
}

// ============================================================
// FILE SECURITY
// ============================================================

function normalizeFilePath(filePath) {
  let value =
    String(filePath || "")
      .replace(/\\/g, "/")
      .trim()
      .toLowerCase();

  value =
    value.replace(
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

  if (
    !fs.statSync(
      fullPath
    ).isFile()
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
        "node_modules"
      ) {
        continue;
      }

      if (
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

  walk(
    projectRoot
  );

  return files;
}

// ============================================================
// AI HTTP
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
      () =>
        controller.abort(),
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
        method: "POST",
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
              12000,
          }),
      }
    );

  const text =
    await response.text();

  if (
    !response.ok
  ) {
    if (
      response.status ===
      429
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

  const data =
    JSON.parse(text);

  const content =
    data?.choices?.[0]
      ?.message
      ?.content;

  if (
    !content
  ) {
    throw new Error(
      "Groq returned empty content."
    );
  }

  return content;
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
              12000,
          }),
      }
    );

  const text =
    await response.text();

  if (
    !response.ok
  ) {
    if (
      response.status ===
      429
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

  const data =
    JSON.parse(text);

  const content =
    data?.choices?.[0]
      ?.message
      ?.content;

  if (
    !content
  ) {
    throw new Error(
      "OpenRouter returned empty content."
    );
  }

  return content;
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

  if (
    !providers.length
  ) {
    throw new Error(
      "No AI provider available."
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
        `✅ ${provider.name} success`
      );

      return result;
    } catch (
      error
    ) {
      lastError =
        error;

      console.log(
        `⚠️ ${provider.name} failed`
      );

      console.log(
        safeError(
          error
        )
      );
    }
  }

  throw new Error(
    `All AI providers failed. ${
      lastError
        ? safeError(
            lastError
          )
        : ""
    }`
  );
}

// ============================================================
// JSON CLEANER
// ============================================================

function extractJson(
  content
) {
  let text =
    String(
      content || ""
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

  const start =
    text.indexOf(
      "{"
    );

  const end =
    text.lastIndexOf(
      "}"
    );

  if (
    start === -1 ||
    end === -1 ||
    end <= start
  ) {
    throw new Error(
      "No JSON object found in AI response."
    );
  }

  return JSON.parse(
    text.slice(
      start,
      end + 1
    )
  );
}

// ============================================================
// PROJECT NAME
// ============================================================

function deriveProjectName(
  userRequest
) {
  const text =
    String(
      userRequest || ""
    )
      .toLowerCase();

  if (
    text.includes(
      "portfolio"
    )
  ) {
    return "aura-portfolio";
  }

  if (
    text.includes(
      "amazon"
    )
  ) {
    return "amazon-clone";
  }

  if (
    text.includes(
      "sneaker"
    )
  ) {
    return "sneaker-store";
  }

  if (
    text.includes(
      "ecommerce"
    ) ||
    text.includes(
      "e-commerce"
    ) ||
    text.includes(
      "shop"
    ) ||
    text.includes(
      "store"
    )
  ) {
    return "aura-store";
  }

  return "aura-website";
}

// ============================================================
// REQUIREMENT ANALYSIS
// ============================================================

async function analyzeRequirements(
  userRequest
) {
  const prompt = `
You are AURA's senior product requirements analyst.

Analyze the user's website request and convert it into a
structured implementation specification.

USER REQUEST:
${String(
  userRequest
).slice(
  0,
  14000
)}

IMPORTANT:

Do not invent a different application.

Preserve:
- exact branding
- exact product names
- exact prices
- exact quantities
- exact categories
- requested features
- persistence requirements
- requested UI behavior

Extract all explicit requirements.

Return ONLY JSON:

{
  "projectName": "short-kebab-case",
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
  "deploymentRequirements": []
}

If the user explicitly says EXACTLY 3 products,
do not change that to 10 or 12.

If the user says frontend-only,
do not create a backend.

If the user chooses vanilla HTML/CSS/JS,
do not introduce React or Vite.
`;

  const response =
    await askAI(
      [
        {
          role:
            "system",
          content:
            "You are a senior product requirements analyst. Return valid JSON only.",
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
          5000,
      }
    );

  return extractJson(
    response
  );
}

// ============================================================
// FALLBACK REQUIREMENTS
// ============================================================

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
        ),
    },

    pages: [
      "Home",
    ],

    features: [
      "Responsive navigation",
      "Hero section",
      "Main content",
      "Interactive controls",
      "Footer",
    ],

    data: [],

    persistence: [
      "Use localStorage when persistence is requested.",
    ],

    uiRequirements: [
      "Modern",
      "Clean",
      "Responsive",
      "Mobile friendly",
    ],

    validationRequirements: [
      "No broken required features.",
    ],

    deploymentRequirements: [
      "Static website",
    ],
  };
}

// ============================================================
// WHOLE APPLICATION GENERATION
// ============================================================

async function generateCompleteApplication(
  userRequest,
  specification,
  projectName
) {
  const prompt = `
You are AURA's senior frontend engineer.

You are NOT generating one isolated file.

You are implementing ONE COMPLETE APPLICATION.

USER REQUEST:
${String(
  userRequest
).slice(
  0,
  16000
)}

STRUCTURED REQUIREMENTS:
${JSON.stringify(
  specification,
  null,
  2
)}

PROJECT:
${projectName}

============================================================
MANDATORY IMPLEMENTATION RULES
============================================================

1. Generate a COMPLETE working frontend.

2. Use ONLY:
   - HTML
   - CSS
   - Vanilla JavaScript

3. Do NOT use:
   - React
   - JSX
   - Next.js
   - Vite
   - npm
   - package.json
   - Node backend
   - Express
   - TypeScript

4. Return EXACTLY these three files:
   - index.html
   - style.css
   - script.js

5. The three files are one application.
   They must work together.

6. ALL explicit user requirements must be implemented.

7. DO NOT simplify requirements.

8. DO NOT replace exact data with generic data.

9. DO NOT add random extra products when the user specified
   an exact product count.

10. If localStorage is requested, implement it properly.

11. All buttons advertised by the UI must work.

12. Search/filter controls must actually modify visible data.

13. Cart controls must actually update totals.

14. Checkout validation must actually prevent invalid submission.

15. State that must survive reloads must be saved to localStorage.

16. Use browser APIs only.

17. If Lucide icons are requested, use Lucide through a CDN
    and initialize the icons correctly.

18. Use polished responsive design.

19. Avoid placeholder-looking layouts.

20. Make the page look like a real production website.

21. Use semantic HTML.

22. Support desktop, tablet and mobile.

23. Use realistic visual hierarchy.

24. Use hover/focus/active states.

25. Avoid excessive gradients unless appropriate.

26. Avoid giant empty spaces.

27. Do not write comments containing AI safety metadata.

28. Never output text such as:
    "User Safety: safe"
    "Safety: safe"
    "As an AI"
    "Generated response"

29. NEVER return markdown fences.

30. Return ONLY valid JSON.

============================================================
OUTPUT FORMAT
============================================================

{
  "index.html": "...complete file...",
  "style.css": "...complete file...",
  "script.js": "...complete file..."
}

============================================================
QUALITY BAR
============================================================

The finished result should feel like it was made by a senior
frontend engineer, not a simple demo.

Think through the complete user journey before writing the files.

If the application has multiple states/views, implement them
inside the single-page application using DOM state and JavaScript.

If the application has:
- login
- search
- cart
- checkout
- payment
- orders
- admin
- filtering
- sorting
- persistence

then implement those features, not just visual buttons.

============================================================
FINAL SELF-CHECK BEFORE RETURNING
============================================================

Verify mentally:

- All explicit requirements implemented
- Exact data preserved
- No missing interactions
- No broken selectors
- No undefined functions
- No missing CSS classes
- No missing IDs
- No incorrect localStorage keys
- No React/Vite code
- No npm dependency
- index.html references ./style.css
- index.html references ./script.js
- script.js works in browser
- JavaScript is syntactically valid
- CSS is syntactically valid
`;

  const response =
    await askAI(
      [
        {
          role:
            "system",

          content:
            "You are an expert senior frontend engineer. Return valid JSON only.",
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
          0.3,

        max_tokens:
          30000,
      }
    );

  const data =
    extractJson(
      response
    );

  if (
    typeof data?.["index.html"] !==
      "string" ||
    typeof data?.["style.css"] !==
      "string" ||
    typeof data?.["script.js"] !==
      "string"
  ) {
    throw new Error(
      "AI did not return all required application files."
    );
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
      ],
  };
}

// ============================================================
// STATIC SYNTAX / STRUCTURE CHECK
// ============================================================

function validateStaticFiles(
  files
) {
  const errors = [];

  if (
    typeof files?.[
      "index.html"
    ] !== "string" ||
    !files[
      "index.html"
    ].trim()
  ) {
    errors.push(
      "index.html is missing or empty."
    );
  }

  if (
    typeof files?.[
      "style.css"
    ] !== "string" ||
    !files[
      "style.css"
    ].trim()
  ) {
    errors.push(
      "style.css is missing or empty."
    );
  }

  if (
    typeof files?.[
      "script.js"
    ] !== "string" ||
    !files[
      "script.js"
    ].trim()
  ) {
    errors.push(
      "script.js is missing or empty."
    );
  }

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

  if (
    html &&
    !/<!doctype html>/i.test(
      html
    )
  ) {
    errors.push(
      "index.html is missing <!DOCTYPE html>."
    );
  }

  if (
    html &&
    !/<html[\s>]/i.test(
      html
    )
  ) {
    errors.push(
      "index.html is missing <html>."
    );
  }

  if (
    html &&
    !/<body[\s>]/i.test(
      html
    )
  ) {
    errors.push(
      "index.html is missing <body>."
    );
  }

  if (
    html &&
    !/href=["'][^"']*style\.css["']/i.test(
      html
    )
  ) {
    errors.push(
      "index.html does not reference style.css correctly."
    );
  }

  if (
    html &&
    !/src=["'][^"']*script\.js["']/i.test(
      html
    )
  ) {
    errors.push(
      "index.html does not reference script.js correctly."
    );
  }

  const combined =
    html +
    "\n" +
    css +
    "\n" +
    js;

  if (
    /\bfrom\s*["']react["']/i.test(
      combined
    ) ||
    /\bimport\s+React/i.test(
      combined
    ) ||
    /\bReactDOM\b/i.test(
      combined
    ) ||
    /\.jsx\b/i.test(
      combined
    )
  ) {
    errors.push(
      "React/JSX code detected."
    );
  }

  if (
    /\bpackage\.json\b/i.test(
      combined
    )
  ) {
    errors.push(
      "package.json content detected."
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
      "AI metadata detected inside application."
    );
  }

  return {
    valid:
      errors.length === 0,

    errors,
  };
}

// ============================================================
// FALLBACK APPLICATION
// ============================================================

function fallbackFiles(
  userRequest
) {
  const title =
    "AURA Website";

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

  <title>${title}</title>

  <link
    rel="stylesheet"
    href="./style.css"
  >
</head>

<body>

  <header class="header">
    <div class="container nav">
      <a href="#" class="logo">
        AURA
      </a>

      <nav class="nav-links">
        <a href="#home">Home</a>
        <a href="#features">Features</a>
        <a href="#contact">Contact</a>
      </nav>

      <button
        id="menuButton"
        class="icon-button"
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

        <div class="hero-copy">

          <span class="eyebrow">
            CREATED WITH AURA
          </span>

          <h1>
            Your idea.
            <span>Your website.</span>
          </h1>

          <p>
            ${escapeHtml(
              userRequest
            )}
          </p>

          <a
            href="#features"
            class="primary-button"
          >
            Explore
          </a>

        </div>

      </div>
    </section>

    <section
      id="features"
      class="section"
    >
      <div class="container">

        <div class="section-heading">
          <span class="eyebrow">
            FEATURES
          </span>

          <h2>
            Simple. Modern. Functional.
          </h2>
        </div>

        <div class="cards">

          <article class="card">
            <div class="card-number">
              01
            </div>
            <h3>
              Modern Design
            </h3>
            <p>
              Clean responsive interface.
            </p>
          </article>

          <article class="card">
            <div class="card-number">
              02
            </div>
            <h3>
              Fast
            </h3>
            <p>
              Lightweight browser-first experience.
            </p>
          </article>

          <article class="card">
            <div class="card-number">
              03
            </div>
            <h3>
              Ready
            </h3>
            <p>
              Built for simple deployment.
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
        <span class="eyebrow">
          CONTACT
        </span>

        <h2>
          Let's build something.
        </h2>

        <button
          id="contactButton"
          type="button"
          class="primary-button"
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
  color: #f8fafc;
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

  margin: 0 auto;
}

.header {
  position: sticky;
  top: 0;
  z-index: 50;

  background:
    rgba(
      7,
      11,
      18,
      0.82
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

  display: flex;
  align-items: center;
  justify-content: space-between;
}

.logo {
  font-weight: 900;
  letter-spacing: 2px;
}

.nav-links {
  display: flex;
  gap: 24px;
}

.nav-links a {
  color: #aeb7c8;
}

.icon-button {
  display: none;

  border: 0;

  background:
    transparent;

  color: white;

  cursor: pointer;
}

.hero {
  min-height: 82vh;

  display: flex;
  align-items: center;

  background:
    radial-gradient(
      circle at 50% 0%,
      rgba(
        99,
        102,
        241,
        0.25
      ),
      transparent 46%
    );
}

.hero-inner {
  padding: 100px 0;
}

.eyebrow {
  color: #8da2ff;

  font-size: 12px;

  font-weight: 800;

  letter-spacing: 2px;
}

h1 {
  max-width: 900px;

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
  display: block;

  color: #8da2ff;
}

.hero p {
  max-width: 680px;

  color: #aeb7c8;

  font-size: 19px;

  line-height: 1.7;
}

.primary-button {
  display: inline-flex;

  align-items: center;
  justify-content: center;

  min-height: 48px;

  padding:
    0 20px;

  margin-top: 25px;

  border: 0;

  border-radius: 12px;

  background: white;

  color: #070b12;

  font-weight: 800;

  cursor: pointer;
}

.section {
  padding: 100px 0;

  border-top:
    1px solid
    rgba(
      255,
      255,
      255,
      0.07
    );
}

.section-heading h2,
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
  margin-top: 50px;

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

  gap: 20px;
}

.card {
  padding: 30px;

  min-height: 210px;

  border:
    1px solid
    rgba(
      255,
      255,
      255,
      0.08
    );

  border-radius: 22px;

  background:
    rgba(
      255,
      255,
      255,
      0.035
    );
}

.card-number {
  color: #8da2ff;

  font-weight: 900;

  margin-bottom:
    35px;
}

.card h3 {
  font-size: 24px;
}

.card p {
  color: #aeb7c8;
}

.contact {
  text-align: center;
}

footer {
  padding: 30px 0;

  text-align: center;

  color: #697386;

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
    display: none;
  }

  .icon-button {
    display: block;
  }

  .cards {
    grid-template-columns: 1fr;
  }

  .hero-inner {
    padding:
      80px 0;
  }
}`;

  const scriptJs =
`document.addEventListener(
  "DOMContentLoaded",
  () => {
    const button =
      document.getElementById(
        "contactButton"
      );

    if (button) {
      button.addEventListener(
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
          document
            .querySelector(
              ".nav-links"
            )
            ?.classList.toggle(
              "open"
            );
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
      scriptJs,
  };
}

// ============================================================
// REVIEW PROMPT
// ============================================================

async function reviewApplication(
  userRequest,
  specification,
  files
) {
  const prompt = `
You are AURA's senior QA engineer and frontend reviewer.

Review the COMPLETE generated website against the original
requirements.

ORIGINAL USER REQUEST:
${String(
  userRequest
).slice(
  0,
  15000
)}

STRUCTURED REQUIREMENTS:
${JSON.stringify(
  specification,
  null,
  2
)}

GENERATED INDEX.HTML:
${files["index.html"]}

GENERATED STYLE.CSS:
${files["style.css"]}

GENERATED SCRIPT.JS:
${files["script.js"]}

Return ONLY JSON:

{
  "passed": true,
  "score": 0,
  "missingRequirements": [],
  "brokenFeatures": [],
  "designProblems": [],
  "repairNeeded": false,
  "repairInstructions": []
}

Review carefully:

- exact user requirements
- exact data
- number of products
- product prices
- product names
- search behavior
- cart behavior
- quantity controls
- subtotal
- shipping
- grand total
- checkout
- payment validation
- localStorage persistence
- order history
- stock changes
- buttons actually working
- responsive layout
- navigation
- accessibility
- no React
- no Vite
- no npm
- no broken references

Do NOT penalize the app for implementing extra useful functionality
unless it conflicts with explicit requirements.

Do NOT invent requirements.
`;

  const response =
    await askAI(
      [
        {
          role:
            "system",

          content:
            "You are a strict senior frontend QA reviewer. Return valid JSON only.",
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
          8000,
      }
    );

  return extractJson(
    response
  );
}

// ============================================================
// REPAIR PROMPT
// ============================================================

async function repairApplication(
  userRequest,
  specification,
  files,
  review
) {
  const prompt = `
You are AURA's senior frontend engineer.

The application below was reviewed and has issues.

USER REQUEST:
${String(
  userRequest
).slice(
  0,
  15000
)}

STRUCTURED REQUIREMENTS:
${JSON.stringify(
  specification,
  null,
  2
)}

REVIEW:
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

REPAIR ALL identified requirements and functionality.

IMPORTANT:

- Keep exact user data.
- Keep exact branding.
- Don't remove working functionality.
- Don't downgrade design.
- Don't replace real features with placeholders.
- Ensure all buttons work.
- Ensure all localStorage logic works.
- Ensure all JavaScript references valid elements.
- Ensure the three files remain compatible.
- No React.
- No JSX.
- No Vite.
- No npm.
- No package.json.
- No backend.
- No markdown fences.
- No AI metadata.

Return ONLY:

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
            "You are a senior frontend repair engineer. Return valid JSON only.",
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
          0.2,

        max_tokens:
          30000,
      }
    );

  const repaired =
    extractJson(
      response
    );

  if (
    typeof repaired?.[
      "index.html"
    ] !==
      "string" ||
    typeof repaired?.[
      "style.css"
    ] !==
      "string" ||
    typeof repaired?.[
      "script.js"
    ] !==
      "string"
  ) {
    throw new Error(
      "AI repair did not return all files."
    );
  }

  return {
    "index.html":
      repaired[
        "index.html"
      ],

    "style.css":
      repaired[
        "style.css"
      ],

    "script.js":
      repaired[
        "script.js"
      ],
  };
}

// ============================================================
// SAFE APPLICATION VALIDATION
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

  /*
   * Basic JavaScript balance checks.
   *
   * This is not a full JS parser, but catches
   * common broken output.
   */

  const openBraces =
    (
      js.match(
        /{/g
      ) || []
    ).length;

  const closeBraces =
    (
      js.match(
        /}/g
      ) || []
    ).length;

  if (
    openBraces !==
    closeBraces
  ) {
    errors.push(
      "JavaScript braces are unbalanced."
    );
  }

  const openParens =
    (
      js.match(
        /\(/g
      ) || []
    ).length;

  const closeParens =
    (
      js.match(
        /\)/g
      ) || []
    ).length;

  if (
    openParens !==
    closeParens
  ) {
    errors.push(
      "JavaScript parentheses are unbalanced."
    );
  }

  if (
    html.includes(
      'src="./App.js"'
    ) ||
    html.includes(
      'src="./main.js"'
    )
  ) {
    errors.push(
      "Unexpected JS filename reference."
    );
  }

  return {
    success:
      errors.length === 0,

    errors,
  };
}

// ============================================================
// WRITE APPLICATION
// ============================================================

function writeApplication(
  projectRoot,
  files
) {
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
}

// ============================================================
// GENERATE COMPLETE SITE
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
      "⚠️ Requirement analysis failed."
    );

    console.log(
      safeError(
        error
      )
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
      safeError(
        error
      )
    );

    console.log(
      "🛠️ Using fallback application."
    );

    files =
      fallbackFiles(
        userRequest
      );
  }

  /*
   * ---------------------------------------------------------
   * REVIEW + REPAIR LOOP
   * ---------------------------------------------------------
   */

  for (
    let attempt = 0;
    attempt <= MAX_REVIEW_REPAIRS;
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
        "⚠️ Static validation problems:"
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
        `📊 Review score: ${review.score || "N/A"}`
      );

      const passed =
        review.passed === true &&
        review.repairNeeded !== true &&
        staticValidation.success;

      if (
        passed
      ) {
        console.log(
          "✅ Application review passed."
        );

        break;
      }

      if (
        attempt >=
        MAX_REVIEW_REPAIRS
      ) {
        console.log(
          "⚠️ Maximum repair attempts reached."
        );

        break;
      }

      console.log(
        "🔧 Repairing application..."
      );

      try {
        files =
          await repairApplication(
            userRequest,
            specification,
            files,
            review
          );

        console.log(
          "✅ Application repaired."
        );
      } catch (
        repairError
      ) {
        console.log(
          "⚠️ Repair failed."
        );

        console.log(
          safeError(
            repairError
          )
        );

        break;
      }
    } catch (
      reviewError
    ) {
      console.log(
        "⚠️ Review unavailable."
      );

      console.log(
        safeError(
          reviewError
        )
      );

      /*
       * We don't destroy an otherwise valid app
       * just because the reviewer hit a rate limit.
       */

      if (
        staticValidation.success
      ) {
        break;
      }
    }
  }

  /*
   * Final static validation.
   */

  const finalValidation =
    validateApplication(
      files
    );

  if (
    !finalValidation.success
  ) {
    console.log(
      "⚠️ Final static validation failed."
    );

    console.log(
      finalValidation.errors
    );

    console.log(
      "🛠️ Using safe fallback."
    );

    files =
      fallbackFiles(
        userRequest
      );
  }

  writeApplication(
    projectRoot,
    files
  );

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
  };
}

// ============================================================
// VERIFY
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

  const requiredFiles =
    [
      "index.html",
      "style.css",
      "script.js",
    ];

  const errors = [];

  for (
    const file of
      requiredFiles
  ) {
    const content =
      readProjectFile(
        projectRoot,
        file
      );

    if (
      !content ||
      !content.trim()
    ) {
      errors.push(
        `Missing or empty ${file}`
      );
    }
  }

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
      ) || "",
  };

  const validation =
    validateApplication(
      files
    );

  errors.push(
    ...validation.errors
  );

  /*
   * Forbid unwanted generated framework files.
   */

  const allFiles =
    listProjectFiles(
      projectRoot
    );

  for (
    const file of allFiles
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

  if (
    errors.length
  ) {
    console.log(
      "❌ Verification failed."
    );

    return {
      success:
        false,

      errors,
      warnings: [],
    };
  }

  console.log(
    "✅ Static website verified."
  );

  return {
    success:
      true,

    errors: [],

    warnings: [],
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
      raw: text,
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
      buffer.length,
  };
}

// ============================================================
// VERCEL DEPLOY
// ============================================================

async function deployToVercel(
  projectRoot,
  projectName,
  accessToken,
  teamId = null
) {
  if (
    !accessToken
  ) {
    return {
      success:
        false,

      reason:
        "Vercel account is not connected.",
    };
  }

  const safeProjectName =
    sanitizeProjectName(
      projectName
    );

  const required =
    [
      "index.html",
      "style.css",
      "script.js",
    ];

  const deploymentFiles =
    [];

  for (
    const file of
      required
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
      safeProjectName,

    files:
      deploymentFiles,

    target:
      "production",

    projectSettings: {
      framework:
        null,
    },
  };

  let url =
    "https://api.vercel.com/v13/deployments";

  if (
    teamId
  ) {
    url +=
      `?teamId=${encodeURIComponent(
        teamId
      )}`;
  }

  console.log(
    "🚀 Creating Vercel deployment..."
  );

  const deployment =
    await vercelRequest(
      url,
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

  const deploymentUrl =
    deployment?.url
      ? `https://${deployment.url}`
      : null;

  if (
    !deploymentUrl
  ) {
    throw new Error(
      "Vercel returned no deployment URL."
    );
  }

  console.log(
    `🌐 ${deploymentUrl}`
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
      "BUILDING",
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
  // REQUIREMENTS
  // ----------------------------------------------------------

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
      "⚠️ Planner fallback:"
    );

    console.log(
      safeError(
        error
      )
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
    `📍 Root: ${projectRoot}`
  );

  // ----------------------------------------------------------
  // COMPLETE GENERATION
  // ----------------------------------------------------------

  const generation =
    await generateFrontendFiles({
      projectRoot,
      projectName,
      userRequest:
        request,
    });

  // ----------------------------------------------------------
  // FINAL VERIFY
  // ----------------------------------------------------------

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

  const buildResult = {
    success:
      true,

    skipped:
      true,

    reason:
      "Static HTML/CSS/JS application requires no npm build.",
  };

  return {
    success:
      true,

    projectName,

    projectRoot,

    /*
     * Keep both names for compatibility with
     * older server.js versions.
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
        "Waiting for Vercel deployment.",
    },

    liveUrl:
      null,

    repairAttempts:
      MAX_REVIEW_REPAIRS,

    specification:
      generation.specification,
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
};
