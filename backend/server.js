"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("node:crypto");

const { Telegraf, Markup } = require("telegraf");

const {
  runAgent,
  deployToVercel,
} = require("./src/agent/agent");

// ============================================================
// AURA BACKEND + TELEGRAM BOT
// ============================================================

// ------------------------------------------------------------
// Telegram token
// ------------------------------------------------------------

const BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  throw new Error(
    "TELEGRAM_BOT_TOKEN is missing."
  );
}

// ------------------------------------------------------------
// Vercel integration credentials
// ------------------------------------------------------------

const VERCEL_CLIENT_ID =
  process.env.VERCEL_CLIENT_ID || "";

const VERCEL_CLIENT_SECRET =
  process.env.VERCEL_CLIENT_SECRET || "";

const VERCEL_CALLBACK_URL =
  process.env.VERCEL_CALLBACK_URL ||
  "https://aura-telebot.onrender.com/vercel/callback";

// ------------------------------------------------------------
// Render port
// ------------------------------------------------------------

const PORT =
  Number(process.env.PORT) || 10000;

const HOST = "0.0.0.0";

// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.use(
  cors({
    origin: "*",
  })
);

app.use(
  express.json({
    limit: "10mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb",
  })
);

// ============================================================
// TELEGRAM BOT
// ============================================================

const bot =
  new Telegraf(BOT_TOKEN);

// ============================================================
// USER SESSION
// ============================================================

/*
Each Telegram user gets a session.

userId
  ↓
project
  ↓
Vercel connection
  ↓
deploy
*/

const users =
  new Map();

/*
OAuth state is temporary.

state
  ↓
Telegram user
*/

const oauthStates =
  new Map();

// ============================================================
// SESSION HELPER
// ============================================================

function getUser(userId) {
  const id =
    String(userId);

  if (!users.has(id)) {
    users.set(id, {
      userId: id,

      busy: false,

      projectName: null,

      projectRoot: null,

      projectFiles: [],

      vercel: {
        connected: false,

        accessToken: null,

        refreshToken: null,

        expiresAt: 0,

        teamId: null,

        configurationId: null,

        user: null,
      },
    });
  }

  return users.get(id);
}

// ============================================================
// ESCAPE TELEGRAM HTML
// ============================================================

function escapeTelegram(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================
// ESCAPE BROWSER HTML
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
// VERCEL CONFIG
// ============================================================

function hasVercelConfig() {
  return Boolean(
    VERCEL_CLIENT_ID &&
    VERCEL_CLIENT_SECRET &&
    VERCEL_CALLBACK_URL
  );
}

// ============================================================
// OAUTH STATE
// ============================================================

function createOAuthState() {
  return crypto
    .randomBytes(32)
    .toString("hex");
}

// ============================================================
// BUILD VERCEL INSTALL URL
// ============================================================

function buildVercelInstallUrl(
  telegramUserId
) {
  if (!hasVercelConfig()) {
    throw new Error(
      "Vercel integration credentials are not configured."
    );
  }

  const state =
    createOAuthState();

  oauthStates.set(
    state,
    {
      telegramUserId:
        String(telegramUserId),

      createdAt:
        Date.now(),
    }
  );

  /*
   * Native Vercel integration installation.
   *
   * The integration slug is the slug you created:
   * aura-agent
   */
  const url =
    new URL(
      "https://vercel.com/integrations/aura-agent/new"
    );

  url.searchParams.set(
    "state",
    state
  );

  url.searchParams.set(
    "source",
    "external"
  );

  /*
   * We use the registered integration redirect URL.
   *
   * Vercel will provide code/state and installation metadata.
   */

  return url.toString();
}

// ============================================================
// EXCHANGE VERCEL CODE
// ============================================================

async function exchangeVercelCode(
  code
) {
  if (!hasVercelConfig()) {
    throw new Error(
      "Vercel integration credentials are missing."
    );
  }

  const body =
    new URLSearchParams();

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

  const response =
    await fetch(
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

  const text =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    throw new Error(
      `Vercel token exchange failed (${response.status}): ${
        data?.error?.message ||
        data?.error ||
        text
      }`
    );
  }

  return data;
}

// ============================================================
// VERCEL USER
// ============================================================

async function getVercelUser(
  accessToken
) {
  const response =
    await fetch(
      "https://api.vercel.com/v2/user",
      {
        method: "GET",

        headers: {
          Authorization:
            `Bearer ${accessToken}`,
        },
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    throw new Error(
      `Vercel user request failed (${response.status}): ${
        data?.error?.message ||
        text
      }`
    );
  }

  return (
    data?.user ||
    data
  );
}

// ============================================================
// TELEGRAM KEYBOARD
// ============================================================

function getProjectKeyboard(
  session
) {
  const rows = [];

  if (
    session.vercel.connected
  ) {
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

  return Markup.inlineKeyboard(
    rows
  );
}

// ============================================================
// ROOT
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.status(200).json({
      success: true,

      service:
        "aura-telegram-bot",

      status:
        "online",

      telegram:
        true,

      agent:
        true,

      vercelConfigured:
        hasVercelConfig(),

      timestamp:
        new Date().toISOString(),
    });
  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {
    res.status(200).json({
      success: true,

      status:
        "healthy",

      service:
        "aura-agent",

      agentLoaded:
        typeof runAgent ===
        "function",

      telegramBot:
        true,

      vercelConfigured:
        hasVercelConfig(),

      timestamp:
        new Date().toISOString(),
    });
  }
);

// ============================================================
// STATUS
// ============================================================

app.get(
  "/api/status",
  (req, res) => {
    res.status(200).json({
      success: true,

      service:
        "aura-agent",

      agentLoaded:
        typeof runAgent ===
        "function",

      telegramBot:
        true,

      vercelConfigured:
        hasVercelConfig(),

      environment:
        process.env.NODE_ENV ||
        "production",

      timestamp:
        new Date().toISOString(),
    });
  }
);

// ============================================================
// API AGENT
// ============================================================

app.post(
  "/api/agent",
  async (req, res) => {
    try {
      if (
        typeof runAgent !==
        "function"
      ) {
        return res
          .status(503)
          .json({
            success: false,

            error:
              "AURA agent is unavailable.",
          });
      }

      const request =
        req.body?.prompt ||
        req.body?.request ||
        req.body?.message ||
        "";

      if (
        !String(request).trim()
      ) {
        return res
          .status(400)
          .json({
            success: false,

            error:
              "prompt/request/message is required.",
          });
      }

      console.log(
        "\n=========================================="
      );

      console.log(
        "🤖 AURA API REQUEST"
      );

      console.log(
        "=========================================="
      );

      const result =
        await runAgent(
          String(request)
        );

      return res
        .status(200)
        .json({
          success:
            true,

          result,
        });
    } catch (error) {
      console.error(
        "❌ AURA API error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,

          error:
            error?.message ||
            "Agent execution failed.",
        });
    }
  }
);

// ============================================================
// EULA
// ============================================================

app.get(
  "/eula",
  (req, res) => {
    res.type("html");

    res.send(`
<!DOCTYPE html>
<html lang="en">

<head>
<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
/>

<title>AURA Agent - EULA</title>

<style>
body {
  margin: 0;
  padding: 40px 20px;
  font-family: Arial, sans-serif;
  line-height: 1.7;
  background: #080b12;
  color: #e5e7eb;
}

main {
  max-width: 900px;
  margin: 0 auto;
}

h1,
h2 {
  color: #ffffff;
}

p {
  color: #b7c0d0;
}
</style>
</head>

<body>

<main>

<h1>AURA Agent End User License Agreement</h1>

<p>
Last updated: August 16, 2026
</p>

<h2>1. Acceptance</h2>

<p>
By using AURA Agent, you agree to this End User License Agreement.
If you do not agree to these terms, do not use the service.
</p>

<h2>2. Service</h2>

<p>
AURA Agent is an AI-powered Telegram service that generates
websites using HTML, CSS and JavaScript and can deploy
authorized websites to the user's Vercel account.
</p>

<h2>3. Vercel Authorization</h2>

<p>
Users explicitly authorize Vercel access before deployment.
AURA only uses the permissions granted through the Vercel integration.
</p>

<h2>4. User Responsibility</h2>

<p>
Users are responsible for the content they request, the generated
website, and deployments made to their Vercel account.
</p>

<h2>5. AI Generated Content</h2>

<p>
Generated code should be reviewed by the user before use in production.
</p>

<h2>6. Availability</h2>

<p>
AURA Agent is provided on an availability basis and may experience
temporary interruptions.
</p>

<h2>7. Limitation of Liability</h2>

<p>
To the extent permitted by law, the developer is not liable for
losses resulting from generated content or deployments.
</p>

<h2>8. Changes</h2>

<p>
These terms may be updated from time to time.
</p>

<h2>9. Contact</h2>

<p>
Contact the AURA Agent developer using the support contact
associated with the integration.
</p>

</main>

</body>
</html>
`);
  }
);

// ============================================================
// PRIVACY
// ============================================================

app.get(
  "/privacy",
  (req, res) => {
    res.type("html");

    res.send(`
<!DOCTYPE html>
<html lang="en">

<head>
<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
/>

<title>AURA Agent - Privacy Policy</title>

<style>
body {
  margin: 0;
  padding: 40px 20px;
  font-family: Arial, sans-serif;
  line-height: 1.7;
  background: #080b12;
  color: #e5e7eb;
}

main {
  max-width: 900px;
  margin: 0 auto;
}

h1,
h2 {
  color: #ffffff;
}

p {
  color: #b7c0d0;
}
</style>
</head>

<body>

<main>

<h1>AURA Agent Privacy Policy</h1>

<p>
Last updated: August 16, 2026
</p>

<h2>1. Information</h2>

<p>
AURA may process Telegram user identifiers and website requests
needed to provide the service.
</p>

<h2>2. Vercel Authorization</h2>

<p>
When a user connects Vercel, AURA processes the authorization
information required to perform the deployment requested by the user.
</p>

<h2>3. Website Content</h2>

<p>
Website prompts and generated website files may be processed
through configured AI providers to provide website generation.
</p>

<h2>4. Security</h2>

<p>
Credentials are intended to be handled server-side and should
not be exposed through Telegram messages or generated websites.
</p>

<h2>5. Third Parties</h2>

<p>
The service may communicate with AI providers and Vercel to
perform requested functionality.
</p>

<h2>6. Data Retention</h2>

<p>
Temporary session information may be stored while the bot is running.
Future persistent storage will follow an updated privacy policy.
</p>

<h2>7. Contact</h2>

<p>
Contact the AURA Agent developer using the support contact
associated with the integration.
</p>

</main>

</body>
</html>
`);
  }
);

// ============================================================
// VERCEL CALLBACK
// ============================================================

app.get(
  "/vercel/callback",
  async (req, res) => {
    try {
      console.log(
        "\n=========================================="
      );

      console.log(
        "🔐 VERCEL CALLBACK"
      );

      console.log(
        "=========================================="
      );

      const {
        code,
        state,
        teamId,
        configurationId,
        next,
        error,
        error_description,
      } = req.query;

      console.log(
        "Code:",
        Boolean(code)
      );

      console.log(
        "State:",
        Boolean(state)
      );

      console.log(
        "Team ID:",
        teamId ||
          "none"
      );

      console.log(
        "Configuration ID:",
        configurationId ||
          "none"
      );

      // --------------------------------------------------------
      // Vercel reported an error
      // --------------------------------------------------------

      if (error) {
        return res
          .status(400)
          .send(`
<!DOCTYPE html>

<html>

<head>
<meta charset="UTF-8">
<title>AURA - Vercel Error</title>
</head>

<body
style="
font-family:Arial;
background:#080b12;
color:white;
padding:50px;
text-align:center;
"
>

<h1>❌ Vercel authorization failed</h1>

<p>
${escapeHtml(
  error_description ||
    error
)}
</p>

<p>
Return to Telegram and try again.
</p>

</body>

</html>
`);
      }

      // --------------------------------------------------------
      // Validate code/state
      // --------------------------------------------------------

      if (
        !code ||
        !state
      ) {
        return res
          .status(400)
          .send(
            "Missing Vercel code or state."
          );
      }

      // --------------------------------------------------------
      // Find Telegram user
      // --------------------------------------------------------

      const oauth =
        oauthStates.get(
          state
        );

      if (!oauth) {
        return res
          .status(400)
          .send(
            "Invalid or expired OAuth state."
          );
      }

      // One-time state.
      oauthStates.delete(
        state
      );

      // 10-minute expiration.
      if (
        Date.now() -
          oauth.createdAt >
        10 * 60 * 1000
      ) {
        return res
          .status(400)
          .send(
            "OAuth session expired."
          );
      }

      const session =
        getUser(
          oauth.telegramUserId
        );

      // --------------------------------------------------------
      // Exchange code
      // --------------------------------------------------------

      console.log(
        "🔄 Exchanging Vercel code for access token..."
      );

      const token =
        await exchangeVercelCode(
          code
        );

      if (
        !token?.access_token
      ) {
        throw new Error(
          "Vercel did not return an access token."
        );
      }

      // --------------------------------------------------------
      // Save Vercel authorization
      // --------------------------------------------------------

      session.vercel.accessToken =
        token.access_token;

      session.vercel.refreshToken =
        token.refresh_token ||
        null;

      session.vercel.expiresAt =
        Date.now() +
        Number(
          token.expires_in ||
            3600
        ) *
          1000;

      session.vercel.teamId =
        teamId ||
        token.team_id ||
        null;

      session.vercel.configurationId =
        configurationId ||
        null;

      session.vercel.connected =
        true;

      // --------------------------------------------------------
      // Get current Vercel user
      // --------------------------------------------------------

      try {
        session.vercel.user =
          await getVercelUser(
            session.vercel.accessToken
          );
      } catch (error) {
        console.log(
          "⚠️ Could not read Vercel user:"
        );

        console.log(
          error.message
        );

        session.vercel.user =
          null;
      }

      const username =
        session.vercel.user
          ?.username ||
        session.vercel.user
          ?.name ||
        "Vercel account";

      console.log(
        "✅ Vercel authorization stored."
      );

      console.log(
        `👤 Telegram user: ${oauth.telegramUserId}`
      );

      console.log(
        `👤 Vercel user: ${username}`
      );

      // --------------------------------------------------------
      // Send Telegram message
      // --------------------------------------------------------

      try {
        if (
          session.projectRoot
        ) {
          await bot.telegram.sendMessage(
            oauth.telegramUserId,

            "✅ <b>VERCEL CONNECTED</b>\n\n" +
              `👤 Account: <b>${escapeTelegram(
                username
              )}</b>\n\n` +
              `📦 Project: <b>${escapeTelegram(
                session.projectName ||
                  "Website"
              )}</b>\n\n` +
              "Your Vercel account is connected.\n" +
              "Click the button below to deploy.",

            {
              parse_mode:
                "HTML",

              ...getProjectKeyboard(
                session
              ),
            }
          );
        } else {
          await bot.telegram.sendMessage(
            oauth.telegramUserId,

            "✅ <b>VERCEL CONNECTED</b>\n\n" +
              `👤 Account: <b>${escapeTelegram(
                username
              )}</b>\n\n` +
              "Your Vercel account is now connected.\n\n" +
              "Send me a website request to generate a site.",

            {
              parse_mode:
                "HTML",
            }
          );
        }
      } catch (
        telegramError
      ) {
        console.error(
          "❌ Telegram notification failed:"
        );

        console.error(
          telegramError
        );
      }

      // --------------------------------------------------------
      // Browser response
      // --------------------------------------------------------

      /*
       * If Vercel supplied `next`, the integration flow can
       * eventually return to the Vercel installation UI.
       *
       * For our Telegram flow, the user can simply close
       * this page and return to Telegram.
       */

      return res
        .status(200)
        .send(`
<!DOCTYPE html>

<html>

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width, initial-scale=1.0"
/>

<title>AURA - Vercel Connected</title>

</head>

<body
style="
margin:0;
min-height:100vh;
display:flex;
align-items:center;
justify-content:center;
font-family:Arial,sans-serif;
background:#080b12;
color:white;
"
>

<div
style="
width:min(520px,90%);
text-align:center;
padding:40px;
border-radius:24px;
background:#111827;
"
>

<div
style="
font-size:64px;
margin-bottom:20px;
"
>
✅
</div>

<h1>
Vercel Connected
</h1>

<p
style="
color:#aeb7c8;
line-height:1.7;
"
>
Your Vercel account has been connected to AURA.
</p>

<p
style="
color:#aeb7c8;
line-height:1.7;
"
>
Return to Telegram to continue.
</p>

<p
style="
color:#667085;
font-size:14px;
"
>
You can close this browser tab.
</p>

</div>

</body>

</html>
`);
    } catch (error) {
      console.error(
        "\n❌ VERCEL CALLBACK ERROR:"
      );

      console.error(
        error
      );

      return res
        .status(500)
        .send(`
<!DOCTYPE html>

<html>

<head>
<meta charset="UTF-8">
<title>AURA Error</title>
</head>

<body
style="
font-family:Arial;
padding:40px;
background:#080b12;
color:white;
"
>

<h1>
❌ Vercel connection failed
</h1>

<p>
${escapeHtml(
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

// ============================================================
// TELEGRAM /start
// ============================================================

bot.start(
  async (ctx) => {
    getUser(
      ctx.from.id
    );

    await ctx.reply(
      "🤖 <b>AURA</b>\n\n" +
        "Describe the website you want.\n\n" +
        "AURA generates:\n" +
        "• HTML\n" +
        "• CSS\n" +
        "• JavaScript\n\n" +
        "No React.\n" +
        "No Vite.\n" +
        "No npm build.\n\n" +
        "After generation, connect Vercel and deploy.",

      {
        parse_mode:
          "HTML",
      }
    );
  }
);

// ============================================================
// TELEGRAM /help
// ============================================================

bot.help(
  async (ctx) => {
    await ctx.reply(
      "🤖 <b>AURA Commands</b>\n\n" +
        "/start — Start AURA\n" +
        "/help — Help\n" +
        "/vercel — Connect Vercel\n" +
        "/status — Status\n\n" +
        "Or send a website request directly.",

      {
        parse_mode:
          "HTML",
      }
    );
  }
);

// ============================================================
// TELEGRAM /vercel
// ============================================================

bot.command(
  "vercel",
  async (ctx) => {
    if (
      !hasVercelConfig()
    ) {
      await ctx.reply(
        "❌ Vercel integration is not configured on Render.\n\n" +
          "Required:\n" +
          "VERCEL_CLIENT_ID\n" +
          "VERCEL_CLIENT_SECRET\n" +
          "VERCEL_CALLBACK_URL"
      );

      return;
    }

    try {
      const url =
        buildVercelInstallUrl(
          ctx.from.id
        );

      await ctx.reply(
        "🔗 <b>Connect Vercel</b>\n\n" +
          "Authorize AURA to deploy websites to your Vercel account.",

        {
          parse_mode:
            "HTML",

          ...Markup.inlineKeyboard([
            [
              Markup.button.url(
                "🔗 Connect Vercel",
                url
              ),
            ],
          ]),
        }
      );
    } catch (error) {
      console.error(
        error
      );

      await ctx.reply(
        "❌ Could not start Vercel connection."
      );
    }
  }
);

// ============================================================
// TELEGRAM /status
// ============================================================

bot.command(
  "status",
  async (ctx) => {
    const session =
      getUser(
        ctx.from.id
      );

    await ctx.reply(
      "🤖 <b>AURA Status</b>\n\n" +
        `📦 Project: ${
          session.projectName ||
          "None"
        }\n` +
        `🔐 Vercel: ${
          session.vercel.connected
            ? "🟢 Connected"
            : "🔴 Not connected"
        }\n` +
        `🤖 Agent: ${
          typeof runAgent ===
          "function"
            ? "🟢 Ready"
            : "🔴 Error"
        }`,

      {
        parse_mode:
          "HTML",
      }
    );
  }
);

// ============================================================
// TELEGRAM CONNECT BUTTON
// ============================================================

bot.action(
  "connect_vercel",
  async (ctx) => {
    await ctx.answerCbQuery();

    if (
      !hasVercelConfig()
    ) {
      await ctx.reply(
        "❌ Vercel integration is not configured on Render."
      );

      return;
    }

    try {
      const url =
        buildVercelInstallUrl(
          ctx.from.id
        );

      await ctx.reply(
        "🔐 <b>Connect your Vercel account</b>\n\n" +
          "Click below and authorize AURA.",

        {
          parse_mode:
            "HTML",

          ...Markup.inlineKeyboard([
            [
              Markup.button.url(
                "🔗 Authorize Vercel",
                url
              ),
            ],
          ]),
        }
      );
    } catch (error) {
      console.error(
        error
      );

      await ctx.reply(
        "❌ Could not create the Vercel authorization link."
      );
    }
  }
);

// ============================================================
// TELEGRAM DEPLOY BUTTON
// ============================================================

bot.action(
  "deploy",
  async (ctx) => {
    await ctx.answerCbQuery(
      "Starting deployment..."
    );

    const session =
      getUser(
        ctx.from.id
      );

    if (
      session.busy
    ) {
      await ctx.reply(
        "⏳ AURA is already processing your request."
      );

      return;
    }

    if (
      !session.projectRoot
    ) {
      await ctx.reply(
        "❌ No generated website is available."
      );

      return;
    }

    if (
      !session.vercel.connected ||
      !session.vercel.accessToken
    ) {
      await ctx.reply(
        "🔴 Connect your Vercel account first.",

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

    session.busy =
      true;

    try {
      await ctx.reply(
        "🚀 <b>Deploying your website...</b>\n\n" +
          "Please wait.",

        {
          parse_mode:
            "HTML",
        }
      );

      const result =
        await deployToVercel(
          session.projectRoot,

          session.projectName,

          session.vercel.accessToken,

          session.vercel.teamId
        );

      if (
        !result ||
        !result.success
      ) {
        throw new Error(
          result?.reason ||
            "Vercel deployment failed."
        );
      }

      await ctx.reply(
        "🎉 <b>DEPLOYMENT SUCCESSFUL</b>\n\n" +
          `📦 Project: <b>${escapeTelegram(
            session.projectName
          )}</b>\n\n` +
          "🌐 <b>Live URL:</b>\n" +
          `<a href="${escapeTelegram(
            result.url
          )}">${escapeTelegram(
            result.url
          )}</a>`,

        {
          parse_mode:
            "HTML",

          disable_web_page_preview:
            false,
        }
      );
    } catch (error) {
      console.error(
        "\n❌ DEPLOYMENT ERROR:"
      );

      console.error(
        error
      );

      await ctx.reply(
        "❌ <b>DEPLOYMENT FAILED</b>\n\n" +
          `<code>${escapeTelegram(
            error?.message ||
              "Unknown deployment error"
          )}</code>`,

        {
          parse_mode:
            "HTML",
        }
      );
    } finally {
      session.busy =
        false;
    }
  }
);

// ============================================================
// TELEGRAM TEXT → AURA
// ============================================================

bot.on(
  "text",
  async (ctx) => {
    const text =
      String(
        ctx.message?.text ||
          ""
      ).trim();

    if (
      !text
    ) {
      return;
    }

    if (
      text.startsWith("/")
    ) {
      return;
    }

    const session =
      getUser(
        ctx.from.id
      );

    if (
      session.busy
    ) {
      await ctx.reply(
        "⏳ AURA is already working on your previous request."
      );

      return;
    }

    session.busy =
      true;

    try {
      await ctx.reply(
        "🧠 <b>AURA is generating your website...</b>\n\n" +
          "HTML + CSS + JavaScript only.",

        {
          parse_mode:
            "HTML",
        }
      );

      const result =
        await runAgent(
          text
        );

      if (
        !result?.success
      ) {
        throw new Error(
          "AURA could not complete the website generation."
        );
      }

      session.projectName =
        result.projectName;

      session.projectRoot =
        result.projectRoot;

      session.projectFiles =
        result.files ||
        [];

      await ctx.reply(
        "✅ <b>WEBSITE READY</b>\n\n" +
          `📦 Project: <b>${escapeTelegram(
            result.projectName
          )}</b>\n\n` +
          "📄 Generated:\n" +
          "• index.html\n" +
          "• style.css\n" +
          "• script.js\n\n" +
          "🔍 Validation: ✅ Passed\n" +
          "🏗️ Build: ✅ Static validation\n" +
          "⚛️ React: ❌ Not used\n" +
          "⚡ Vite: ❌ Not used\n" +
          "📦 npm: ❌ Not required\n\n" +
          (
            session.vercel.connected
              ? "🟢 Vercel is connected."
              : "🔴 Connect your Vercel account to deploy."
          ),

        {
          parse_mode:
            "HTML",

          ...getProjectKeyboard(
            session
          ),
        }
      );
    } catch (error) {
      console.error(
        "\n❌ AURA GENERATION ERROR:"
      );

      console.error(
        error
      );

      await ctx.reply(
        "❌ <b>WEBSITE GENERATION FAILED</b>\n\n" +
          `<code>${escapeTelegram(
            error?.message ||
              "Unknown error"
          )}</code>`,

        {
          parse_mode:
            "HTML",
        }
      );
    } finally {
      session.busy =
        false;
    }
  }
);

// ============================================================
// TELEGRAM ERROR HANDLER
// ============================================================

bot.catch(
  (error) => {
    console.error(
      "\n❌ TELEGRAM ERROR:"
    );

    console.error(
      error
    );
  }
);

// ============================================================
// EXPRESS ERROR HANDLER
// ============================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "\n❌ EXPRESS ERROR:"
    );

    console.error(
      error
    );

    if (
      res.headersSent
    ) {
      return next(
        error
      );
    }

    res.status(
      500
    ).json({
      success:
        false,

      error:
        error?.message ||
        "Internal server error",
    });
  }
);

// ============================================================
// UNKNOWN ROUTE
// ============================================================

app.use(
  (req, res) => {
    res.status(
      404
    ).json({
      success:
        false,

      error:
        "Route not found",

      path:
        req.originalUrl,
    });
  }
);

// ============================================================
// START SERVER
// ============================================================

const server =
  app.listen(
    PORT,
    HOST,
    async () => {
      console.log("");
      console.log(
        "=========================================="
      );

      console.log(
        "🚀 AURA BACKEND + TELEGRAM STARTED"
      );

      console.log(
        "=========================================="
      );

      console.log(
        `🌐 Host: ${HOST}`
      );

      console.log(
        `🔌 Port: ${PORT}`
      );

      console.log(
        `🤖 Agent loaded: ${
          typeof runAgent ===
          "function"
        }`
      );

      console.log(
        `📱 Telegram bot: enabled`
      );

      console.log(
        `🔐 Vercel integration: ${
          hasVercelConfig()
            ? "configured"
            : "NOT CONFIGURED"
        }`
      );

      console.log(
        `🔗 Callback: ${
          VERCEL_CALLBACK_URL
        }`
      );

      console.log(
        "=========================================="
      );

      try {
        await bot.launch();

        console.log(
          "✅ Telegram polling started."
        );
      } catch (
        telegramError
      ) {
        console.error(
          "❌ Telegram bot failed to start:"
        );

        console.error(
          telegramError
        );
      }
    }
  );

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

function shutdown(
  signal
) {
  console.log(
    `\n🛑 ${signal} received.`
  );

  bot.stop(
    signal
  );

  server.close(
    () => {
      console.log(
        "✅ AURA server stopped."
      );

      process.exit(
        0
      );
    }
  );

  setTimeout(
    () => {
      console.error(
        "⚠️ Forced shutdown."
      );

      process.exit(
        1
      );
    },
    10000
  );
}

process.once(
  "SIGINT",
  () => {
    shutdown(
      "SIGINT"
    );
  }
);

process.once(
  "SIGTERM",
  () => {
    shutdown(
      "SIGTERM"
    );
  }
);

// ============================================================
// PROCESS ERROR HANDLERS
// ============================================================

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "❌ Unhandled Promise Rejection:"
    );

    console.error(
      error
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "❌ Uncaught Exception:"
    );

    console.error(
      error
    );
  }
);
