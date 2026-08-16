"use strict";

require("dotenv").config();

const http = require("node:http");
const crypto = require("node:crypto");

const {
  Telegraf,
  Markup,
} = require("telegraf");

const {
  runAgent,
  deployToVercel,
} = require("./Agent/agent");

// ============================================================
// AURA TELEGRAM BOT
// ============================================================

const BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  throw new Error(
    "TELEGRAM_BOT_TOKEN is missing from .env"
  );
}

const bot = new Telegraf(BOT_TOKEN);

// ============================================================
// CONFIG
// ============================================================

// AI variables remain your existing variables.
//
// Additional variables required ONLY for Vercel OAuth:
//
// VERCEL_CLIENT_ID=...
// VERCEL_CLIENT_SECRET=...
// VERCEL_CALLBACK_URL=http://localhost:3000/vercel/callback
//
// If VERCEL_CALLBACK_URL is not provided,
// localhost is used.

const VERCEL_CLIENT_ID =
  process.env.VERCEL_CLIENT_ID || "";

const VERCEL_CLIENT_SECRET =
  process.env.VERCEL_CLIENT_SECRET || "";

const VERCEL_CALLBACK_URL =
  process.env.VERCEL_CALLBACK_URL ||
  "http://localhost:3000/vercel/callback";

const HTTP_PORT =
  Number(process.env.PORT) || 3000;

// ============================================================
// USER SESSION
// ============================================================

const users = new Map();

// OAuth state -> Telegram user
const oauthStates = new Map();

// ------------------------------------------------------------
// User object
// ------------------------------------------------------------

function getUser(userId) {
  const key = String(userId);

  if (!users.has(key)) {
    users.set(key, {
      userId: key,

      projectName: null,
      projectDir: null,
      projectFiles: null,

      vercel: {
        accessToken: null,
        refreshToken: null,
        expiresAt: 0,
        teamId: null,
        connected: false,
        user: null,
      },

      busy: false,
    });
  }

  return users.get(key);
}

// ============================================================
// HELPERS
// ============================================================

function escapeTelegram(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function makeState() {
  return crypto.randomBytes(32).toString("hex");
}

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

// ============================================================
// VERCEL OAUTH
// ============================================================

function hasVercelOAuthConfig() {
  return Boolean(
    VERCEL_CLIENT_ID &&
      VERCEL_CLIENT_SECRET &&
      VERCEL_CALLBACK_URL
  );
}

function buildVercelAuthorizationUrl(
  telegramUserId
) {
  if (!hasVercelOAuthConfig()) {
    throw new Error(
      "Vercel OAuth is not configured."
    );
  }

  const state = makeState();

  oauthStates.set(state, {
    telegramUserId: String(telegramUserId),
    createdAt: Date.now(),
  });

  const params = new URLSearchParams();

  params.set(
    "client_id",
    VERCEL_CLIENT_ID
  );

  params.set(
    "redirect_uri",
    VERCEL_CALLBACK_URL
  );

  params.set(
    "scope",
    "deployments:write projects:write"
  );

  params.set(
    "state",
    state
  );

  return (
    "https://vercel.com/oauth/authorize?" +
    params.toString()
  );
}

// ============================================================
// VERCEL TOKEN EXCHANGE
// ============================================================

async function exchangeVercelCode(code) {
  if (!hasVercelOAuthConfig()) {
    throw new Error(
      "Vercel OAuth configuration is missing."
    );
  }

  const body = new URLSearchParams();

  body.set(
    "client_id",
    VERCEL_CLIENT_ID
  );

  body.set(
    "client_secret",
    VERCEL_CLIENT_SECRET
  );

  body.set(
    "code",
    code
  );

  body.set(
    "redirect_uri",
    VERCEL_CALLBACK_URL
  );

  const response = await fetch(
    "https://api.vercel.com/v2/oauth/access_token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body,
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch (_) {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
        data?.error ||
        text ||
        `Vercel OAuth error ${response.status}`
    );
  }

  return data;
}

// ============================================================
// VERCEL USER
// ============================================================

async function getVercelUser(accessToken) {
  const response = await fetch(
    "https://api.vercel.com/v2/user",
    {
      method: "GET",
      headers: {
        Authorization:
          `Bearer ${accessToken}`,
      },
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch (_) {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
        text ||
        `Vercel user request failed: ${response.status}`
    );
  }

  return data?.user || data;
}

// ============================================================
// REFRESH TOKEN
// ============================================================

async function refreshVercelToken(session) {
  if (!session.vercel.refreshToken) {
    return false;
  }

  const body = new URLSearchParams();

  body.set(
    "grant_type",
    "refresh_token"
  );

  body.set(
    "client_id",
    VERCEL_CLIENT_ID
  );

  body.set(
    "client_secret",
    VERCEL_CLIENT_SECRET
  );

  body.set(
    "refresh_token",
    session.vercel.refreshToken
  );

  const response = await fetch(
    "https://api.vercel.com/login/oauth/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body,
    }
  );

  if (!response.ok) {
    return false;
  }

  const data = await response.json();

  if (!data.access_token) {
    return false;
  }

  session.vercel.accessToken =
    data.access_token;

  if (data.refresh_token) {
    session.vercel.refreshToken =
      data.refresh_token;
  }

  session.vercel.expiresAt =
    Date.now() +
    Number(data.expires_in || 3600) * 1000;

  session.vercel.connected = true;

  return true;
}

// ============================================================
// GET VALID VERCEL TOKEN
// ============================================================

async function getValidVercelToken(session) {
  if (!session.vercel.accessToken) {
    return null;
  }

  // Give the token a 60-second safety window.
  if (
    session.vercel.expiresAt &&
    Date.now() <
      session.vercel.expiresAt - 60000
  ) {
    return session.vercel.accessToken;
  }

  const refreshed =
    await refreshVercelToken(session);

  if (refreshed) {
    return session.vercel.accessToken;
  }

  session.vercel.accessToken = null;
  session.vercel.refreshToken = null;
  session.vercel.connected = false;

  return null;
}

// ============================================================
// TELEGRAM KEYBOARD
// ============================================================

function projectKeyboard(session) {
  const connected =
    session.vercel.connected;

  const rows = [];

  if (connected) {
    rows.push([
      Markup.button.callback(
        "🚀 Deploy to Vercel",
        "deploy"
      ),
    ]);

    rows.push([
      Markup.button.callback(
        "🔄 Reconnect Vercel",
        "connect_vercel"
      ),
    ]);
  } else {
    rows.push([
      Markup.button.callback(
        "🔗 Connect Vercel",
        "connect_vercel"
      ),
    ]);
  }

  return Markup.inlineKeyboard(rows);
}

// ============================================================
// START
// ============================================================

bot.start(async (ctx) => {
  getUser(ctx.from.id);

  await ctx.reply(
    "🤖 <b>AURA</b>\n\n" +
      "Send me a website idea and I will generate it using:\n\n" +
      "• HTML\n" +
      "• CSS\n" +
      "• JavaScript\n\n" +
      "No React.\n" +
      "No Vite.\n" +
      "No npm build.\n\n" +
      "After generation you can connect your Vercel account and deploy.",
    {
      parse_mode: "HTML",
    }
  );
});

// ============================================================
// HELP
// ============================================================

bot.command("help", async (ctx) => {
  await ctx.reply(
    "🤖 <b>AURA Commands</b>\n\n" +
      "/start — Start AURA\n" +
      "/help — Show help\n" +
      "/vercel — Connect Vercel\n" +
      "/status — Show project status\n\n" +
      "Or simply send a website description.",
    {
      parse_mode: "HTML",
    }
  );
});

// ============================================================
// VERCEL COMMAND
// ============================================================

bot.command("vercel", async (ctx) => {
  const session =
    getUser(ctx.from.id);

  if (!hasVercelOAuthConfig()) {
    await ctx.reply(
      "⚠️ <b>Vercel OAuth is not configured.</b>\n\n" +
        "Add these variables to your .env:\n\n" +
        "<code>VERCEL_CLIENT_ID=...</code>\n" +
        "<code>VERCEL_CLIENT_SECRET=...</code>\n" +
        "<code>VERCEL_CALLBACK_URL=http://localhost:3000/vercel/callback</code>\n\n" +
        "Then restart AURA.",
      {
        parse_mode: "HTML",
      }
    );

    return;
  }

  try {
    const url =
      buildVercelAuthorizationUrl(
        ctx.from.id
      );

    await ctx.reply(
      "🔗 <b>Connect your Vercel account</b>\n\n" +
        "Click the button below and authorize AURA.\n\n" +
        "After authorization, return to Telegram.",
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.url(
              "🔐 Connect Vercel",
              url
            ),
          ],
        ]),
      }
    );
  } catch (error) {
    console.error(error);

    await ctx.reply(
      "❌ Could not start Vercel authorization."
    );
  }
});

// ============================================================
// STATUS
// ============================================================

bot.command("status", async (ctx) => {
  const session =
    getUser(ctx.from.id);

  const project =
    session.projectName
      ? `📦 ${session.projectName}`
      : "No project generated.";

  const vercel =
    session.vercel.connected
      ? "🟢 Vercel connected"
      : "🔴 Vercel not connected";

  await ctx.reply(
    `${project}\n${vercel}`
  );
});

// ============================================================
// CONNECT BUTTON
// ============================================================

bot.action(
  "connect_vercel",
  async (ctx) => {
    await ctx.answerCbQuery();

    if (!hasVercelOAuthConfig()) {
      await ctx.reply(
        "⚠️ Vercel OAuth is not configured.\n\n" +
          "Add:\n" +
          "VERCEL_CLIENT_ID\n" +
          "VERCEL_CLIENT_SECRET\n" +
          "VERCEL_CALLBACK_URL"
      );

      return;
    }

    try {
      const url =
        buildVercelAuthorizationUrl(
          ctx.from.id
        );

      await ctx.reply(
        "🔐 <b>Connect Vercel</b>\n\n" +
          "Authorize AURA using your own Vercel account.",
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [
              Markup.button.url(
                "Connect Vercel",
                url
              ),
            ],
          ]),
        }
      );
    } catch (error) {
      console.error(error);

      await ctx.reply(
        "❌ Could not create Vercel authorization URL."
      );
    }
  }
);

// ============================================================
// DEPLOY BUTTON
// ============================================================

bot.action(
  "deploy",
  async (ctx) => {
    await ctx.answerCbQuery();

    const session =
      getUser(ctx.from.id);

    if (!session.projectDir) {
      await ctx.reply(
        "❌ No generated project is available."
      );

      return;
    }

    if (session.busy) {
      await ctx.reply(
        "⏳ AURA is already processing your project."
      );

      return;
    }

    session.busy = true;

    try {
      const token =
        await getValidVercelToken(
          session
        );

      if (!token) {
        session.vercel.connected = false;

        await ctx.reply(
          "🔴 Your Vercel connection has expired.\n\n" +
            "Please connect Vercel again.",
          {
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "🔗 Connect Vercel",
                  "connect_vercel"
                ),
              ],
            ]),
          }
        );

        return;
      }

      await ctx.reply(
        "🚀 <b>Deploying to your Vercel account...</b>\n\n" +
          "Please wait.",
        {
          parse_mode: "HTML",
        }
      );

      const result =
        await deployToVercel(
          session.projectDir,
          session.projectName,
          token
        );

      await ctx.reply(
        "🎉 <b>Deployment successful!</b>\n\n" +
          `📦 Project: <b>${escapeTelegram(
            session.projectName
          )}</b>\n\n` +
          `🌐 <a href="${result.url}">${result.url}</a>`,
        {
          parse_mode: "HTML",
          disable_web_page_preview: false,
        }
      );
    } catch (error) {
      console.error(
        "❌ Deployment error:",
        error
      );

      await ctx.reply(
        "❌ <b>Deployment failed</b>\n\n" +
          `<code>${escapeTelegram(
            error?.message ||
              "Unknown Vercel error"
          )}</code>`,
        {
          parse_mode: "HTML",
        }
      );
    } finally {
      session.busy = false;
    }
  }
);

// ============================================================
// TEXT MESSAGE → GENERATE WEBSITE
// ============================================================

bot.on(
  "text",
  async (ctx) => {
    const text =
      String(ctx.message.text || "")
        .trim();

    if (!text) return;

    // Ignore commands.
    if (text.startsWith("/")) {
      return;
    }

    const session =
      getUser(ctx.from.id);

    if (session.busy) {
      await ctx.reply(
        "⏳ AURA is already working on your previous request."
      );

      return;
    }

    session.busy = true;

    try {
      await ctx.reply(
        "🧠 <b>AURA is generating your website...</b>\n\n" +
          "HTML + CSS + JavaScript only.",
        {
          parse_mode: "HTML",
        }
      );

      const result =
        await runAgent(text, {
          projectName: undefined,
        });

      session.projectName =
        result.projectName;

      session.projectDir =
        result.projectDir;

      session.projectFiles =
        result.files;

      const connected =
        session.vercel.connected;

      await ctx.reply(
        "✅ <b>Website generated successfully!</b>\n\n" +
          `📦 Project: <b>${escapeTelegram(
            result.projectName
          )}</b>\n\n` +
          "Files:\n" +
          "• index.html\n" +
          "• style.css\n" +
          "• script.js\n\n" +
          "Build: ✅ Static validation passed\n" +
          "React: ❌ Not used\n" +
          "Vite: ❌ Not used\n" +
          "NPM: ❌ Not required\n\n" +
          (
            connected
              ? "Your Vercel account is connected."
              : "Connect your Vercel account before deploying."
          ),
        {
          parse_mode: "HTML",
          ...projectKeyboard(session),
        }
      );
    } catch (error) {
      console.error(
        "❌ AURA generation error:",
        error
      );

      await ctx.reply(
        "❌ <b>Website generation failed</b>\n\n" +
          `<code>${escapeTelegram(
            error?.message ||
              "Unknown error"
          )}</code>`,
        {
          parse_mode: "HTML",
        }
      );
    } finally {
      session.busy = false;
    }
  }
);

// ============================================================
// VERCEL CALLBACK SERVER
// ============================================================

function startOAuthServer() {
  const server =
    http.createServer(
      async (req, res) => {
        try {
          const url =
            new URL(
              req.url,
              `http://${req.headers.host || "localhost"}`
            );

          if (
            url.pathname !==
            "/vercel/callback"
          ) {
            res.writeHead(404, {
              "Content-Type":
                "text/plain; charset=utf-8",
            });

            res.end("Not found");

            return;
          }

          const code =
            url.searchParams.get("code");

          const state =
            url.searchParams.get("state");

          const error =
            url.searchParams.get("error");

          const errorDescription =
            url.searchParams.get(
              "error_description"
            );

          if (error) {
            res.writeHead(400, {
              "Content-Type":
                "text/html; charset=utf-8",
            });

            res.end(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>AURA Vercel</title>
</head>
<body style="font-family:Arial;padding:40px">
<h1>Vercel authorization cancelled</h1>
<p>${escapeHtmlServer(
              errorDescription ||
                error
            )}</p>
<p>You can close this tab and return to Telegram.</p>
</body>
</html>
`);

            return;
          }

          if (!code || !state) {
            res.writeHead(400, {
              "Content-Type":
                "text/html; charset=utf-8",
            });

            res.end(
              "Missing OAuth code or state."
            );

            return;
          }

          const oauth =
            oauthStates.get(state);

          if (!oauth) {
            res.writeHead(400, {
              "Content-Type":
                "text/html; charset=utf-8",
            });

            res.end(
              "Invalid or expired OAuth state."
            );

            return;
          }

          oauthStates.delete(state);

          if (
            Date.now() -
              oauth.createdAt >
            10 * 60 * 1000
          ) {
            res.writeHead(400, {
              "Content-Type":
                "text/html; charset=utf-8",
            });

            res.end(
              "OAuth session expired."
            );

            return;
          }

          const session =
            getUser(
              oauth.telegramUserId
            );

          console.log(
            "🔐 Exchanging Vercel OAuth code..."
          );

          const tokenData =
            await exchangeVercelCode(
              code
            );

          if (!tokenData.access_token) {
            throw new Error(
              "Vercel did not return an access token."
            );
          }

          session.vercel.accessToken =
            tokenData.access_token;

          session.vercel.refreshToken =
            tokenData.refresh_token ||
            null;

          session.vercel.expiresAt =
            Date.now() +
            Number(
              tokenData.expires_in ||
                3600
            ) *
              1000;

          session.vercel.teamId =
            tokenData.team_id ||
            null;

          session.vercel.connected =
            true;

          try {
            session.vercel.user =
              await getVercelUser(
                session.vercel.accessToken
              );
          } catch (_) {
            session.vercel.user =
              null;
          }

          console.log(
            `✅ Vercel connected for Telegram user ${oauth.telegramUserId}`
          );

          const username =
            session.vercel.user
              ?.username ||
            session.vercel.user
              ?.name ||
            "your Vercel account";

          try {
            await bot.telegram.sendMessage(
              oauth.telegramUserId,
              "✅ <b>Vercel connected successfully!</b>\n\n" +
                `👤 Account: <b>${escapeTelegram(
                  username
                )}</b>\n\n` +
                "You can now return to your generated project in Telegram and press <b>Deploy to Vercel</b>.",
              {
                parse_mode: "HTML",
              }
            );
          } catch (telegramError) {
            console.error(
              "Telegram callback notification failed:",
              telegramError
            );
          }

          res.writeHead(200, {
            "Content-Type":
              "text/html; charset=utf-8",
          });

          res.end(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AURA — Vercel Connected</title>
</head>

<body style="
font-family:Arial,sans-serif;
background:#070b14;
color:white;
padding:40px;
text-align:center;
">

<div style="
max-width:500px;
margin:80px auto;
">

<h1>✅ Vercel Connected</h1>

<p>
Your Vercel account has been connected to AURA.
</p>

<p>
Return to Telegram and click
<b>Deploy to Vercel</b>.
</p>

<p style="opacity:.6">
You can close this tab now.
</p>

</div>

</body>
</html>
`);
        } catch (error) {
          console.error(
            "❌ OAuth callback error:",
            error
          );

          res.writeHead(500, {
            "Content-Type":
              "text/html; charset=utf-8",
          });

          res.end(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>AURA Error</title>
</head>

<body style="font-family:Arial;padding:40px">

<h1>❌ Vercel connection failed</h1>

<p>
${escapeHtmlServer(
            error?.message ||
              "Unknown error"
          )}
</p>

<p>
Return to Telegram and try again.
</p>

</body>
</html>
`);
        }
      }
    );

  server.listen(
    HTTP_PORT,
    "0.0.0.0",
    () => {
      console.log("");
      console.log(
        "=========================================="
      );
      console.log(
        "🌐 VERCEL OAUTH CALLBACK SERVER"
      );
      console.log(
        "=========================================="
      );

      console.log(
        `📡 Port: ${HTTP_PORT}`
      );

      console.log(
        `🔗 Callback: ${VERCEL_CALLBACK_URL}`
      );
    }
  );

  return server;
}

// ============================================================
// SERVER HTML ESCAPE
// ============================================================

function escapeHtmlServer(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================
// ERROR HANDLERS
// ============================================================

bot.catch((error) => {
  console.error(
    "❌ Telegram bot error:",
    error
  );
});

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "❌ Unhandled rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "❌ Uncaught exception:",
      error
    );
  }
);

// ============================================================
// START
// ============================================================

async function start() {
  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    "🤖 AURA TELEGRAM AGENT"
  );
  console.log(
    "=========================================="
  );

  console.log(
    "🟢 Mode: Telegram only"
  );

  console.log(
    "🎨 Frontend: HTML + CSS + JavaScript"
  );

  console.log(
    "⚛️ React: disabled"
  );

  console.log(
    "⚡ Vite: disabled"
  );

  console.log(
    "📦 NPM build: disabled"
  );

  console.log(
    `🔐 Vercel OAuth: ${
      hasVercelOAuthConfig()
        ? "configured"
        : "NOT configured"
    }`
  );

  if (!hasVercelOAuthConfig()) {
    console.log("");
    console.log(
      "⚠️ Add Vercel OAuth variables before using Connect Vercel:"
    );

    console.log(
      "VERCEL_CLIENT_ID=..."
    );

    console.log(
      "VERCEL_CLIENT_SECRET=..."
    );

    console.log(
      "VERCEL_CALLBACK_URL=http://localhost:3000/vercel/callback"
    );
  }

  startOAuthServer();

  await bot.launch();

  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    "✅ AURA BOT IS RUNNING"
  );
  console.log(
    "=========================================="
  );
}

start();

// Graceful shutdown
process.once(
  "SIGINT",
  () => {
    bot.stop("SIGINT");
  }
);

process.once(
  "SIGTERM",
  () => {
    bot.stop("SIGTERM");
  }
);
