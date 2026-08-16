// ==========================================
// AURA DESIGN AGENT 
// Powered by Groq for high-speed JSON schemas
// ==========================================

const Groq = require("groq-sdk");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

async function createDesignSpec(userRequest) {
  console.log("\n🎨 AURA DESIGN AGENT");
  console.log("🎯 Understanding visual requirements using Groq...");

  const prompt = `
You are Aura's UI/UX Design Agent.

Your job is to transform a user's website request into a professional
frontend design specification.

USER REQUEST:
${userRequest}

Create a design specification for a modern, production-quality website.

The specification must decide:

1. theme
2. visual style
3. color palette
4. typography
5. layout
6. navigation
7. hero design
8. sections
9. cards
10. buttons
11. animations
12. responsive behavior
13. visual effects
14. spacing
15. accessibility

IMPORTANT:
- Do NOT generate HTML.
- Do NOT generate CSS.
- Only generate the design specification.
- Make the design visually impressive.
- Avoid generic/plain websites.
- Make the design appropriate for the user's request.
- Prefer modern SaaS / startup / portfolio quality when appropriate.
- The result must be implementable by a frontend coding agent.

Return ONLY valid JSON.

Required format:

{
  "theme": {
    "mode": "dark or light",
    "style": "string",
    "primaryColor": "string",
    "secondaryColor": "string",
    "accentColor": "string",
    "backgroundColor": "string",
    "textColor": "string"
  },
  "typography": {
    "headingFont": "string",
    "bodyFont": "string",
    "headingStyle": "string"
  },
  "layout": {
    "container": "string",
    "spacing": "string",
    "borderRadius": "string"
  },
  "navigation": {
    "style": "string",
    "items": []
  },
  "hero": {
    "style": "string",
    "headlineStyle": "string",
    "descriptionStyle": "string",
    "ctaButtons": [],
    "visual": "string"
  },
  "sections": [
    {
      "name": "string",
      "purpose": "string",
      "layout": "string",
      "components": []
    }
  ],
  "components": {
    "buttons": "string",
    "cards": "string",
    "inputs": "string"
  },
  "animations": {
    "enabled": true,
    "style": "string",
    "hoverEffects": "string",
    "scrollEffects": "string"
  },
  "responsive": {
    "mobile": "string",
    "tablet": "string",
    "desktop": "string"
  },
  "effects": [
    "string"
  ],
  "accessibility": [
    "string"
  ]
}
`;

  const completion = await groq.chat.completions.create({
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content: "You are an expert UI/UX designer and design-system architect.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  let raw = completion.choices?.[0]?.message?.content || "";

  console.log("\n🎨 RAW DESIGN RESPONSE FROM GROQ:");
  console.log(raw);

  // ==========================================
  // REMOVE MARKDOWN CODE FENCES
  // ==========================================

  raw = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  // ==========================================
  // EXTRACT JSON
  // ==========================================

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start === -1 || end === -1) {
    throw new Error("Groq did not return a valid design specification.");
  }

  raw = raw.slice(start, end + 1);

  let designSpec;

  try {
    designSpec = JSON.parse(raw);
  } catch (error) {
    console.error("❌ Design JSON parsing failed:");
    console.error(raw);
    throw new Error("Invalid design specification returned by Groq.");
  }

  console.log("\n🎨 DESIGN SPECIFICATION READY:");
  console.log(JSON.stringify(designSpec, null, 2));

  return designSpec;
}

module.exports = {
  createDesignSpec,
};
