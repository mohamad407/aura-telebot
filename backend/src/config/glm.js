const OpenAI = require("openai");

const glm = new OpenAI({
  // Pulls the key safely from your .env
  apiKey: process.env.GLM_API_KEY, 
  
  // OFFICIAL: Set the precise base URL required by Z.ai's OpenAI SDK wrapper
  baseURL: "https://api.z.ai/api/paas/v4/" 
});

module.exports = glm;
