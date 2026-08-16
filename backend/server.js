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
// CONFIG
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

const HOST =
  "0.0.0.0";

if (!BOT_TOKEN) {
  throw new Error(
    "TELEGRAM_BOT_TOKEN is missing."
  );
}

// ============================================================
// EXPRESS SERVER
// ============================================================

const app =
  express();

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
  new Telegraf(
    BOT_TOKEN
  );

// ============================================================
// USER SESSIONS
// ============================================================

const users =
  new Map();

const oauthStates =
  new Map();

// ============================================================
// USER SESSION
// ============================================================

function getUser(userId) {
  const id =
    String(userId);

  if (!users.has(id)) {
    users.set(
      id,
      {
        userId: id,

        busy: false,

        projectName: null,

        projectRoot: null,

        projectDir: null,

        projectFiles: [],

        siteSlug: null,

        awaitingSiteSlug: false,

        vercel: {
          connected: false,

          accessToken: null,

          refreshToken: null,

          expiresAt: 0,

          teamId: null,

          configurationId: null,

          user: null,
        },
      }
    );
  }

  return users.get(id);
}

// ============================================================
// TELEGRAM HTML ESCAPE
// ============================================================

function escapeTelegram(value) {
  return String(value || "")
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    );
}

// ============================================================
// BROWSER HTML ESCAPE
// ============================================================

function escapeHtml(value) {
  return String(value || "")
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}

// ============================================================
// SITE SLUG
// ============================================================

function sanitizeSiteSlug(input) {
  let slug =
    String(input || "")
      .trim()
      .toLowerCase();

  /*
   * Accept:
   *
   * asif-portfolio
   *
   * asif-portfolio.vercel.app
   *
   * https://asif-portfolio.vercel.app
   */

  slug =
    slug.replace(
      /^https?:\/\//i,
      ""
    );

  slug =
    slug.replace(
      /^www\./i,
      ""
    );

  slug =
    slug.replace(
      /\.vercel\.app.*$/i,
      ""
    );

  slug =
    slug.split("/")[0];

  slug =
    slug.replace(
      /[^a-z0-9-]+/g,
      "-"
    );

  slug =
    slug.replace(
      /-+/g,
      "-"
    );

  slug =
    slug.replace(
      /^-+/,
      ""
    );

  slug =
    slug.replace(
      /-+$/,
      ""
    );

  if (!slug) {
    return null;
  }

  if (slug.length > 60) {
    slug =
      slug.slice(
        0,
        60
      );
  }

  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(
      slug
    )
  ) {
    return null;
  }

  return slug;
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
// OAUTH STATE
// ============================================================

function createOAuthState() {
  return crypto
    .randomBytes(32)
    .toString("hex");
}

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

async function exchangeVercelCode(code) {
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
// TELEGRAM KEYBOARDS
// ============================================================

function connectKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🔗 Connect Vercel",
        "connect_vercel"
      ),
    ],
  ]);
}

function deployKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🚀 Deploy to Vercel",
        "deploy"
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
        typeof runAgent ===
        "function",

      vercelConfigured:
        isVercelConfigured(),

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
        !String(
          request
        ).trim()
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Request is required.",
          });
      }

      console.log(
        "🤖 API agent request received."
      );

      const result =
        await runAgent(
          String(
            request
          )
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

<title>AURA Agent EULA</title>

<style>

body {
  margin: 0;
  padding: 40px 20px;
  font-family: Arial, sans-serif;
  line-height: 1.7;
  background: #080b12;
  color: #ffffff;
}

main {
  width: min(900px, 100%);
  margin: auto;
}

h1,
h2 {
  color: #ffffff;
}

p {
  color: #b8c0cf;
}

</style>

</head>

<body>

<main>

<h1>
AURA Agent End User License Agreement
</h1>

<p>
Last updated: August 16, 2026
</p>

<h2>
1. Acceptance
</h2>

<p>
By using AURA Agent, you agree to these terms.
</p>

<h2>
2. Service
</h2>

<p>
AURA Agent is an AI-powered Telegram service for
creating and deploying websites.
</p>

<h2>
3. Vercel Authorization
</h2>

<p>
Users authorize their Vercel account before deployment.
</p>

<h2>
4. User Responsibility
</h2>

<p>
Users are responsible for the content and websites they create.
</p>

<h2>
5. AI Generated Content
</h2>

<p>
Users should review generated code before production use.
</p>

<h2>
6. Availability
</h2>

<p>
AURA Agent may occasionally be unavailable.
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

<title>AURA Agent Privacy</title>

<style>

body {
  margin: 0;
  padding: 40px 20px;
  font-family: Arial, sans-serif;
  line-height: 1.7;
  background: #080b12;
  color: #ffffff;
}

main {
  width: min(900px, 100%);
  margin: auto;
}

h1,
h2 {
  color: #ffffff;
}

p {
  color: #b8c0cf;
}

</style>

</head>

<body>

<main>

<h1>
AURA Agent Privacy Policy
</h1>

<p>
Last updated: August 16, 2026
</p>

<h2>
1. Information
</h2>

<p>
AURA may process Telegram identifiers and website requests
necessary to provide the service.
</p>

<h2>
2. Vercel
</h2>

<p>
Vercel authorization information is processed to perform
deployments requested by users.
</p>

<h2>
3. AI Providers
</h2>

<p>
Website prompts may be processed by configured AI providers.
</p>

<h2>
4. Security
</h2>

<p>
Credentials are handled server-side.
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

      if (error) {
        return res
          .status(400)
          .send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>AURA Vercel Error</title>
</head>

<body style="
font-family:Arial;
background:#080b12;
color:white;
padding:50px;
text-align:center;
">

<h1>
❌ Vercel connection failed
</h1>

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
          "Vercel did not return an access token."
        );
      }

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

      try {
        session.vercel.user =
          await getVercelUser(
            session.vercel.accessToken
          );
      } catch (error) {
        console.log(
          "⚠️ Could not retrieve Vercel profile."
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
        `✅ Vercel connected: ${accountName}`
      );

      // --------------------------------------------------------
      // TELEGRAM MESSAGE AFTER OAUTH
      // --------------------------------------------------------

      try {
        if (
          session.projectRoot ||
          session.projectDir
        ) {
          session.awaitingSiteSlug =
            true;

          await bot.telegram.sendMessage(
            oauth.telegramUserId,

            "✅ <b>Vercel connected!</b>\n\n" +
              `👤 ${escapeTelegram(
                accountName
              )}\n\n` +
              "🌐 <b>Now enter your website URL name.</b>\n\n" +
              "Example:\n" +
              "<code>asif-portfolio</code>\n\n" +
              "Your website will become:\n" +
              "<code>https://asif-portfolio.vercel.app</code>",

            {
              parse_mode:
                "HTML",
            }
          );
        } else {
          await bot.telegram.sendMessage(
            oauth.telegramUserId,

            "✅ <b>Vercel connected!</b>\n\n" +
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
          "❌ Telegram callback notification failed:"
        );

        console.error(
          telegramError
        );
      }

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
"
>
Return to Telegram.
</p>

</div>

</body>

</html>
`);
    } catch (error) {
      console.error(
        "❌ Vercel callback error:",
        error
      );

      return res
        .status(500)
        .send(`
<!DOCTYPE html>

<html>

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
Return to Telegram.
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
        "Tell me what you want to build.\n\n" +
        "Example:\n" +
        "<code>Create a modern Amazon-style store</code>\n\n" +
        "I'll turn your idea into a complete website.",

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
        "Or simply send your website idea.",

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
          "Authorize your Vercel account so AURA can deploy your website.",

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
        `URL: ${
          session.siteSlug
            ? `https://${session.siteSlug}.vercel.app`
            : "Not selected"
        }\n` +
        `Vercel: ${
          session.vercel.connected
            ? "🟢 Connected"
            : "🔴 Not connected"
        }\n` +
        `Generation: ${
          session.busy
            ? "🟡 Working"
            : "🟢 Idle"
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
        "🔐 <b>Connect Vercel</b>\n\n" +
          "Authorize your own Vercel account.",

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
        "❌ Could not create the Vercel connection."
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
      "Starting deployment..."
    );

    const session =
      getUser(
        ctx.from.id
      );

    const projectPath =
      session.projectRoot ||
      session.projectDir ||
      null;

    if (
      !projectPath ||
      !session.projectName
    ) {
      await ctx.reply(
        "❌ No generated website is available.\n\n" +
          "Please create the website again."
      );

      return;
    }

    if (
      !session.siteSlug
    ) {
      session.awaitingSiteSlug =
        true;

      await ctx.reply(
        "🌐 <b>Enter your website URL name</b>\n\n" +
          "Example:\n" +
          "<code>asif-portfolio</code>",

        {
          parse_mode:
            "HTML",
        }
      );

      return;
    }

    if (
      !session.vercel.connected ||
      !session.vercel.accessToken
    ) {
      await ctx.reply(
        "🔴 Please connect your Vercel account first.",

        {
          ...connectKeyboard(),
        }
      );

      return;
    }

    if (
      session.busy
    ) {
      await ctx.reply(
        "⏳ AURA is already working on your project."
      );

      return;
    }

    session.busy =
      true;

    try {
      await ctx.reply(
        "🚀 <b>Launching your website...</b>\n\n" +
          "AURA is publishing it now ✨",

        {
          parse_mode:
            "HTML",
        }
      );

      const deployment =
        await deployToVercel(
          projectPath,

          session.siteSlug,

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
        "✨ <b>Your website has landed!</b>\n\n" +
          `🚀 <b>${escapeTelegram(
            session.siteSlug
          )}</b>\n\n` +
          "🌐 <b>Live now:</b>\n" +
          `<a href="${escapeTelegram(
            deployment.url
          )}">${escapeTelegram(
            deployment.url
          )}</a>\n\n` +
          "Built, polished and published by <b>AURA</b> ✨",

        {
          parse_mode:
            "HTML",

          disable_web_page_preview:
            false,
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
// BACKGROUND WEBSITE GENERATION
// ============================================================
//
// IMPORTANT:
//
// runAgent() can take longer than Telegram's update timeout.
//
// So the Telegram handler starts this job and DOES NOT await it.
//
// ============================================================

async function generateForTelegramUser(
  telegramUserId,
  userRequest
) {
  const session =
    getUser(
      telegramUserId
    );

  try {
    await bot.telegram.sendMessage(
      telegramUserId,

      "🧠 <b>AURA is building your application...</b>\n\n" +
        "Understanding your requirements ✨",

      {
        parse_mode:
          "HTML",
      }
    );

    console.log("");
    console.log(
      "=========================================="
    );

    console.log(
      "🧠 BACKGROUND WEBSITE JOB"
    );

    console.log(
      "=========================================="
    );

    console.log(
      `👤 Telegram user: ${telegramUserId}`
    );

    console.log(
      `🎯 Request: ${userRequest}`
    );

    // --------------------------------------------------------
    // PLANNING / GENERATION
    // --------------------------------------------------------

    await bot.telegram.sendMessage(
      telegramUserId,

      "🎨 <b>Designing the application...</b>\n\n" +
        "AURA is creating the complete user experience.",

      {
        parse_mode:
          "HTML",
      }
    );

    const result =
      await runAgent(
        userRequest
      );

    if (
      !result ||
      result.success === false
    ) {
      throw new Error(
        "AURA could not create the website."
      );
    }

    // --------------------------------------------------------
    // SAVE PROJECT
    // --------------------------------------------------------

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

    session.siteSlug =
      null;

    session.awaitingSiteSlug =
      true;

    console.log(
      "✅ Background generation complete."
    );

    console.log({
      projectName:
        session.projectName,

      projectRoot:
        session.projectRoot,

      projectDir:
        session.projectDir,

      files:
        session.projectFiles,
    });

    // --------------------------------------------------------
    // USER RESULT
    // --------------------------------------------------------

    await bot.telegram.sendMessage(
      telegramUserId,

      "✅ <b>Website created!</b>\n\n" +
        `📦 <b>${escapeTelegram(
          session.projectName
        )}</b>\n\n` +
        "🌐 <b>Now enter your website URL name.</b>\n\n" +
        "Example:\n" +
        "<code>asif-portfolio</code>\n\n" +
        "Your final URL will be:\n" +
        "<code>https://asif-portfolio.vercel.app</code>",

      {
        parse_mode:
          "HTML",
      }
    );

  } catch (error) {
    console.error(
      "\n❌ BACKGROUND GENERATION ERROR:"
    );

    console.error(
      error
    );

    try {
      await bot.telegram.sendMessage(
        telegramUserId,

        "❌ <b>I couldn't finish your website.</b>\n\n" +
          `<code>${escapeTelegram(
            error?.message ||
              "Unknown error"
          )}</code>\n\n` +
          "You can try the request again.",

        {
          parse_mode:
            "HTML",
        }
      );
    } catch (
      telegramError
    ) {
      console.error(
        "❌ Could not send failure message:",
        telegramError
      );
    }
  } finally {
    session.busy =
      false;
  }
}

// ============================================================
// TEXT HANDLER
// ============================================================
//
// IMPORTANT:
//
// We DO NOT await generateForTelegramUser() here.
//
// That prevents the Telegraf 90-second timeout.
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

    // --------------------------------------------------------
    // URL INPUT
    // --------------------------------------------------------

    if (
      session.awaitingSiteSlug
    ) {
      const slug =
        sanitizeSiteSlug(
          text
        );

      if (!slug) {
        await ctx.reply(
          "❌ <b>Invalid website name</b>\n\n" +
            "Use lowercase letters, numbers and hyphens.\n\n" +
            "Example:\n" +
            "<code>asif-portfolio</code>",

          {
            parse_mode:
              "HTML",
          }
        );

        return;
      }

      session.siteSlug =
        slug;

      session.awaitingSiteSlug =
        false;

      await ctx.reply(
        "✨ <b>Perfect choice!</b>\n\n" +
          "Your website address will be:\n\n" +
          `<code>https://${escapeTelegram(
            slug
          )}.vercel.app</code>\n\n` +
          "Everything is ready.",

        {
          parse_mode:
            "HTML",

          ...deployKeyboard(),
        }
      );

      return;
    }

    // --------------------------------------------------------
    // BUSY
    // --------------------------------------------------------

    if (
      session.busy
    ) {
      await ctx.reply(
        "⏳ <b>AURA is already building your website.</b>\n\n" +
          "You can wait for the current project to finish.",

        {
          parse_mode:
            "HTML",
        }
      );

      return;
    }

    // --------------------------------------------------------
    // START JOB
    // --------------------------------------------------------

    session.busy =
      true;

    /*
     * Send immediately so Telegram receives a fast response.
     */

    await ctx.reply(
      "🧠 <b>AURA is building your application...</b>\n\n" +
        "This can take a little longer for complex websites.\n" +
        "I'll message you when it's ready ✨",

      {
        parse_mode:
          "HTML",
      }
    );

    /*
     * IMPORTANT:
     *
     * No await.
     *
     * The job continues in the background.
     */

    void generateForTelegramUser(
      ctx.from.id,
      text
    );
  }
);

// ============================================================
// TELEGRAM ERROR HANDLER
// ============================================================

bot.catch(
  (error) => {
    console.error(
      "❌ Telegram bot error:"
    );

    console.error(
      error
    );
  }
);

// ============================================================
// EXPRESS 404
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
// EXPRESS ERROR
// ============================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "❌ Express error:",
      error
    );

    if (
      res.headersSent
    ) {
      return next(
        error
      );
    }

    return res
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
// START HTTP + TELEGRAM
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

        console.log(
          "=========================================="
        );
      } catch (error) {
        console.error(
          "❌ Telegram bot failed to start:"
        );

        console.error(
          error
        );

        /*
         * If this is 409 Conflict,
         * another instance is already polling
         * the same Telegram bot token.
         */

        process.exit(
          1
        );
      }
    }
  );

// ============================================================
// SHUTDOWN
// ============================================================

function shutdown(signal) {
  console.log(
    `\n🛑 ${signal} received.`
  );

  try {
    bot.stop(
      signal
    );
  } catch {}

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
  () =>
    shutdown(
      "SIGINT"
    )
);

process.once(
  "SIGTERM",
  () =>
    shutdown(
      "SIGTERM"
    )
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
