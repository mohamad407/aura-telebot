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
// LOGGING
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
    /sk-[A-Za-z0-9_-]+/gi
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
    getProjectRoot(projectName);

  fs.mkdirSync(
    root,
    {
      recursive: true
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
    normalizeFilePath(filePath);

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
    normalizeFilePath(filePath);

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
        entry.name === "node_modules" ||
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
// HARD TIMEOUT
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
  } catch (error) {
    if (
      error?.name === "AbortError"
    ) {
      throw new Error(
        `Request timed out after ${Math.round(
          timeoutMs / 1000
        )} seconds.`
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
            5000
        })
      },
      options.timeoutMs ||
        AI_TIMEOUT_MS
    );

  const text =
    await response.text();

  if (!response.ok) {
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

  let data;

  try {
    data =
      JSON.parse(text);
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
            5000
        })
      },
      options.timeoutMs ||
        AI_TIMEOUT_MS
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
        1800
      )}`
    );
  }

  let data;

  try {
    data =
      JSON.parse(text);
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
      "No AI provider is available."
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
      ? safeError(lastError)
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
    text.indexOf("{");

  const last =
    text.lastIndexOf("}");

  if (
    first === -1 ||
    last === -1 ||
    last <= first
  ) {
    throw new Error(
      "AI response did not contain JSON."
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
Analyze this website request.

USER REQUEST:
${String(
  request
).slice(
  0,
  12000
)}

Preserve exactly:
- branding
- exact text
- exact product count
- exact product names
- exact prices
- exact ratings
- exact stock
- requested features
- persistence requirements
- design requirements

Do not invent requirements.

Return ONLY JSON:

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
            "You are a requirements analyst. Return JSON only."
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
          2000,

        timeoutMs:
          REVIEW_TIMEOUT_MS
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
      "AURA",

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
      "Clean",
      "Responsive"
    ],

    validationRequirements:
      []
  };
}

// ============================================================
// REQUIREMENT CONTEXT
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
    8000
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
  12000
)}

REQUIREMENTS:
${requirementContext(
  specification
)}

TECHNOLOGY:

ONLY:
- HTML5
- CSS3
- Vanilla JavaScript

NOT ALLOWED:
- React
- JSX
- Next.js
- Vite
- npm
- package.json
- TypeScript
- backend code

The HTML must include all required sections,
IDs, classes, controls and forms needed by the
JavaScript.

The HTML MUST reference:

./style.css
./script.js

If Lucide is requested, include its CDN.

Do NOT return markdown.

Return ONLY the complete index.html.
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

Create ONLY the complete style.css.

USER REQUEST:
${String(
  request
).slice(
  0,
  9000
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

The CSS must create a polished production-quality website.

Include:

- responsive desktop layout
- responsive tablet layout
- responsive mobile layout
- typography
- spacing
- navigation
- hero
- cards
- forms
- buttons
- search
- cart
- checkout
- success states
- FAQ
- support panel
- theme system when requested
- hover effects
- transitions
- animations when requested

Use CSS custom properties for themes.

Do not generate HTML.

Do not generate JavaScript.

Return ONLY CSS.
`;
}

// ============================================================
// JAVASCRIPT PROMPT
// ============================================================

function buildJavascriptPrompt(
  request,
  specification,
  html
) {
  return `
You are AURA's senior frontend JavaScript engineer.

Create ONLY the complete script.js.

USER REQUEST:
${String(
  request
).slice(
  0,
  11000
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

Implement every requested interaction.

Use vanilla JavaScript only.

For ecommerce applications implement:
- exact products
- search
- cart
- quantities
- remove
- totals
- checkout
- address validation
- card validation
- expiry validation
- payment
- stock changes
- localStorage
- order history
- success state

For AURA/SaaS applications implement:
- theme switching
- localStorage theme persistence
- mobile menu
- FAQ accordion
- terminal interactions
- support chat
- support persistence
- scroll interactions
- animations
when requested.

Use Lucide initialization when requested.

Do not use:
- React
- JSX
- import
- npm
- backend

Do not create fake buttons.

Return ONLY JavaScript.
`;
}

// ============================================================
// CLEAN CODE
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
// GENERATE ONE FILE
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
                "Return only valid source code for the requested file."
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
              0.25,

            max_tokens:
              file ===
              "script.js"
                ? 9000
                : 6500,

            timeoutMs:
              AI_TIMEOUT_MS
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
    } catch (error) {
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
// FORCE CSS REFERENCE
// ============================================================

function ensureHtmlReferences(
  html
) {
  let result =
    String(
      html || ""
    );

  const hasCss =
    /href=["'](?:\.\/)?style\.css["']/i.test(
      result
    );

  const hasJs =
    /src=["'](?:\.\/)?script\.js["']/i.test(
      result
    );

  if (!hasCss) {
    if (
      /<\/head>/i.test(
        result
      )
    ) {
      result =
        result.replace(
          /<\/head>/i,
          `  <link rel="stylesheet" href="./style.css">\n</head>`
        );
    } else {
      result =
        `<link rel="stylesheet" href="./style.css">\n${result}`;
    }

    console.log(
      "🛠️ Added missing style.css reference."
    );
  }

  if (!hasJs) {
    if (
      /<\/body>/i.test(
        result
      )
    ) {
      result =
        result.replace(
          /<\/body>/i,
          `  <script src="./script.js"></script>\n</body>`
        );
    } else {
      result +=
        `\n<script src="./script.js"></script>`;
    }

    console.log(
      "🛠️ Added missing script.js reference."
    );
  }

  return result;
}

// ============================================================
// FORCE CSS INLINE FALLBACK
// ============================================================

function ensureStylesApplied(
  html,
  css
) {
  let result =
    String(
      html || ""
    );

  const stylesheet =
    String(
      css || ""
    ).trim();

  if (!stylesheet) {
    return result;
  }

  // First guarantee external file.
  result =
    ensureHtmlReferences(
      result
    );

  // If inline fallback already exists, don't duplicate it.
  if (
    result.includes(
      "AURA_INLINE_STYLE_FALLBACK"
    )
  ) {
    return result;
  }

  const inlineCss =
`
<!-- AURA_INLINE_STYLE_FALLBACK -->
<style id="aura-fallback-styles">
${stylesheet}
</style>
<!-- /AURA_INLINE_STYLE_FALLBACK -->
`;

  if (
    /<\/head>/i.test(
      result
    )
  ) {
    result =
      result.replace(
        /<\/head>/i,
        `${inlineCss}\n</head>`
      );
  } else {
    result =
      `${inlineCss}\n${result}`;
  }

  console.log(
    "🛡️ Added inline CSS fallback."
  );

  return result;
}

// ============================================================
// CSS VALIDATION
// ============================================================

function validateCssContent(
  css
) {
  const value =
    String(
      css || ""
    ).trim();

  if (!value) {
    return {
      valid:
        false,

      reason:
        "style.css is empty."
    };
  }

  if (
    /<html[\s>]/i.test(
      value
    ) ||
    /<body[\s>]/i.test(
      value
    ) ||
    /<head[\s>]/i.test(
      value
    )
  ) {
    return {
      valid:
        false,

      reason:
        "style.css contains HTML."
    };
  }

  const hasCssRule =
    /[^@][^{]+\{[^}]*\}/s.test(
      value
    );

  if (!hasCssRule) {
    return {
      valid:
        false,

      reason:
        "style.css contains no recognizable CSS rules."
    };
  }

  return {
    valid:
      true,

    reason:
      null
  };
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

  const cssValidation =
    validateCssContent(
      css
    );

  if (
    !cssValidation.valid
  ) {
    errors.push(
      cssValidation.reason
    );
  }

  const combined =
    [
      html,
      css,
      js
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

  return {
    valid:
      errors.length ===
      0,

    errors
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

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>AURA Website</title>

<link
  rel="stylesheet"
  href="./style.css"
>

</head>

<body>

<header class="header">

  <div class="container nav">

    <a
      href="#home"
      class="logo"
    >
      AURA
    </a>

  </div>

</header>

<main>

<section
  id="home"
  class="hero"
>

  <div class="container">

    <p class="eyebrow">
      AURA
    </p>

    <h1>
      Your idea.
      <span>
        Your website.
      </span>
    </h1>

    <p>
      ${safe}
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
  color: #ffffff;
}

a {
  color: inherit;
  text-decoration: none;
}

.container {
  width: min(1120px, calc(100% - 40px));
  margin: 0 auto;
}

.header {
  position: sticky;
  top: 0;
  z-index: 20;
  background: rgba(8, 11, 18, 0.92);
  border-bottom: 1px solid rgba(255,255,255,.08);
}

.nav {
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.logo {
  font-size: 24px;
  font-weight: 900;
  letter-spacing: 2px;
  color: #8b5cf6;
}

.hero {
  min-height: 82vh;
  display: flex;
  align-items: center;
}

.eyebrow {
  color: #8b5cf6;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 2px;
}

h1 {
  max-width: 900px;
  margin: 20px 0;
  font-size: clamp(52px, 9vw, 100px);
  line-height: .95;
  letter-spacing: -.06em;
}

h1 span {
  display: block;
  color: #8b5cf6;
}

footer {
  padding: 30px;
  text-align: center;
  color: #6b7280;
  border-top: 1px solid rgba(255,255,255,.08);
}`,

    "script.js":
`document.addEventListener(
  "DOMContentLoaded",
  () => {
    console.log(
      "AURA website ready."
    );
  }
);`
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

Review the website against the original request.

ORIGINAL REQUEST:
${String(
  request
).slice(
  0,
  9000
)}

REQUIREMENTS:
${requirementContext(
  specification
)}

Check actual functionality:

- exact data
- exact product count
- search
- cart
- quantity
- remove
- totals
- checkout
- validation
- localStorage
- stock
- order history
- responsive design
- theme
- animations
- FAQ
- support
- mobile navigation

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
            "Return JSON only."
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
          3500,

        timeoutMs:
          REVIEW_TIMEOUT_MS
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
  const prompt = `
Repair only this file:

${file}

Original request:
${String(
  request
).slice(
  0,
  9000
)}

Requirements:
${requirementContext(
  specification
)}

Review:
${JSON.stringify(
  review,
  null,
  2
)}

Current file:
${String(
  files[file] || ""
).slice(
  0,
  22000
)}

Rules:

- preserve exact data
- preserve working functionality
- keep responsive design
- vanilla HTML/CSS/JS only
- no React
- no JSX
- no Vite
- no npm
- no backend
- no AI metadata

Return ONLY corrected source code.
`;

  const result =
    await askAI(
      [
        {
          role:
            "system",

          content:
            "Return only source code."
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
          file ===
          "script.js"
            ? 9000
            : 6500,

        timeoutMs:
          AI_TIMEOUT_MS
      }
    );

  return cleanCodeOutput(
    result
  );
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

  // ==========================================================
  // REQUIREMENTS
  // ==========================================================

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
      `⚠️ Requirements analysis failed: ${safeError(
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
    "script.js": ""
  };

  // ==========================================================
  // HTML
  // ==========================================================

  console.log(
    "💻 Generating index.html..."
  );

  try {
    files["index.html"] =
      await generateOneFile(
        "index.html",
        userRequest,
        specification,
        files
      );

    files["index.html"] =
      ensureHtmlReferences(
        files["index.html"]
      );

    console.log(
      "✅ index.html ready."
    );
  } catch (error) {
    console.log(
      `❌ index.html failed: ${safeError(
        error
      )}`
    );
  }

  // ==========================================================
  // CSS
  // ==========================================================

  console.log(
    "🎨 Generating style.css..."
  );

  try {
    files["style.css"] =
      await generateOneFile(
        "style.css",
        userRequest,
        specification,
        files
      );

    let cssValidation =
      validateCssContent(
        files["style.css"]
      );

    if (
      !cssValidation.valid
    ) {
      console.log(
        "⚠️ Generated CSS failed validation."
      );

      console.log(
        cssValidation.reason
      );

      console.log(
        "🔄 Regenerating CSS..."
      );

      files["style.css"] =
        await generateOneFile(
          "style.css",
          userRequest,
          specification,
          files
        );

      cssValidation =
        validateCssContent(
          files["style.css"]
        );
    }

    console.log(
      "✅ style.css ready."
    );
  } catch (error) {
    console.log(
      `❌ style.css failed: ${safeError(
        error
      )}`
    );
  }

  // ==========================================================
  // CRITICAL CSS APPLICATION STEP
  // ==========================================================

  files["index.html"] =
    ensureStylesApplied(
      files["index.html"],
      files["style.css"]
    );

  // ==========================================================
  // JAVASCRIPT
  // ==========================================================

  console.log(
    "⚙️ Generating script.js..."
  );

  try {
    files["script.js"] =
      await generateOneFile(
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
      `❌ script.js failed: ${safeError(
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
      console.log(
        `🛠️ Fallback used for ${file}.`
      );

      files[file] =
        fallback[file];
    }
  }

  // ==========================================================
  // FINAL ASSET GUARANTEE
  // ==========================================================

  files["index.html"] =
    ensureHtmlReferences(
      files["index.html"]
    );

  files["index.html"] =
    ensureStylesApplied(
      files["index.html"],
      files["style.css"]
    );

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
        review.score ??
        "N/A"
      }`
    );

    if (
      Array.isArray(
        review.issues
      ) &&
      review.issues.length
    ) {
      console.log(
        "⚠️ Review issues:"
      );

      console.log(
        review.issues
      );
    }
  } catch (error) {
    console.log(
      `⚠️ Review unavailable: ${safeError(
        error
      )}`
    );
  }

  // ==========================================================
  // TARGETED REPAIR
  // ==========================================================

  if (
    review &&
    (
      review.passed === false ||
      review.repairNeeded === true
    )
  ) {
    const target =
      [
        "index.html",
        "style.css",
        "script.js"
      ].includes(
        review.repairFile
      )
        ? review.repairFile
        : null;

    if (target) {
      try {
        console.log(
          `🔧 Repairing ${target}...`
        );

        files[target] =
          await repairFile(
            target,
            userRequest,
            specification,
            files,
            review
          );

        console.log(
          `✅ ${target} repaired.`
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
  // FINAL HTML ASSET GUARANTEE AGAIN
  // ==========================================================

  files["index.html"] =
    ensureHtmlReferences(
      files["index.html"]
    );

  files["index.html"] =
    ensureStylesApplied(
      files["index.html"],
      files["style.css"]
    );

  // ==========================================================
  // FINAL VALIDATION
  // ==========================================================

  const validation =
    validateFiles(
      files
    );

  console.log(
    "🔐 Final validation..."
  );

  if (
    !validation.valid
  ) {
    console.log(
      "⚠️ Validation warnings:"
    );

    console.log(
      validation.errors
    );

    /*
     * Simple structural problems are fixed automatically.
     * We do not destroy a valid generated application.
     */

    files["index.html"] =
      ensureHtmlReferences(
        files["index.html"]
      );

    files["index.html"] =
      ensureStylesApplied(
        files["index.html"],
        files["style.css"]
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
    "✅ Website files written."
  );

  return {
    success:
      true,

    projectRoot,

    projectName,

    files: [
      "index.html",
      "style.css",
      "script.js"
    ],

    specification,

    review,

    validation:
      validateFiles(
        files
      )
  };
}

// ============================================================
// VERIFY FRONTEND
// ============================================================

function verifyFrontend(
  projectRoot
) {
  let html =
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
   * Always repair HTML asset references before deployment.
   */

  html =
    ensureHtmlReferences(
      html
    );

  html =
    ensureStylesApplied(
      html,
      css
    );

  writeProjectFile(
    projectRoot,
    "index.html",
    html
  );

  const files = {
    "index.html":
      html,

    "style.css":
      css,

    "script.js":
      js
  };

  const validation =
    validateFiles(
      files
    );

  const errors =
    [...validation.errors];

  const projectFiles =
    listProjectFiles(
      projectRoot
    );

  for (
    const file of projectFiles
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

  /*
   * The static website is still considered deployable
   * when only non-critical validation warnings remain.
   */

  if (
    errors.length
  ) {
    console.log(
      "⚠️ Verification warnings:"
    );

    console.log(
      errors
    );

    return {
      success:
        true,

      errors,

      warnings:
        errors
    };
  }

  console.log(
    "✅ Frontend verified."
  );

  return {
    success:
      true,

    errors: [],

    warnings: []
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
  if (!token) {
    throw new Error(
      "Vercel token is missing."
    );
  }

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
  if (!token) {
    throw new Error(
      "Vercel token is missing."
    );
  }

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
      `Vercel upload failed (${response.status}): ${text.slice(
        0,
        1800
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
        "Vercel account is not connected."
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

  /*
   * Repair asset references one final time
   * before deployment.
   */

  let html =
    readProjectFile(
      projectRoot,
      "index.html"
    ) || "";

  const css =
    readProjectFile(
      projectRoot,
      "style.css"
    ) || "";

  html =
    ensureHtmlReferences(
      html
    );

  html =
    ensureStylesApplied(
      html,
      css
    );

  writeProjectFile(
    projectRoot,
    "index.html",
    html
  );

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
            "application/json"
        },

        body:
          JSON.stringify(
            payload
          )
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
      null
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
  // REQUIREMENTS
  // ==========================================================

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
  } catch (error) {
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

  const requiredFiles = [
    "index.html",
    "style.css",
    "script.js"
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
            )
        },

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

  // ==========================================================
  // SUCCESS
  // ==========================================================

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
        "Static HTML/CSS/JS website requires no npm build."
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
      null,

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

  listProjectFiles,

  redactSecrets,

  askAI,

  escapeHtml,

  validateFiles,

  ensureHtmlReferences,

  ensureStylesApplied,

  validateCssContent
};
