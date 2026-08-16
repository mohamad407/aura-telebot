
require("dotenv").config();

const Groq = require("groq-sdk");
const OpenAI = require("openai");

// ======================================================
// PROVIDERS
// ======================================================

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const openrouter = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

// ======================================================
// CONFIG
// ======================================================

const GROQ_MODEL =
  process.env.GROQ_MODEL ||
  "openai/gpt-oss-120b";

const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL ||
  "openai/gpt-oss-120b";

const MAX_PROVIDER_RETRIES = 1;

// ======================================================
// STATUS HELPERS
// ======================================================

function getStatus(error) {
  return (
    error?.status ||
    error?.response?.status ||
    error?.statusCode ||
    null
  );
}

function isRetryableProviderError(error) {
  const status = getStatus(error);

  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

// ======================================================
// RESPONSE EXTRACTION
// ======================================================

function extractContent(response, provider) {
  const choice = response?.choices?.[0];

  if (!choice) {
    throw new Error(
      `${provider} returned no choices.`
    );
  }

  const message = choice.message || {};

  let content = message.content;

  // Some providers can return content
  // as an array instead of a string.
  if (Array.isArray(content)) {
    content = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        return (
          part?.text ||
          part?.content ||
          ""
        );
      })
      .join("");
  }

  if (typeof content !== "string") {
    content =
      content == null
        ? ""
        : String(content);
  }

  content = content.trim();

  if (!content) {
    const finishReason =
      choice.finish_reason ||
      "unknown";

    throw new Error(
      `${provider} returned an empty response. finish_reason=${finishReason}`
    );
  }

  return content;
}

// ======================================================
// GROQ
// ======================================================

async function callGroq({
  system,
  user,
  maxTokens = 1200,
  temperature = 0.2,
}) {
  console.log(
    `🟢 AI Gateway → Groq (${GROQ_MODEL})`
  );

  const response =
    await groq.chat.completions.create({
      model: GROQ_MODEL,

      temperature,

      max_completion_tokens:
        maxTokens,

      messages: [
        {
          role: "system",
          content: String(system || ""),
        },
        {
          role: "user",
          content: String(user || ""),
        },
      ],
    });

  return extractContent(
    response,
    "Groq"
  );
}

// ======================================================
// OPENROUTER
// ======================================================

async function callOpenRouter({
  system,
  user,
  maxTokens = 1200,
  temperature = 0.2,
}) {
  console.log(
    `🔵 AI Gateway → OpenRouter (${OPENROUTER_MODEL})`
  );

  const response =
    await openrouter.chat.completions.create({
      model: OPENROUTER_MODEL,

      temperature,

      max_tokens: maxTokens,

      messages: [
        {
          role: "system",
          content: String(system || ""),
        },
        {
          role: "user",
          content: String(user || ""),
        },
      ],
    });

  return extractContent(
    response,
    "OpenRouter"
  );
}

// ======================================================
// PROVIDER RETRY
// ======================================================

async function runProvider(
  providerName,
  providerFunction
) {
  let lastError;

  for (
    let attempt = 1;
    attempt <= MAX_PROVIDER_RETRIES;
    attempt++
  ) {
    try {
      return await providerFunction();
    } catch (error) {
      lastError = error;

      console.error(
        `❌ ${providerName} attempt ${attempt} failed:`,
        error.message
      );

      if (
        attempt < MAX_PROVIDER_RETRIES &&
        isRetryableProviderError(error)
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1000)
        );
      }
    }
  }

  throw lastError;
}

// ======================================================
// MAIN AURA AI GATEWAY
// ======================================================

async function aiChat({
  system,
  user,
  maxTokens = 1200,
  temperature = 0.2,
}) {
  if (
    !process.env.GROQ_API_KEY &&
    !process.env.OPENROUTER_API_KEY
  ) {
    throw new Error(
      "No AI provider API keys configured."
    );
  }

  // ====================================================
  // PROVIDER 1 — GROQ
  // ====================================================

  if (process.env.GROQ_API_KEY) {
    try {
      const result =
        await runProvider(
          "Groq",
          () =>
            callGroq({
              system,
              user,
              maxTokens,
              temperature,
            })
        );

      console.log(
        "✅ AI Gateway → Groq success"
      );

      return {
        provider: "groq",
        model: GROQ_MODEL,
        content: result,
      };
    } catch (groqError) {
      console.error(
        "⚠️ Groq failed:",
        groqError.message
      );

      console.log(
        "🔄 Falling back to OpenRouter..."
      );
    }
  }

  // ====================================================
  // PROVIDER 2 — OPENROUTER
  // ====================================================

  if (process.env.OPENROUTER_API_KEY) {
    try {
      const result =
        await runProvider(
          "OpenRouter",
          () =>
            callOpenRouter({
              system,
              user,
              maxTokens,
              temperature,
            })
        );

      console.log(
        "✅ AI Gateway → OpenRouter success"
      );

      return {
        provider: "openrouter",
        model: OPENROUTER_MODEL,
        content: result,
      };
    } catch (openrouterError) {
      console.error(
        "❌ OpenRouter failed:",
        openrouterError.message
      );

      throw new Error(
        `All AI providers failed. Groq: unavailable. OpenRouter: ${openrouterError.message}`
      );
    }
  }

  throw new Error(
    "No working AI provider is configured."
  );
}

// ======================================================
// SIMPLE TEXT API
// ======================================================

async function aiChatText(options) {
  const result = await aiChat(options);

  return result.content;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
  aiChat,
  aiChatText,
  callGroq,
  callOpenRouter,
};

