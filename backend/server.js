const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config();

const app = express();

// ============================================================
// IMPORT AURA AGENT
// IMPORTANT:
// Actual folder:
// backend/src/agent/agent.js
// ============================================================

let runAgent = null;

try {
  const agent = require("./src/agent/agent");

  if (typeof agent.runAgent === "function") {
    runAgent = agent.runAgent;
    console.log("✅ AURA agent loaded successfully");
  } else {
    console.warn("⚠️ runAgent function was not found in src/agent/agent.js");
  }
} catch (error) {
  console.error("❌ Failed to load AURA agent");
  console.error(error.message);
}

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    name: "AURA Agent",
    message: "AURA backend is running",
    status: "online",
    platform: "Render",
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "healthy",
    service: "aura-agent",
    agentLoaded: typeof runAgent === "function",
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// AGENT STATUS
// ============================================================

app.get("/api/status", (req, res) => {
  res.status(200).json({
    success: true,
    service: "AURA Agent",
    agentLoaded: typeof runAgent === "function",
    environment: process.env.NODE_ENV || "development",
    render: process.env.RENDER === "true",
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// RUN AURA AGENT
// ============================================================

app.post("/api/agent", async (req, res) => {
  try {
    if (typeof runAgent !== "function") {
      return res.status(503).json({
        success: false,
        error: "AURA agent is not available",
        message: "Check backend/src/agent/agent.js",
      });
    }

    const input = req.body || {};

    console.log("==========================================");
    console.log("🤖 AURA API REQUEST");
    console.log("==========================================");
    console.log(input);

    const result = await runAgent(input);

    return res.status(200).json({
      success: true,
      result,
    });
  } catch (error) {
    console.error("❌ AURA agent error:");
    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message || "Agent execution failed",
    });
  }
});

// ============================================================
// VERCEL CALLBACK
// ============================================================
// This endpoint is kept ready for your future Vercel OAuth flow.
// Your Render URL can later be used as:
//
// https://YOUR-SERVICE.onrender.com/vercel/callback
// ============================================================

app.get("/vercel/callback", (req, res) => {
  const {
    code,
    state,
    error,
    error_description,
  } = req.query;

  if (error) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>AURA - Vercel Connection</title>
        <meta charset="UTF-8">
        <style>
          body {
            font-family: Arial, sans-serif;
            background: #0f172a;
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
          }

          .box {
            max-width: 500px;
            padding: 40px;
            border-radius: 20px;
            background: #1e293b;
            text-align: center;
          }

          h1 {
            color: #ef4444;
          }

          p {
            color: #cbd5e1;
          }
        </style>
      </head>

      <body>
        <div class="box">
          <h1>Vercel Connection Failed</h1>
          <p>${escapeHtml(error_description || error)}</p>
          <p>You can close this window and return to Telegram.</p>
        </div>
      </body>
      </html>
    `);
  }

  console.log("==========================================");
  console.log("🔵 VERCEL CALLBACK");
  console.log("==========================================");
  console.log("Code received:", Boolean(code));
  console.log("State received:", Boolean(state));

  return res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>AURA - Vercel Connected</title>
      <meta charset="UTF-8">

      <style>
        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: Arial, sans-serif;
          background: linear-gradient(
            135deg,
            #020617,
            #0f172a,
            #111827
          );
          color: white;
        }

        .box {
          width: 90%;
          max-width: 520px;
          padding: 45px;
          border-radius: 24px;
          background: rgba(30, 41, 59, 0.95);
          text-align: center;
          box-shadow: 0 20px 60px rgba(0,0,0,.4);
        }

        .icon {
          font-size: 60px;
          margin-bottom: 20px;
        }

        h1 {
          margin-bottom: 10px;
        }

        p {
          color: #cbd5e1;
          line-height: 1.6;
        }

        .success {
          color: #22c55e;
        }
      </style>
    </head>

    <body>
      <div class="box">
        <div class="icon">✅</div>

        <h1 class="success">
          Vercel Connected
        </h1>

        <p>
          AURA successfully received the Vercel authorization.
        </p>

        <p>
          Return to Telegram to continue the deployment process.
        </p>
      </div>
    </body>
    </html>
  `);
});

// ============================================================
// 404
// ============================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
    path: req.originalUrl,
  });
});

// ============================================================
// ERROR HANDLER
// ============================================================

app.use((error, req, res, next) => {
  console.error("❌ SERVER ERROR:");
  console.error(error);

  res.status(500).json({
    success: false,
    error: error.message || "Internal server error",
  });
});

// ============================================================
// HTML ESCAPE
// ============================================================

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================
// START SERVER
// ============================================================

const PORT = Number(process.env.PORT) || 10000;
const HOST = "0.0.0.0";

const server = app.listen(PORT, HOST, () => {
  console.log("");
  console.log("==========================================");
  console.log("🚀 AURA BACKEND STARTED");
  console.log("==========================================");
  console.log(`🌐 Host: ${HOST}`);
  console.log(`🔌 Port: ${PORT}`);
  console.log(`🤖 Agent loaded: ${typeof runAgent === "function"}`);
  console.log("");
  console.log("Health:");
  console.log(`/health`);
  console.log("");
  console.log("Agent:");
  console.log(`/api/agent`);
  console.log("");
  console.log("Vercel callback:");
  console.log(`/vercel/callback`);
  console.log("==========================================");
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

function shutdown(signal) {
  console.log(`\n🛑 ${signal} received. Shutting down...`);

  server.close(() => {
    console.log("✅ HTTP server closed.");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("⚠️ Forced shutdown.");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
