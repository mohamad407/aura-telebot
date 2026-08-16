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

const HOST = "0.0.0.0";

if (!BOT_TOKEN) {
  throw new Error(
    "TELEGRAM_BOT_TOKEN is missing."
  );
}

// ============================================================
// EXPRESS
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
// TELEGRAM
// ============================================================

const bot =
  new Telegraf(BOT_TOKEN);

// ============================================================
// USER SESSION
// ============================================================

const users = new Map();

/*
User session:

{
  projectName,
  projectRoot,
  projectDir,

  siteSlug,
  awaitingSiteSlug,

  vercel: {
    connected,
    accessToken,
    refreshToken,
    expiresAt,
    teamId,
    configurationId
  }
}
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
    });
  }

  return users.get(id);
}

// ============================================================
// ESCAPE HELPERS
// ============================================================

function escapeTelegram(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
// SITE SLUG
// ============================================================

function sanitizeSiteSlug(input) {
  let slug = String(input || "")
    .trim()
    .toLowerCase();

  /*
   * User may paste:
   *
   * asif-portfolio
   *
   * OR:
   *
   * https://asif-portfolio.vercel.app
   *
   * OR:
   *
   * asif-portfolio.vercel.app
   */

  slug = slug
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "");

  slug = slug
    .replace(
      /\.vercel\.app\/?.*$/i,
      ""
    )
    .replace(
      /\/.*$/g,
      ""
    );

  slug = slug
    .replace(
      /[^a-z0-9-]+/g,
      "-"
    )
    .replace(
      /-+/g,
      "-"
    )
    .replace(
      /^-+/,
      ""
    )
    .replace(
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

function isValidSiteSlug(slug) {
  return (
    typeof slug === "string" &&
    /^[a-z0-9][a-z0-9-]{0,59}$/.test(
      slug
    )
  );
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
// VERCEL CONNECTION URL
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
      "Vercel credentials are missing."
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
// TELEGRAM KEYBOARDS
// ============================================================

function connectVercelKeyboard() {
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

function reconnectKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🔄 Reconnect Vercel",
        "connect_vercel"
      ),
    ],
  ]);
}

// ============================================================
// RENDER HEALTH
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

      timestamp:
        new Date().toISOString(),
    });
  }
);

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
>
<title>AURA Agent - EULA</title>

<style>
body {
  margin: 0;
  padding: 40px 20px;
  font-family: Arial, sans-serif;
  background: #080b12;
  color: #fff;
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
  color: #fff;
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
AURA Agent is an AI-powered Telegram service that generates
and deploys websites.
</p>

<h2>3. Vercel</h2>
<p>
Users explicitly authorize Vercel access before deployment.
AURA uses permissions granted by the user.
</p>

<h2>4. User Responsibility</h2>
<p>
Users are responsible for generated content and deployments.
</p>

<h2>5. AI Content</h2>
<p>
AI-generated content should be reviewed before production use.
</p>

<h2>6. Availability</h2>
<p>
AURA Agent may occasionally be unavailable.
</p>

<h2>7. Liability</h2>
<p>
Use of the service is subject to applicable law.
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
>
<title>AURA Agent - Privacy</title>

<style>
body {
  margin: 0;
  padding: 40px 20px;
  font-family: Arial, sans-serif;
  background: #080b12;
  color: #fff;
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
  color: #fff;
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
AURA may process Telegram identifiers and website requests
needed to provide the service.
</p>

<h2>2. Vercel</h2>
<p>
When a user connects Vercel, authorization information is
processed to perform the requested deployment.
</p>

<h2>3. AI Providers</h2>
<p>
Website requests may be processed by configured AI providers
to generate website code.
</p>

<h2>4. Security</h2>
<p>
Credentials are handled server-side.
</p>

<h2>5. Contact</h2>
<p>
Contact the AURA Agent developer through the integration support contact.
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
      } catch (
        error
      ) {
        console.log(
          "⚠️ Vercel user lookup failed:",
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
        "✅ Vercel connected:"
      );

      console.log(
        accountName
      );

      // --------------------------------------------------------
      // TELEGRAM RESPONSE
      // --------------------------------------------------------

      try {
        if (
          session.projectRoot ||
          session.projectDir
        ) {
          /*
           * If user already created website:
           *
           * ask for URL name.
           */

          session.awaitingSiteSlug =
            true;

          await bot.telegram.sendMessage(
            oauth.telegramUserId,

            "✅ <b>Vercel connected</b>\n\n" +
              `👤 ${escapeTelegram(
                accountName
              )}\n\n` +
              "🌐 <b>Now choose your website address.</b>\n\n" +
              "Type the name you want before <code>.vercel.app</code>.\n\n" +
              "Example:\n" +
              "<code>asif-portfolio</code>\n\n" +
              "Then your website will be:\n" +
              "<code>https://asif-portfolio.vercel.app</code>",

            {
              parse_mode:
                "HTML",
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
          "❌ Telegram notification failed:"
        );

        console.error(
          telegramError
        );
      }

      // --------------------------------------------------------
      // BROWSER PAGE
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
line-height:1.7;
"
>
Your Vercel account has been connected successfully.
</p>

<p
style="
color:#aeb7c8;
line-height:1.7;
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
        "Tell me what you want to build.\n\n" +
        "Example:\n" +
        "<code>Create a simple portfolio</code>\n\n" +
        "I'll turn your idea into a live website.",

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
    const session =
      getUser(
        ctx.from.id
      );

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
          "Authorize your Vercel account to deploy websites with AURA.",

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

    let text =
      "🤖 <b>AURA Status</b>\n\n";

    text +=
      `Website: ${
        session.projectName ||
        "None"
      }\n`;

    text +=
      `URL: ${
        session.siteSlug
          ? `https://${session.siteSlug}.vercel.app`
          : "Not selected"
      }\n`;

    text +=
      `Vercel: ${
        session.vercel.connected
          ? "🟢 Connected"
          : "🔴 Not connected"
      }`;

    await ctx.reply(
      text,
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
          "Authorize your Vercel account.",

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
      "Deploying..."
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
          "<code>asif-portfolio</code>\n\n" +
          "Your URL will be:\n" +
          "<code>https://asif-portfolio.vercel.app</code>",

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
        "🔴 Connect your Vercel account first.",

        {
          ...connectVercelKeyboard(),
        }
      );

      return;
    }

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
        "🚀 <b>Launching your website...</b>\n\n" +
          "Preparing your live URL.",

        {
          parse_mode:
            "HTML",
        }
      );

      const deployment =
        await deployToVercel(
          projectPath,

          /*
           * IMPORTANT:
           *
           * Use the user's desired URL name
           * as the Vercel project name.
           */
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

      // --------------------------------------------------------
      // SUCCESS MESSAGE
      // --------------------------------------------------------

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

    } catch (
      error
    ) {
      console.error(
        "❌ Deployment error:"
      );

      console.error(
        error
      );

      /*
       * Friendly conflict message.
       */
      const message =
        String(
          error?.message ||
            ""
        ).toLowerCase();

      if (
        message.includes(
          "already exists"
        ) ||
        message.includes(
          "name"
        ) &&
        message.includes(
          "taken"
        ) ||
        message.includes(
          "conflict"
        )
      ) {
        await ctx.reply(
          "⚠️ <b>That website name is already in use.</b>\n\n" +
            `The name <code>${escapeTelegram(
              session.siteSlug
            )}</code> could not be used.\n\n` +
            "Send another URL name, for example:\n" +
            "<code>asif-portfolio-2026</code>",

          {
            parse_mode:
              "HTML",
          }
        );

        session.awaitingSiteSlug =
          true;

        return;
      }

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
// TEXT HANDLER
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

    // ========================================================
    // USER IS ENTERING WEBSITE URL
    // ========================================================

    if (
      session.awaitingSiteSlug
    ) {
      const requestedSlug =
        sanitizeSiteSlug(
          text
        );

      if (
        !requestedSlug ||
        !isValidSiteSlug(
          requestedSlug
        )
      ) {
        await ctx.reply(
          "❌ <b>Invalid website name</b>\n\n" +
            "Use only lowercase letters, numbers and hyphens.\n\n" +
            "Examples:\n" +
            "<code>asif-portfolio</code>\n" +
            "<code>my-store</code>\n" +
            "<code>asif-dev</code>\n\n" +
            "Try again.",

          {
            parse_mode:
              "HTML",
          }
        );

        return;
      }

      session.siteSlug =
        requestedSlug;

      session.awaitingSiteSlug =
        false;

      await ctx.reply(
        "✨ <b>Perfect!</b>\n\n" +
          "Your website address will be:\n\n" +
          `<code>https://${escapeTelegram(
            requestedSlug
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

    // ========================================================
    // GENERATION
    // ========================================================

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
          "Give me a moment ✨",

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
       * Important:
       *
       * Support both names because different
       * agent versions used different property names.
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

      /*
       * Reset old URL.
       */
      session.siteSlug =
        null;

      /*
       * The next step after generation is
       * URL entry.
       */
      session.awaitingSiteSlug =
        true;

      console.log(
        "\n✅ PROJECT CREATED"
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
      // CLEAN TELEGRAM MESSAGE
      // --------------------------------------------------------

      await ctx.reply(
        "✅ <b>Website created!</b>\n\n" +
          `📦 <b>${escapeTelegram(
            session.projectName
          )}</b>\n\n` +
          "Now tell me what you want the website URL to be.\n\n" +
          "Example:\n" +
          "<code>asif-portfolio</code>\n\n" +
          "I'll make it:\n" +
          "<code>https://asif-portfolio.vercel.app</code>",

        {
          parse_mode:
            "HTML",
        }
      );

    } catch (
      error
    ) {
      console.error(
        "\n❌ AURA GENERATION ERROR:"
      );

      console.error(
        error
      );

      await ctx.reply(
        "❌ <b>I couldn't create the website.</b>\n\n" +
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
          "❌ Telegram bot failed to start:"
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
