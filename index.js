import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Memory stores
const sessions = {};
const profiles = {};

// =========================
// DEFAULT SYSTEM PROMPT
// =========================
function buildSystemPrompt(profile) {
  return `
You are a friendly AI concierge for ${profile.name}.
Language: Norwegian.

You help guests staying at ${profile.name} in Tromsø.

Use the following property information when answering questions:

${profile.content}

Rules:
- Be polite and short
- Always include Google Maps links when recommending places
- Use format: https://www.google.com/maps/search/?api=1&query=<place+city>
- Answer like a professional hotel concierge
`;
}

// =========================
// HEALTH CHECK
// =========================
app.get("/", (req, res) => {
  res.send("Kora AI is running.");
});

// =========================
// INGEST PROFILE (POSTMAN)
// =========================
app.post("/ingest", async (req, res) => {
  const { profileId, name, locale, urls } = req.body;

  if (!profileId || !urls) {
    return res.status(400).json({ error: "Missing profileId or urls" });
  }

  let combinedText = "";

  for (const url of urls) {
    const page = await fetch(url);
    const text = await page.text();
    combinedText += text.slice(0, 8000);
  }

  const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: "Extract structured concierge information from this text."
        },
        {
          role: "user",
          content: `
Extract:
- Apartment name
- Address
- Check-in instructions
- House rules
- Wifi info
- Parking
- Nearby attractions
- FAQ

Return as clean text.

Content:
${combinedText}
`
        }
      ],
      temperature: 0
    })
  });

  const data = await openaiResponse.json();
  const extracted = data.choices[0].message.content;

  profiles[profileId] = {
    id: profileId,
    name,
    locale,
    content: extracted
  };

  res.json({ success: true, profile: profiles[profileId] });
});

// =========================
// WHATSAPP BOT
// =========================
app.post("/whatsapp", async (req, res) => {
  const userMessage = req.body.Body;
  const from = req.body.From;

  // Use Nyholmen profile
  const profile = profiles["nyholmen"];

  if (!profile) {
    return res.send(`
<Response>
<Message>Concierge profile not loaded yet. Please ingest first.</Message>
</Response>
`);
  }

  if (!sessions[from]) {
    sessions[from] = [
      { role: "system", content: buildSystemPrompt(profile) }
    ];
  }

  sessions[from].push({ role: "user", content: userMessage });

  try {
    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: sessions[from],
        temperature: 0.6
      })
    });

    const data = await openaiResponse.json();
    const reply = data.choices[0].message.content;

    sessions[from].push({ role: "assistant", content: reply });

    const twilioResponse = `
<Response>
<Message>${reply}</Message>
</Response>
`;

    res.type("text/xml");
    res.send(twilioResponse);

  } catch (error) {
    console.error(error);
    res.send(`
<Response>
<Message>Beklager, noe gikk galt. Prøv igjen.</Message>
</Response>
`);
  }
});

// =========================
// START SERVER
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
