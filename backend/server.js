"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("node:crypto");

const {
  Telegraf,
  Markup,
} = require("telegraf");

const {
  runAgent,
  deployToVercel,
} = require("./src/agent/agent");

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const VERCEL_CLIENT_ID =
  process.env.VERCEL_CLIENT_ID || "";

const VERCEL_CLIENT_SECRET =
  process.env.VERCEL_CLIENT_SECRET || "";

const VERCEL_CALLBACK_URL =
  process.env.VERCEL_CALLBACK_URL ||
  "https://aura-telebot.onrender.com/vercel/callback";

const PORT =
  Number(process.env.PORT) || 10000;

const HOST = "0.0.0.0";

// ============================================================
// VALIDATE TELEGRAM TOKEN
// ============================================================

if (!BOT_TOKEN) {
  throw new Error(
    "TELEGRAM_BOT_TOKEN is missing from environment variables."
  );
}

// ============================================================
// EXPRESS APP
// ============================================================

const app = express();

app.use(
  cors({
    origin: "*",
    methods: [
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
    ],
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
// USER SESSION STORAGE
// ============================================================

const users = new Map();

/*
Session:

userId
projectName
projectRoot
projectDir
projectFiles

vercel:
  connected
  accessToken
  refreshToken
  expiresAt
  teamId
  configurationId
  user
*/

function getUser(userId) {
  const id =
    String(userId);

  if (!users.has(id)) {
    users.set(id, {
      userId: id,

      busy: false,

      projectName: null,

      projectRoot: null,

      projectDir: null,

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
// ESCAPE NORMAL HTML
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

function isVercelConfigured() {
  return Boolean(
    VERCEL_CLIENT_ID &&
    VERCEL_CLIENT_SECRET &&
    VERCEL_CALLBACK_URL
  );
}

// ============================================================
// OAUTH STATES
// ============================================================

const oauthStates = new Map();

function createOAuthState() {
  return crypto
    .randomBytes(32)
    .toString("hex");
}

// ============================================================
// VERCEL INTEGRATION URL
// ============================================================

function createVercelConnectUrl(
  telegramUserId
) {
  if (!isVercelConfigured()) {
    throw new Error(
      "Vercel integration is not configured."
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

  const url =
    new URL(
      "https://vercel.com/integrations/aura-agent/new"
    );

  url.searchParams.set(
    "state",
    state
  );

  return url.toString();
}

// ============================================================
// VERCEL TOKEN EXCHANGE
// ============================================================

async function exchangeVercelCode(
  code
) {
  if (!isVercelConfigured()) {
    throw new Error(
      "Vercel integration credentials are not configured."
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
// GET VERCEL USER
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
// TELEGRAM BUTTONS
// ============================================================

function getWebsiteKeyboard(
  session
) {
  if (
    session.vercel.connected
  ) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "🚀 Deploy to Vercel",
          "deploy"
        ),
      ],
    ]);
  }

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🔗 Connect Vercel",
        "connect_vercel"
      ),
    ],
  ]);
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
      vercel:
        isVercelConfigured(),
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
        isVercelConfigured(),

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
        isVercelConfigured(),

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
              "AURA agent unavailable.",
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
              "Request is required.",
          });
      }

      const result =
        await runAgent(
          String(request)
        );

      return res
        .status(200)
        .json({
          success: true,
          result,
        });
    } catch (error) {
      console.error(
        "❌ API agent error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          error:
            error?.message ||
            "Agent failed.",
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
  background: #080b12;
  color: #ffffff;
  line-height: 1.7;
}

main {
  width: min(900px, 100%);
  margin: auto;
}

p {
  color: #b8c0cf;
}

h1,
h2 {
  color: white;
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
By using AURA Agent, you agree to these terms.
</p>

<h2>2. Service</h2>

<p>
AURA Agent is an AI-powered Telegram service for generating
and deploying websites.
</p>

<h2>3. Vercel</h2>

<p>
Users explicitly authorize Vercel access before deployment.
AURA uses only permissions granted by the user.
</p>

<h2>4. User Responsibility</h2>

<p>
Users are responsible for generated content and deployments
made to their Vercel account.
</p>

<h2>5. AI Content</h2>

<p>
AI-generated content should be reviewed before production use.
</p>

<h2>6. Availability</h2>

<p>
The service may occasionally be unavailable.
</p>

<h2>7. Liability</h2>

<p>
Use of the service is at the user's own risk to the extent
permitted by applicable law.
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
<title>AURA Agent - Privacy</title>

<style>
body {
  margin: 0;
  padding: 40px 20px;
  font-family: Arial, sans-serif;
  background: #080b12;
  color: #ffffff;
  line-height: 1.7;
}

main {
  width: min(900px, 100%);
  margin: auto;
}

p {
  color: #b8c0cf;
}

h1,
h2 {
  color: white;
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
AURA processes Telegram identifiers and website requests
needed to provide the service.
</p>

<h2>2. Vercel</h2>

<p>
When a user connects Vercel, authorization information is
processed to perform the user's requested deployment.
</p>

<h2>3. AI Providers</h2>

<p>
Website requests may be processed by configured AI providers
to generate website code.
</p>

<h2>4. Security</h2>

<p>
Credentials are handled server-side and should never be
included in generated website content.
</p>

<h2>5. Contact</h2>

<p>
Contact information is provided through the integration
support contact.
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
      const {
        code,
        state,
        teamId,
        configurationId,
        error,
        error_description,
      } = req.query;

      console.log("");
      console.log(
        "=========================================="
      );

      console.log(
        "🔐 VERCEL CALLBACK"
      );

      console.log(
        "=========================================="
      );

      console.log(
        "Code received:",
        Boolean(code)
      );

      console.log(
        "State received:",
        Boolean(state)
      );

      if (
        error
      ) {
        return res
          .status(400)
          .send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>AURA Vercel Error</title>
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

<h1>❌ Vercel connection failed</h1>

<p>
${escapeHtml(
  error_description ||
    error
)}
</p>

<p>
Return to Telegram.
</p>

</body>
</html>
`);
      }

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

      oauthStates.delete(
        state
      );

      if (
        Date.now() -
          oauth.createdAt >
        10 * 60 * 1000
      ) {
        return res
          .status(400)
          .send(
            "OAuth state expired."
          );
      }

      const session =
        getUser(
          oauth.telegramUserId
        );

      console.log(
        "🔄 Exchanging Vercel code..."
      );

      const tokenData =
        await exchangeVercelCode(
          code
        );

      if (
        !tokenData?.access_token
      ) {
        throw new Error(
          "No Vercel access token returned."
        );
      }

      // --------------------------------------------------------
      // STORE USER VERCEL AUTHORIZATION
      // --------------------------------------------------------

      session.vercel.connected =
        true;

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
        teamId ||
        tokenData.team_id ||
        null;

      session.vercel.configurationId =
        configurationId ||
        null;

      // --------------------------------------------------------
      // GET USER
      // --------------------------------------------------------

      try {
        session.vercel.user =
          await getVercelUser(
            session.vercel.accessToken
          );
      } catch (
        error
      ) {
        console.log(
          "⚠️ Could not retrieve Vercel profile:"
        );

        console.log(
          error.message
        );

        session.vercel.user =
          null;
      }

      const accountName =
        session.vercel.user
          ?.username ||
        session.vercel.user
          ?.name ||
        "Vercel account";

      console.log(
        "✅ Vercel account connected:"
      );

      console.log(
        accountName
      );

      // --------------------------------------------------------
      // SEND TELEGRAM MESSAGE
      // --------------------------------------------------------

      try {
        if (
          session.projectRoot ||
          session.projectDir
        ) {
          await bot.telegram.sendMessage(
            oauth.telegramUserId,

            "✅ <b>Vercel connected</b>\n\n" +
              `👤 ${escapeTelegram(
                accountName
              )}\n\n` +
              "Your website is ready to deploy.",

            {
              parse_mode:
                "HTML",

              ...getWebsiteKeyboard(
                session
              ),
            }
          );
        } else {
          await bot.telegram.sendMessage(
            oauth.telegramUserId,

            "✅ <b>Vercel connected</b>\n\n" +
              `👤 ${escapeTelegram(
                accountName
              )}\n\n` +
              "Now send me your website idea.",

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
          "❌ Failed to notify Telegram:"
        );

        console.error(
          telegramError
        );
      }

      // --------------------------------------------------------
      // BROWSER RESULT
      // --------------------------------------------------------

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
text-align:center;
"
>

<div
style="
width:min(500px,90%);
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
line-height:1.6;
"
>
Your Vercel account is connected to AURA.
</p>

<p
style="
color:#aeb7c8;
line-height:1.6;
"
>
Return to Telegram.
</p>

<p
style="
color:#667085;
font-size:14px;
"
>
You can close this tab.
</p>

</div>

</body>
</html>
`);
    } catch (
      error
    ) {
      console.error(
        "❌ Vercel callback error:"
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
background:#080b12;
color:white;
padding:50px;
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
// /START
// ============================================================

bot.start(
  async (ctx) => {
    getUser(
      ctx.from.id
    );

    await ctx.reply(
      "🤖 <b>AURA</b>\n\n" +
        "Tell me what website you want to build.\n\n" +
        "Example:\n" +
        "Create a simple portfolio\n\n" +
        "AURA will create your website and let you deploy it to Vercel.",

      {
        parse_mode:
          "HTML",
      }
    );
  }
);

// ============================================================
// /HELP
// ============================================================

bot.help(
  async (ctx) => {
    await ctx.reply(
      "🤖 <b>AURA</b>\n\n" +
        "/start\n" +
        "/help\n" +
        "/vercel\n" +
        "/status\n\n" +
        "Or just send a website request.",

      {
        parse_mode:
          "HTML",
      }
    );
  }
);

// ============================================================
// /VERCEL
// ============================================================

bot.command(
  "vercel",
  async (ctx) => {
    const session =
      getUser(
        ctx.from.id
      );

    if (
      !isVercelConfigured()
    ) {
      await ctx.reply(
        "⚠️ Vercel connection is not configured yet."
      );

      return;
    }

    try {
      const url =
        createVercelConnectUrl(
          ctx.from.id
        );

      await ctx.reply(
        "🔗 <b>Connect Vercel</b>\n\n" +
          "Connect your Vercel account to deploy your website.",

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
    } catch (
      error
    ) {
      console.error(
        error
      );

      await ctx.reply(
        "❌ Unable to start Vercel connection."
      );
    }
  }
);

// ============================================================
// /STATUS
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
        `Website: ${
          session.projectName ||
          "None"
        }\n` +
        `Vercel: ${
          session.vercel.connected
            ? "🟢 Connected"
            : "🔴 Not connected"
        }`,

      {
        parse_mode:
          "HTML",
      }
    );
  }
);

// ============================================================
// CONNECT VERCEL BUTTON
// ============================================================

bot.action(
  "connect_vercel",
  async (ctx) => {
    await ctx.answerCbQuery();

    if (
      !isVercelConfigured()
    ) {
      await ctx.reply(
        "⚠️ Vercel connection is not configured."
      );

      return;
    }

    try {
      const url =
        createVercelConnectUrl(
          ctx.from.id
        );

      await ctx.reply(
        "🔗 <b>Connect Vercel</b>\n\n" +
          "Connect your own Vercel account.",

        {
          parse_mode:
            "HTML",

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
    } catch (
      error
    ) {
      console.error(
        error
      );

      await ctx.reply(
        "❌ Unable to start Vercel connection."
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
    await ctx.answerCbQuery(
      "Deploying..."
    );

    const session =
      getUser(
        ctx.from.id
      );

    // --------------------------------------------------------
    // PROJECT CHECK
    // --------------------------------------------------------

    const projectPath =
      session.projectRoot ||
      session.projectDir ||
      null;

    if (
      !projectPath ||
      !session.projectName
    ) {
      console.error(
        "❌ Missing project:",
        {
          projectName:
            session.projectName,

          projectRoot:
            session.projectRoot,

          projectDir:
            session.projectDir,
        }
      );

      await ctx.reply(
        "❌ No generated website is available.\n\n" +
          "Please create the website again."
      );

      return;
    }

    // --------------------------------------------------------
    // VERCEL CHECK
    // --------------------------------------------------------

    if (
      !session.vercel.connected ||
      !session.vercel.accessToken
    ) {
      await ctx.reply(
        "🔴 Please connect your Vercel account first.",

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

    // --------------------------------------------------------
    // BUSY CHECK
    // --------------------------------------------------------

    if (
      session.busy
    ) {
      await ctx.reply(
        "⏳ AURA is already processing your request."
      );

      return;
    }

    session.busy =
      true;

    try {
      await ctx.reply(
        "🚀 <b>Deploying...</b>\n\n" +
          "Please wait.",

        {
          parse_mode:
            "HTML",
        }
      );

      const deployment =
        await deployToVercel(
          projectPath,

          session.projectName,

          session.vercel.accessToken,

          session.vercel.teamId
        );

      if (
        !deployment ||
        !deployment.success
      ) {
        throw new Error(
          deployment?.reason ||
            "Vercel deployment failed."
        );
      }

      await ctx.reply(
        "🎉 <b>Website is live!</b>\n\n" +
          `🌐 <a href="${escapeTelegram(
            deployment.url
          )}">${escapeTelegram(
            deployment.url
          )}</a>`,

        {
          parse_mode:
            "HTML",

          disable_web_page_preview:
            false,
        }
      );

    } catch (
      error
    ) {
      console.error(
        "❌ Deployment error:"
      );

      console.error(
        error
      );

      await ctx.reply(
        "❌ <b>Deployment failed</b>\n\n" +
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
// WEBSITE GENERATION
// ============================================================

bot.on(
  "text",
  async (ctx) => {
    const text =
      String(
        ctx.message?.text ||
          ""
      ).trim();

    if (!text) {
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
        "🧠 <b>AURA is creating your website...</b>\n\n" +
          "Please wait.",

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
        !result ||
        result.success === false
      ) {
        throw new Error(
          "AURA could not create the website."
        );
      }

      /*
       * IMPORTANT FIX:
       *
       * Different versions of agent.js have returned
       * either:
       *
       * result.projectRoot
       *
       * OR
       *
       * result.projectDir
       *
       * We accept both.
       */

      session.projectName =
        result.projectName ||
        "aura-website";

      session.projectRoot =
        result.projectRoot ||
        result.projectDir ||
        null;

      session.projectDir =
        result.projectDir ||
        result.projectRoot ||
        null;

      session.projectFiles =
        result.files ||
        [];

      console.log(
        "\n✅ Project stored in Telegram session:"
      );

      console.log(
        {
          projectName:
            session.projectName,

          projectRoot:
            session.projectRoot,

          projectDir:
            session.projectDir,
        }
      );

      // --------------------------------------------------------
      // CLEAN TELEGRAM RESPONSE
      // --------------------------------------------------------

      await ctx.reply(
        "✅ <b>Website created</b>\n\n" +
          `📦 <b>${escapeTelegram(
            session.projectName
          )}</b>\n\n` +
          (
            session.vercel.connected
              ? "Your Vercel account is connected."
              : "Connect your Vercel account to deploy."
          ),

        {
          parse_mode:
            "HTML",

          ...getWebsiteKeyboard(
            session
          ),
        }
      );

    } catch (
      error
    ) {
      console.error(
        "\n❌ AURA generation error:"
      );

      console.error(
        error
      );

      await ctx.reply(
        "❌ <b>Could not create the website.</b>\n\n" +
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
      "❌ Telegram error:"
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
      "❌ Express error:"
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

    res
      .status(500)
      .json({
        success:
          false,

        error:
          error?.message ||
          "Internal server error",
      });
  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (
    req,
    res
  ) => {
    res
      .status(404)
      .json({
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
        "🚀 AURA BACKEND + TELEGRAM"
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
        "📱 Telegram bot: enabled"
      );

      console.log(
        `🔐 Vercel: ${
          isVercelConfigured()
            ? "configured"
            : "not configured"
        }`
      );

      console.log(
        `🔗 Callback: ${
          VERCEL_CALLBACK_URL
        }`
      );

      try {
        await bot.launch();

        console.log(
          "✅ Telegram polling started."
        );

      } catch (
        error
      ) {
        console.error(
          "❌ Telegram failed to start:"
        );

        console.error(
          error
        );

        process.exit(
          1
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

  try {
    bot.stop(
      signal
    );
  } catch (
    error
  ) {
    console.error(
      error
    );
  }

  server.close(
    () => {
      console.log(
        "✅ HTTP server closed."
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
// PROCESS ERRORS
// ============================================================

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "❌ Unhandled rejection:"
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
      "❌ Uncaught exception:"
    );

    console.error(
      error
    );
  }
);
