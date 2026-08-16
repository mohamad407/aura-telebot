"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");

// ============================================================
// AURA MODULAR PROJECT PLANNER
// ============================================================
//
// New architecture:
//
// Telegram request
//      ↓
// Requirements Analyzer
//      ↓
// Local Architecture Engine
//      ↓
// File Tree
//      ↓
// Small AI code requests
//      ↓
// Project files
//
// IMPORTANT:
// We intentionally DO NOT ask the model to generate an entire
// project as one giant JSON response.
//
// This prevents:
// - Groq TPM errors
// - Groq TPD exhaustion
// - huge JSON responses
// - invalid JSON
// - code being truncated
//
// ============================================================

const {
  aiChat,
  aiChatText,
} = require("../ai/gateway");

// ============================================================
// CONFIGURATION
// ============================================================

const PROJECTS_ROOT = path.resolve(
  __dirname,
  "..",
  "projects"
);

const MAX_REQUIREMENT_LENGTH = 12000;

const DEFAULT_PROJECT_NAME = "aura-project";

// ============================================================
// SAFE HELPERS
// ============================================================

function safeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value);
}

function normalizeText(value) {
  return safeString(value)
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value) {
  const result = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);

  return result || DEFAULT_PROJECT_NAME;
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, {
    recursive: true,
  });
}

function writeFileSafe(filePath, content) {
  const absolutePath = path.resolve(filePath);

  ensureDirectory(path.dirname(absolutePath));

  fs.writeFileSync(
    absolutePath,
    safeString(content),
    "utf8"
  );
}

function projectDirectory(projectName) {
  return path.join(
    PROJECTS_ROOT,
    slugify(projectName)
  );
}

function unique(array) {
  return [...new Set(array)];
}

// ============================================================
// JSON EXTRACTION
// ============================================================
//
// Models sometimes return:
//
// ```json
// {...}
// ```
//
// or:
//
// Here is the JSON:
// {...}
//
// We extract only the object.
//

function extractJsonObject(text) {
  const raw = safeString(text).trim();

  if (!raw) {
    throw new Error(
      "AI returned an empty response."
    );
  }

  // Direct JSON
  try {
    const parsed = JSON.parse(raw);

    if (
      parsed &&
      typeof parsed === "object"
    ) {
      return parsed;
    }
  } catch (_) {
    // Continue.
  }

  // Remove markdown fences.
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);

    if (
      parsed &&
      typeof parsed === "object"
    ) {
      return parsed;
    }
  } catch (_) {
    // Continue.
  }

  // Find first balanced JSON object.
  const start = cleaned.indexOf("{");

  if (start === -1) {
    throw new Error(
      "AI did not return a JSON object."
    );
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (
    let i = start;
    i < cleaned.length;
    i++
  ) {
    const char = cleaned[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth++;
    }

    if (char === "}") {
      depth--;

      if (depth === 0) {
        const candidate =
          cleaned.slice(
            start,
            i + 1
          );

        try {
          const parsed =
            JSON.parse(candidate);

          if (
            parsed &&
            typeof parsed === "object"
          ) {
            return parsed;
          }
        } catch (_) {
          break;
        }
      }
    }
  }

  throw new Error(
    "AI response contained JSON-like content but it was invalid."
  );
}

// ============================================================
// AI JSON REQUEST
// ============================================================
//
// IMPORTANT:
//
// One small request.
// No giant architecture + code + files request.
//

async function askAIJson({
  system,
  user,
  maxTokens = 900,
  temperature = 0.1,
}) {
  const result = await aiChat({
    system,
    user,
    maxTokens,
    temperature,
  });

  const text =
    result?.content || "";

  if (!text.trim()) {
    throw new Error(
      "AI returned an empty response."
    );
  }

  try {
    return extractJsonObject(text);
  } catch (error) {
    console.warn(
      "⚠️ AI JSON parsing failed:",
      error.message
    );

    throw error;
  }
}

// ============================================================
// LOCAL REQUIREMENTS DETECTOR
// ============================================================
//
// This is intentionally local.
//
// It means a simple request does NOT consume AI tokens
// just to determine obvious features.
//

function detectFeatures(goal) {
  const text =
    normalizeText(goal).toLowerCase();

  const features = [];

  const has = (...words) =>
    words.some((word) =>
      text.includes(word)
    );

  if (
    has(
      "ecommerce",
      "e-commerce",
      "online store",
      "shopping",
      "shop",
      "store"
    )
  ) {
    features.push(
      "product catalog",
      "product details",
      "shopping cart",
      "checkout",
      "orders",
      "search and filtering"
    );
  }

  if (
    has(
      "login",
      "authentication",
      "auth",
      "signup",
      "sign up",
      "register"
    )
  ) {
    features.push(
      "authentication",
      "user registration",
      "login"
    );
  }

  if (
    has(
      "admin",
      "dashboard",
      "admin panel"
    )
  ) {
    features.push(
      "admin dashboard",
      "role-based access"
    );
  }

  if (
    has(
      "payment",
      "payments",
      "razorpay",
      "stripe",
      "checkout"
    )
  ) {
    features.push(
      "payment integration",
      "payment status"
    );
  }

  if (
    has(
      "database",
      "mongodb",
      "mysql",
      "postgres",
      "postgresql",
      "sql"
    )
  ) {
    features.push(
      "database"
    );
  }

  if (
    has(
      "api",
      "backend",
      "server",
      "rest api"
    )
  ) {
    features.push(
      "REST API",
      "backend"
    );
  }

  if (
    has(
      "upload",
      "image upload",
      "file upload",
      "cloudinary"
    )
  ) {
    features.push(
      "file upload",
      "image management"
    );
  }

  if (
    has(
      "search",
      "filter",
      "sorting"
    )
  ) {
    features.push(
      "search",
      "filtering"
    );
  }

  if (
    has(
      "chat",
      "messaging",
      "chatbot"
    )
  ) {
    features.push(
      "real-time messaging"
    );
  }

  if (
    has(
      "notification",
      "notifications",
      "email"
    )
  ) {
    features.push(
      "notifications"
    );
  }

  if (
    has(
      "ai",
      "artificial intelligence",
      "machine learning",
      "llm",
      "assistant"
    )
  ) {
    features.push(
      "AI functionality"
    );
  }

  return unique(features);
}

// ============================================================
// PROJECT TYPE DETECTOR
// ============================================================

function detectProjectType(goal) {
  const text =
    normalizeText(goal).toLowerCase();

  if (
    text.includes("ecommerce") ||
    text.includes("e-commerce") ||
    text.includes("online store") ||
    text.includes("shopping")
  ) {
    return "ecommerce";
  }

  if (
    text.includes("portfolio")
  ) {
    return "portfolio";
  }

  if (
    text.includes("blog")
  ) {
    return "blog";
  }

  if (
    text.includes("dashboard") ||
    text.includes("admin panel")
  ) {
    return "dashboard";
  }

  if (
    text.includes("saas")
  ) {
    return "saas";
  }

  if (
    text.includes("landing page")
  ) {
    return "landing-page";
  }

  if (
    text.includes("mobile app") ||
    text.includes("flutter")
  ) {
    return "mobile-app";
  }

  if (
    text.includes("api") ||
    text.includes("backend")
  ) {
    return "backend";
  }

  return "web-app";
}

// ============================================================
// STACK DETECTOR
// ============================================================

function detectStack(goal, projectType, features) {
  const text =
    normalizeText(goal).toLowerCase();

  const stack = {
    frontend: "React + Vite",
    styling: "Tailwind CSS",
    backend: null,
    database: null,
    authentication: null,
    payments: null,
    storage: null,
  };

  if (
    text.includes("next.js") ||
    text.includes("nextjs")
  ) {
    stack.frontend =
      "Next.js";
  }

  if (
    text.includes("vue")
  ) {
    stack.frontend =
      "Vue";
  }

  if (
    text.includes("angular")
  ) {
    stack.frontend =
      "Angular";
  }

  if (
    text.includes("flutter")
  ) {
    stack.frontend =
      "Flutter";
  }

  if (
    projectType === "backend"
  ) {
    stack.frontend = null;
  }

  if (
    features.includes("backend") ||
    features.includes("REST API") ||
    features.includes("database") ||
    projectType === "ecommerce" ||
    projectType === "saas" ||
    projectType === "dashboard"
  ) {
    stack.backend =
      "Node.js + Express";
  }

  if (
    text.includes("mongodb")
  ) {
    stack.database =
      "MongoDB";
  } else if (
    text.includes("postgres")
  ) {
    stack.database =
      "PostgreSQL";
  } else if (
    text.includes("mysql")
  ) {
    stack.database =
      "MySQL";
  } else if (
    features.includes("database") ||
    projectType === "ecommerce" ||
    projectType === "saas" ||
    projectType === "dashboard"
  ) {
    stack.database =
      "MongoDB";
  }

  if (
    features.includes("authentication") ||
    projectType === "ecommerce" ||
    projectType === "saas"
  ) {
    stack.authentication =
      "JWT";
  }

  if (
    features.includes(
      "payment integration"
    )
  ) {
    if (
      text.includes("stripe")
    ) {
      stack.payments =
        "Stripe";
    } else {
      stack.payments =
        "Razorpay";
    }
  }

  if (
    features.includes(
      "file upload"
    ) ||
    features.includes(
      "image management"
    )
  ) {
    stack.storage =
      "Cloudinary";
  }

  return stack;
}

// ============================================================
// REQUIREMENTS ANALYZER
// ============================================================

async function analyzeRequirements(
  goal
) {
  const cleanGoal =
    normalizeText(goal).slice(
      0,
      MAX_REQUIREMENT_LENGTH
    );

  const projectType =
    detectProjectType(cleanGoal);

  const features =
    detectFeatures(cleanGoal);

  const stack =
    detectStack(
      cleanGoal,
      projectType,
      features
    );

  // Ask AI only for the parts that local rules
  // cannot reliably determine.
  //
  // Keep this request small.

  let aiRequirements = {};

  try {
    aiRequirements =
      await askAIJson({
        system: `
You are AURA Requirements Analyzer.

Analyze the user's software request.

Return ONLY valid JSON.

Do not write markdown.
Do not include code.
Do not include explanations.

JSON format:

{
  "projectName": "short-name",
  "summary": "one sentence",
  "features": ["feature"],
  "pages": ["page"],
  "roles": ["role"],
  "requirements": ["requirement"]
}

Keep the response concise.
Maximum 8 features.
Maximum 10 pages.
Maximum 4 roles.
Maximum 10 requirements.
        `.trim(),

        user: `
USER REQUEST:
${cleanGoal}

PROJECT TYPE DETECTED:
${projectType}

FEATURES DETECTED LOCALLY:
${features.join(", ") || "none"}
        `.trim(),

        maxTokens: 800,
        temperature: 0.1,
      });
  } catch (error) {
    console.warn(
      "⚠️ AI requirements analysis failed."
    );

    console.warn(
      error.message
    );

    aiRequirements = {};
  }

  const mergedFeatures =
    unique([
      ...features,
      ...(Array.isArray(
        aiRequirements.features
      )
        ? aiRequirements.features
        : []),
    ]).slice(0, 15);

  const pages =
    Array.isArray(
      aiRequirements.pages
    )
      ? unique(
          aiRequirements.pages
        ).slice(0, 15)
      : [];

  const roles =
    Array.isArray(
      aiRequirements.roles
    )
      ? unique(
          aiRequirements.roles
        ).slice(0, 5)
      : ["user"];

  const requirements =
    Array.isArray(
      aiRequirements.requirements
    )
      ? unique(
          aiRequirements.requirements
        ).slice(0, 12)
      : [];

  return {
    projectName:
      slugify(
        aiRequirements.projectName ||
          projectType
      ),

    summary:
      aiRequirements.summary ||
      cleanGoal,

    originalRequest:
      cleanGoal,

    projectType,

    features:
      mergedFeatures,

    pages,

    roles,

    requirements,

    stack,
  };
}

// ============================================================
// LOCAL ARCHITECTURE ENGINE
// ============================================================
//
// No AI required.
//
// This creates a deterministic architecture based on the
// detected project type.
//

function createArchitecture(
  requirements
) {
  const {
    projectName,
    projectType,
    features,
    stack,
  } = requirements;

  const files = [];

  // ----------------------------------------------------------
  // FRONTEND
  // ----------------------------------------------------------

  if (stack.frontend) {
    files.push(
      {
        path: "frontend/package.json",
        purpose:
          "Frontend dependencies and scripts",
      },
      {
        path: "frontend/index.html",
        purpose:
          "Frontend HTML entry point",
      },
      {
        path: "frontend/src/main.jsx",
        purpose:
          "React application entry point",
      },
      {
        path: "frontend/src/App.jsx",
        purpose:
          "Main application component",
      },
      {
        path: "frontend/src/index.css",
        purpose:
          "Global styling",
      },
      {
        path: "frontend/src/components/Navbar.jsx",
        purpose:
          "Reusable navigation",
      },
      {
        path: "frontend/src/components/Footer.jsx",
        purpose:
          "Reusable footer",
      },
      {
        path: "frontend/src/components/Loading.jsx",
        purpose:
          "Loading state component",
      },
      {
        path: "frontend/src/pages/Home.jsx",
        purpose:
          "Home page",
      },
    );
  }

  // ----------------------------------------------------------
  // ECOMMERCE
  // ----------------------------------------------------------

  if (
    projectType === "ecommerce"
  ) {
    files.push(
      {
        path:
          "frontend/src/pages/Products.jsx",
        purpose:
          "Product listing",
      },
      {
        path:
          "frontend/src/pages/ProductDetails.jsx",
        purpose:
          "Product details",
      },
      {
        path:
          "frontend/src/pages/Cart.jsx",
        purpose:
          "Shopping cart",
      },
      {
        path:
          "frontend/src/pages/Checkout.jsx",
        purpose:
          "Checkout",
      },
      {
        path:
          "frontend/src/pages/Login.jsx",
        purpose:
          "Customer login",
      },
      {
        path:
          "frontend/src/pages/Register.jsx",
        purpose:
          "Customer registration",
      },
      {
        path:
          "frontend/src/pages/Orders.jsx",
        purpose:
          "Customer orders",
      },
      {
        path:
          "frontend/src/pages/Admin.jsx",
        purpose:
          "Admin dashboard",
      },
      {
        path:
          "frontend/src/components/ProductCard.jsx",
        purpose:
          "Product card",
      },
      {
        path:
          "frontend/src/components/SearchBar.jsx",
        purpose:
          "Product search",
      },
      {
        path:
          "frontend/src/context/CartContext.jsx",
        purpose:
          "Cart state",
      },
    );
  }

  // ----------------------------------------------------------
  // AUTHENTICATION
  // ----------------------------------------------------------

  if (
    features.includes(
      "authentication"
    ) ||
    stack.authentication
  ) {
    files.push(
      {
        path:
          "frontend/src/context/AuthContext.jsx",
        purpose:
          "Authentication state",
      },
      {
        path:
          "frontend/src/components/ProtectedRoute.jsx",
        purpose:
          "Protected routes",
      }
    );
  }

  // ----------------------------------------------------------
  // BACKEND
  // ----------------------------------------------------------

  if (stack.backend) {
    files.push(
      {
        path: "backend/package.json",
        purpose:
          "Backend dependencies",
      },
      {
        path: "backend/src/server.js",
        purpose:
          "Express server",
      },
      {
        path: "backend/src/app.js",
        purpose:
          "Express application",
      },
      {
        path:
          "backend/src/config/env.js",
        purpose:
          "Environment configuration",
      },
      {
        path:
          "backend/src/middleware/error.js",
        purpose:
          "Error handling",
      },
      {
        path:
          "backend/src/routes/health.js",
        purpose:
          "Health endpoint",
      },
    );
  }

  // ----------------------------------------------------------
  // DATABASE
  // ----------------------------------------------------------

  if (stack.database) {
    files.push(
      {
        path:
          "backend/src/config/database.js",
        purpose:
          "Database connection",
      },
      {
        path:
          "backend/src/models/User.js",
        purpose:
          "User model",
      }
    );
  }

  // ----------------------------------------------------------
  // ECOMMERCE BACKEND
  // ----------------------------------------------------------

  if (
    projectType === "ecommerce" &&
    stack.backend
  ) {
    files.push(
      {
        path:
          "backend/src/models/Product.js",
        purpose:
          "Product model",
      },
      {
        path:
          "backend/src/models/Order.js",
        purpose:
          "Order model",
      },
      {
        path:
          "backend/src/controllers/productController.js",
        purpose:
          "Product business logic",
      },
      {
        path:
          "backend/src/controllers/orderController.js",
        purpose:
          "Order business logic",
      },
      {
        path:
          "backend/src/routes/products.js",
        purpose:
          "Product API",
      },
      {
        path:
          "backend/src/routes/orders.js",
        purpose:
          "Order API",
      }
    );
  }

  // ----------------------------------------------------------
  // AUTH BACKEND
  // ----------------------------------------------------------

  if (
    stack.authentication &&
    stack.backend
  ) {
    files.push(
      {
        path:
          "backend/src/controllers/authController.js",
        purpose:
          "Authentication logic",
      },
      {
        path:
          "backend/src/routes/auth.js",
        purpose:
          "Authentication API",
      },
      {
        path:
          "backend/src/middleware/auth.js",
        purpose:
          "JWT authentication middleware",
      }
    );
  }

  // ----------------------------------------------------------
  // PAYMENT
  // ----------------------------------------------------------

  if (
    stack.payments &&
    stack.backend
  ) {
    files.push(
      {
        path:
          "backend/src/services/paymentService.js",
        purpose:
          `${stack.payments} payment integration`,
      },
      {
        path:
          "backend/src/routes/payment.js",
        purpose:
          "Payment API",
      }
    );
  }

  // ----------------------------------------------------------
  // STORAGE
  // ----------------------------------------------------------

  if (
    stack.storage &&
    stack.backend
  ) {
    files.push(
      {
        path:
          "backend/src/config/cloudinary.js",
        purpose:
          "Cloudinary configuration",
      },
      {
        path:
          "backend/src/middleware/upload.js",
        purpose:
          "File upload middleware",
      }
    );
  }

  // ----------------------------------------------------------
  // ROOT FILES
  // ----------------------------------------------------------

  files.push(
    {
      path: "README.md",
      purpose:
        "Project documentation",
    },
    {
      path: ".gitignore",
      purpose:
        "Git ignored files",
    },
    {
      path: ".env.example",
      purpose:
        "Environment variable template",
    }
  );

  return {
    projectName,

    architectureVersion:
      "2.0",

    projectType,

    stack,

    directories:
      unique(
        files.map((file) =>
          path
            .dirname(file.path)
            .replace(/\\/g, "/")
        )
      ),

    files,
  };
}

// ============================================================
// FILE TREE DISPLAY
// ============================================================

function createFileTree(
  architecture
) {
  const tree = {};

  for (
    const file of architecture.files
  ) {
    const parts =
      file.path.split("/");

    let current = tree;

    parts.forEach(
      (part, index) => {
        const last =
          index ===
          parts.length - 1;

        if (last) {
          current[part] =
            file.purpose;
        } else {
          if (
            !current[part] ||
            typeof current[part] !==
              "object"
          ) {
            current[part] = {};
          }

          current =
            current[part];
        }
      }
    );
  }

  return tree;
}

// ============================================================
// SMALL FILE CODE GENERATOR
// ============================================================
//
// IMPORTANT:
//
// This function generates ONE file at a time.
//
// Never ask the model to return:
// architecture + 30 files + code in one response.
//

async function generateFileCode({
  goal,
  requirements,
  architecture,
  file,
}) {
  const filePath =
    file.path;

  const system = `
You are AURA Coding Agent.

Generate code for exactly ONE file.

Rules:
1. Return ONLY the file content.
2. Do NOT return JSON.
3. Do NOT use markdown fences.
4. Do NOT explain the code.
5. Do NOT generate other files.
6. Follow the requested project architecture.
7. Write production-quality code.
8. Keep dependencies consistent with the project stack.
9. Never invent secrets or API keys.
10. Use environment variables for secrets.

PROJECT TYPE:
${requirements.projectType}

STACK:
${JSON.stringify(
  requirements.stack
)}

TARGET FILE:
${filePath}

FILE PURPOSE:
${file.purpose}
`.trim();

  const user = `
USER REQUEST:
${requirements.originalRequest}

PROJECT SUMMARY:
${requirements.summary}

DETECTED FEATURES:
${requirements.features.join(", ")}

REQUIRED PAGES:
${requirements.pages.join(", ") || "Use the architecture."}

GENERATE ONLY:
${filePath}
`.trim();

  const result =
    await aiChatText({
      system,
      user,
      maxTokens:
        getFileTokenBudget(
          filePath
        ),
      temperature: 0.15,
    });

  return cleanGeneratedCode(
    result,
    filePath
  );
}

// ============================================================
// FILE TOKEN BUDGET
// ============================================================

function getFileTokenBudget(
  filePath
) {
  const lower =
    filePath.toLowerCase();

  if (
    lower.endsWith(
      "package.json"
    )
  ) {
    return 500;
  }

  if (
    lower.endsWith(
      ".css"
    )
  ) {
    return 1600;
  }

  if (
    lower.endsWith(
      ".jsx"
    )
  ) {
    return 2200;
  }

  if (
    lower.endsWith(
      ".tsx"
    )
  ) {
    return 2200;
  }

  if (
    lower.endsWith(
      ".js"
    )
  ) {
    return 1800;
  }

  if (
    lower.endsWith(
      ".html"
    )
  ) {
    return 1800;
  }

  if (
    lower.endsWith(
      ".md"
    )
  ) {
    return 1000;
  }

  return 1400;
}

// ============================================================
// CODE CLEANER
// ============================================================

function cleanGeneratedCode(
  content,
  filePath
) {
  let result =
    safeString(content)
      .trim();

  // Remove accidental markdown fences.
  result =
    result.replace(
      /^```[a-zA-Z0-9_-]*\s*/i,
      ""
    );

  result =
    result.replace(
      /\s*```$/i,
      ""
    );

  // Remove accidental leading explanation
  // only for very obvious cases.
  const prefixes = [
    "Here is the code:",
    "Here is the file:",
    "Here is the requested file:",
  ];

  for (
    const prefix of prefixes
  ) {
    if (
      result
        .toLowerCase()
        .startsWith(
          prefix.toLowerCase()
        )
    ) {
      result =
        result
          .slice(
            prefix.length
          )
          .trim();
    }
  }

  if (!result) {
    throw new Error(
      `Generated file is empty: ${filePath}`
    );
  }

  return result;
}

// ============================================================
// CREATE PROJECT SCAFFOLD
// ============================================================

function createProjectScaffold(
  architecture
) {
  const directory =
    projectDirectory(
      architecture.projectName
    );

  ensureDirectory(
    directory
  );

  for (
    const file of architecture.files
  ) {
    const absolutePath =
      path.join(
        directory,
        file.path
      );

    ensureDirectory(
      path.dirname(
        absolutePath
      )
    );
  }

  return directory;
}

// ============================================================
// WRITE GENERATED FILE
// ============================================================

function saveGeneratedFile({
  projectDirectoryPath,
  filePath,
  content,
}) {
  const absolutePath =
    path.resolve(
      projectDirectoryPath,
      filePath
    );

  // Security: prevent ../ escape.
  if (
    !absolutePath.startsWith(
      path.resolve(
        projectDirectoryPath
      ) + path.sep
    )
  ) {
    throw new Error(
      `Unsafe file path rejected: ${filePath}`
    );
  }

  writeFileSafe(
    absolutePath,
    content
  );

  return absolutePath;
}

// ============================================================
// LOCAL DESIGN SPEC
// ============================================================
//
// Design does NOT need to be a huge AI JSON request.
// AI can refine this later if necessary.
//

function createLocalDesignSpec(
  requirements
) {
  const type =
    requirements.projectType;

  if (
    type === "ecommerce"
  ) {
    return {
      mode: "dark",
      style:
        "premium modern ecommerce",
      visualDirection:
        "clean premium shopping experience with strong product imagery, polished cards and subtle animations",
      colors: {
        background:
          "#0b1020",
        surface:
          "#151c32",
        primary:
          "#7c5cff",
        accent:
          "#22d3ee",
        text:
          "#f8fafc",
      },
      layout:
        "responsive grid",
      animations:
        "subtle fade, hover and scale",
      accessibility:
        "keyboard accessible with visible focus states",
    };
  }

  if (
    type === "portfolio"
  ) {
    return {
      mode: "dark",
      style:
        "futuristic portfolio",
      visualDirection:
        "cinematic dark interface with glass surfaces, gradients and subtle motion",
      colors: {
        background:
          "#080b16",
        surface:
          "#111827",
        primary:
          "#8b5cf6",
        accent:
          "#22d3ee",
        text:
          "#f8fafc",
      },
      layout:
        "responsive sections",
      animations:
        "smooth scroll reveal",
      accessibility:
        "keyboard navigation and reduced motion support",
    };
  }

  return {
    mode: "dark",
    style:
      "premium modern application",
    visualDirection:
      "clean professional interface with strong hierarchy and subtle motion",
    colors: {
      background:
        "#0b1020",
      surface:
        "#151c32",
      primary:
        "#7c5cff",
      accent:
        "#22d3ee",
      text:
        "#f8fafc",
    },
    layout:
      "responsive application layout",
    animations:
      "subtle and smooth",
    accessibility:
      "keyboard accessible with reduced motion support",
  };
}

// ============================================================
// LOCAL FRONTEND ARCHITECT
// ============================================================

function createFrontendArchitecture(
  requirements,
  designSpec
) {
  return {
    projectName:
      requirements.projectName,

    framework:
      requirements.stack.frontend,

    styling:
      requirements.stack.styling,

    designSpec,

    sections:
      requirements.pages.length
        ? requirements.pages
        : ["Home"],

    files:
      requirements.projectType ===
      "ecommerce"
        ? [
            "frontend/index.html",
            "frontend/src/main.jsx",
            "frontend/src/App.jsx",
            "frontend/src/index.css",
            "frontend/src/components/Navbar.jsx",
            "frontend/src/components/Footer.jsx",
            "frontend/src/components/ProductCard.jsx",
            "frontend/src/components/SearchBar.jsx",
            "frontend/src/pages/Home.jsx",
            "frontend/src/pages/Products.jsx",
            "frontend/src/pages/ProductDetails.jsx",
            "frontend/src/pages/Cart.jsx",
            "frontend/src/pages/Checkout.jsx",
          ]
        : [
            "frontend/index.html",
            "frontend/src/main.jsx",
            "frontend/src/App.jsx",
            "frontend/src/index.css",
            "frontend/src/components/Navbar.jsx",
            "frontend/src/components/Footer.jsx",
            "frontend/src/pages/Home.jsx",
          ],
  };
}

// ============================================================
// GENERATE CODE PLAN
// ============================================================
//
// This returns metadata only.
// Actual code is generated file-by-file.
//

function generateCodePlan(
  requirements,
  architecture
) {
  return {
    goal:
      `Build ${requirements.projectName}`,

    projectType:
      requirements.projectType,

    stack:
      requirements.stack,

    actions:
      architecture.files.map(
        (file) => ({
          type:
            "create_file",
          path:
            file.path,
          purpose:
            file.purpose,
        })
      ),
  };
}

// ============================================================
// GENERATE PROJECT FILES
// ============================================================
//
// Can be called by your agent after architecture creation.
//

async function generateProjectFiles({
  requirements,
  architecture,
  onProgress,
}) {
  const directory =
    createProjectScaffold(
      architecture
    );

  const generatedFiles = [];

  for (
    let i = 0;
    i < architecture.files.length;
    i++
  ) {
    const file =
      architecture.files[i];

    console.log(
      `💻 Generating file ${i + 1}/${architecture.files.length}: ${file.path}`
    );

    if (onProgress) {
      await onProgress({
        current:
          i + 1,
        total:
          architecture.files.length,
        file:
          file.path,
      });
    }

    try {
      const content =
        await generateFileCode({
          goal:
            requirements.originalRequest,

          requirements,

          architecture,

          file,
        });

      saveGeneratedFile({
        projectDirectoryPath:
          directory,
        filePath:
          file.path,
        content,
      });

      generatedFiles.push(
        file.path
      );

      console.log(
        `✅ Created ${file.path}`
      );
    } catch (error) {
      console.error(
        `❌ Failed to generate ${file.path}:`,
        error.message
      );

      // Keep going.
      //
      // The validator/repair agent can later
      // regenerate failed files.
    }
  }

  return {
    projectDirectory:
      directory,

    files:
      generatedFiles,

    failedFiles:
      architecture.files
        .map(
          (file) =>
            file.path
        )
        .filter(
          (filePath) =>
            !generatedFiles.includes(
              filePath
            )
        ),
  };
}

// ============================================================
// LOCAL FALLBACK PLAN
// ============================================================

function createFallbackPlan(
  goal
) {
  const requirements = {
    projectName:
      slugify(goal),

    summary:
      normalizeText(goal),

    originalRequest:
      normalizeText(goal),

    projectType:
      detectProjectType(goal),

    features:
      detectFeatures(goal),

    pages: [],

    roles: ["user"],

    requirements: [],

    stack:
      detectStack(
        goal,
        detectProjectType(goal),
        detectFeatures(goal)
      ),
  };

  const designSpec =
    createLocalDesignSpec(
      requirements
    );

  const architecture =
    createArchitecture(
      requirements
    );

  return {
    goal:
      requirements.originalRequest,

    projectName:
      requirements.projectName,

    requirements,

    designSpec,

    architecture,

    fileTree:
      createFileTree(
        architecture
      ),

    codePlan:
      generateCodePlan(
        requirements,
        architecture
      ),

    actions:
      generateCodePlan(
        requirements,
        architecture
      ).actions,
  };
}

// ============================================================
// MAIN CREATE PLAN
// ============================================================
//
// This is the main function your agent should call.
//
// It does:
//
// 1. Requirements
// 2. Design
// 3. Architecture
// 4. File tree
// 5. Code plan
//
// It DOES NOT generate giant code JSON.
//

async function createPlan(
  goal
) {
  console.log(
    "\n🧠 AURA MODULAR PROJECT PLANNER"
  );

  console.log(
    `🎯 Goal: ${goal}`
  );

  console.log(
    "\n🔎 STAGE 1 — REQUIREMENTS ANALYZER"
  );

  let requirements;

  try {
    requirements =
      await analyzeRequirements(
        goal
      );

    console.log(
      "✅ Requirements analyzed"
    );
  } catch (error) {
    console.warn(
      "⚠️ Requirements AI failed."
    );

    console.warn(
      error.message
    );

    const fallback =
      createFallbackPlan(
        goal
      );

    return fallback;
  }

  console.log(
    "\n🎨 STAGE 2 — DESIGN"
  );

  const designSpec =
    createLocalDesignSpec(
      requirements
    );

  console.log(
    "✅ Local design specification created"
  );

  console.log(
    "\n🏗️ STAGE 3 — ARCHITECTURE"
  );

  const architecture =
    createArchitecture(
      requirements
    );

  console.log(
    "✅ Architecture created"
  );

  console.log(
    `📦 Files planned: ${architecture.files.length}`
  );

  console.log(
    "\n🌳 STAGE 4 — FILE TREE"
  );

  const fileTree =
    createFileTree(
      architecture
    );

  console.log(
    "✅ File tree created"
  );

  console.log(
    "\n💻 STAGE 5 — CODE PLAN"
  );

  const codePlan =
    generateCodePlan(
      requirements,
      architecture
    );

  console.log(
    "✅ Code plan created"
  );

  return {
    goal:
      requirements.originalRequest,

    projectName:
      requirements.projectName,

    requirements,

    designSpec,

    architecture,

    fileTree,

    codePlan,

    actions:
      codePlan.actions,

    // This tells agent.js what to do next.
    generationMode:
      "file-by-file",

    projectDirectory:
      projectDirectory(
        requirements.projectName
      ),
  };
}

// ============================================================
// LEGACY COMPATIBILITY HELPERS
// ============================================================
//
// These are kept so your existing agent.js doesn't immediately
// break if it imports these functions.
//

async function createDesignSpec(
  goal
) {
  const requirements =
    await analyzeRequirements(
      goal
    );

  return createLocalDesignSpec(
    requirements
  );
}

async function createFixPlan({
  projectName,
  errors = [],
  files = [],
}) {
  // Keep repair planning small.
  //
  // The future repair agent will use actual file contents
  // and exact build errors.

  const safeErrors =
    Array.isArray(errors)
      ? errors.slice(0, 10)
      : [];

  const safeFiles =
    Array.isArray(files)
      ? files.slice(0, 10)
      : [];

  try {
    return await askAIJson({
      system: `
You are AURA Debugger.

Return ONLY JSON.

Format:
{
  "reason": "short diagnosis",
  "actions": [
    {
      "type": "modify_file",
      "path": "relative/path",
      "instruction": "short precise change"
    }
  ]
}

Do not generate code.
Maximum 5 actions.
      `.trim(),

      user: `
PROJECT:
${projectName}

ERRORS:
${safeErrors.join("\n")}

FILES:
${safeFiles.join("\n")}
      `.trim(),

      maxTokens: 700,
      temperature: 0.1,
    });
  } catch (error) {
    console.warn(
      "⚠️ Debugger AI unavailable."
    );

    return {
      reason:
        "AI debugger unavailable. Retry after provider recovery.",

      actions: [],
    };
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Main planner
  createPlan,

  // Requirements
  analyzeRequirements,

  // Architecture
  createArchitecture,
  createFrontendArchitecture,

  // Design
  createDesignSpec,
  createLocalDesignSpec,

  // Code
  generateFileCode,
  generateProjectFiles,
  generateCodePlan,

  // File utilities
  createProjectScaffold,
  createFileTree,
  saveGeneratedFile,

  // Debugging
  createFixPlan,

  // JSON utilities
  extractJsonObject,
  askAIJson,

  // Detection
  detectProjectType,
  detectFeatures,
  detectStack,

  // Fallback
  createFallbackPlan,
};

