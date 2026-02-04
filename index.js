import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// In-memory sessions (per WhatsApp user)
const sessions = {};
const MAX_TURNS = 12;

// System prompt
const SYSTEM_PROMPT = `
You are Mildrid, a friendly international speaking AI concierge.
Speak in simple and natural language.
Help users with being a personal concierge in Tromsoe (cafes, restaurants, attractions, transport, daily help).

IMPORTANT:
When you recommend a physical place (cafe, restaurant, attraction), always include a Google Maps link using this format:
https://www.google.com/maps/search/?api=1&query=<PLACE>,Tromsoe

Keep answers short, helpful, and polite.
`;

// Ensure session exists
function ensureSession(from) {
  if (!sessions[from]) {
    sessions[from] = [{ role: "system", content: SYSTEM_PROMPT.trim() }];
  }
}

// Trim history
function trimSession(from) {
  const s = sessions[from];
  if (!s || s.length <= 1) return;

  const maxTotal = 1 + (MAX_TURNS - 1);
  if (s.length > maxTotal) {
    const systemMsg = s[0];
    const rest = s.slice(s.length - (maxTotal - 1));
    sessions[from] = [systemMsg, ...rest];
  }
}

// Escape XML for Twilio
function escapeXml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// WhatsApp webhook
app.post("/whatsapp", async (req, res) => {
  const userMessage = req.body.Body || "";
  const from = req.body.From || "unknown";

  ensureSession(from);

  sessions[from].push({ role: "user", content: userMessage });
  trimSession(from);

  try {
    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: sessions[from],
        temperature: 0.4
      })
    });

    const data = await openaiResponse.json();

    if (!openaiResponse.ok) {
      console.error("OpenAI error:", data);
      const fallback = "Beklager, jeg fikk en teknisk feil. Prøv igjen.";
      return res
        .type("text/xml")
        .send(`<Response><Message>${escapeXml(fallback)}</Message></Response>`);
    }

    const reply = data.choices?.[0]?.message?.content?.trim() || "Jeg kunne ikke svare akkurat nå.";

    sessions[from].push({ role: "assistant", content: reply });
    trimSession(from);

    const twiml = `<Response><Message>${escapeXml(reply)}</Message></Response>`;
    return res.type("text/xml").send(twiml);

  } catch (error) {
    console.error("Server error:", error);
    const fallback = "Beklager, det oppstod en feil. Prøv igjen.";
    return res
      .type("text/xml")
      .send(`<Response><Message>${escapeXml(fallback)}</Message></Response>`);
  }
});

// Scrape endpoint
app.post("/scrape", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "Missing URL" });
  }

  try {
    const pageResponse = await fetch(url);
    const html = await pageResponse.text();

    const prompt = `
Extract structured business information from this text and return ONLY valid JSON with these fields:
- business_name
- address
- check_in_instructions
- house_rules
- wifi_info
- parking_info
- nearby_attractions
- faq

Text:
${html.slice(0, 12000)}
`;

    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0
      })
    });

    const data = await openaiResponse.json();

    if (!openaiResponse.ok) {
      console.error("Scrape OpenAI error:", data);
      return res.status(500).json({ error: "OpenAI scrape failed", details: data });
    }

    const extractedRaw = data.choices?.[0]?.message?.content || "{}";

    let extracted;
    try {
      extracted = JSON.parse(extractedRaw);
    } catch {
      extracted = { raw: extractedRaw, parse_error: true };
    }

    return res.json({ extracted });

  } catch (error) {
    console.error("Scrape error:", error);
    return res.status(500).json({ error: "Scraping failed" });
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("Mildrid is running.");
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));


