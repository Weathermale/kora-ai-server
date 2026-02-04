// index.js
// WhatsApp (Twilio Sandbox) -> OpenAI concierge bot with per-property profile + scrape/ingest endpoints.
// Works as an MVP on Render.
//
// ENV needed on Render:
// - OPENAI_API_KEY = your OpenAI key
//
// Optional ENV:
// - DEFAULT_PROFILE_ID = "nyholmen" (default)
// - PORT = Render sets automatically

import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json({ limit: "2mb" }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.warn("WARNING: OPENAI_API_KEY is not set. Bot will fail until you add it in Render env vars.");
}

// ---- In-memory stores (MVP) ----
// sessions[from] = [{role, content}, ...]
const sessions = {};

// profiles[profileId] = { id, name, locale, sources: [...], knowledge: {...}, updatedAt }
const profiles = {};

// One default profile id for WhatsApp route
const DEFAULT_PROFILE_ID = process.env.DEFAULT_PROFILE_ID || "nyholmen";

// ---- Helpers ----
function escapeXml(unsafe) {
  if (unsafe == null) return "";
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toGoogleMapsSearchLink(place, city = "Tromsø") {
  const q = encodeURIComponent(`${place} ${city}`.trim());
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function buildSystemPrompt(profile) {
  const profileName = profile?.name || "Nyholmen Apartments";
  const locale = profile?.locale || "no";

  const knowledgeJson = profile?.knowledge
    ? JSON.stringify(profile.knowledge, null, 2)
    : JSON.stringify(
        {
          business_name: profileName,
          note: "No structured knowledge loaded yet. Ask admin to ingest sources via /ingest.",
        },
        null,
        2
      );

  return `
You are the concierge assistant for: ${profileName}.
Primary language: ${locale === "no" ? "Norwegian (Bokmål)" : "English"}.

You have structured property knowledge below (JSON). Use it as the single source of truth when answering questions about the property (check-in, wifi, rules, etc).
If the user asks something not covered, say what you know and ask a short follow-up question.

PROPERTY KNOWLEDGE (JSON):
${knowledgeJson}

Rules:
- Be short, clear, friendly, and professional.
- If you recommend a physical place (cafe/restaurant/attraction), ALWAYS include a Google Maps link.
  Use this format: https://www.google.com/maps/search/?api=1&query=<place+city>
- Do not claim you can book/charge unless explicitly instructed by the property knowledge.
- If the user writes in English, you may respond in English. Otherwise respond in Norwegian.
`.trim();
}

async function callOpenAIChat({ messages, temperature = 0.4, model = "gpt-4.1-mini" }) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
    }),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const msg = data?.error?.message || `OpenAI error (${resp.status})`;
    throw new Error(msg);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned no message content.");
  return content;
}

async function fetchText(url) {
  const r = await fetch(url, {
    method: "GET",
    // basic user-agent helps some servers
    headers: { "User-Agent": "Mozilla/5.0 (concierge-mvp)" },
  });
  if (!r.ok) throw new Error(`Failed to fetch URL (${r.status}): ${url}`);
  const text = await r.text();
  return text;
}

// ---- Default profile placeholder (so WhatsApp works immediately) ----
profiles[DEFAULT_PROFILE_ID] = {
  id: DEFAULT_PROFILE_ID,
  name: "Nyholmen Apartments",
  locale: "no",
  sources: [
    // You can ingest these via /ingest (recommended), but we keep placeholders here.
    // Add your Airbnb + Google Docs URLs through /ingest to populate knowledge.
  ],
  knowledge: {
    business_name: "Nyholmen Apartments",
    city: "Tromsø",
    note: "Knowledge not ingested yet. Admin should POST /ingest with source URLs.",
  },
  updatedAt: new Date().toISOString(),
};

// ---- WhatsApp webhook (Twilio) ----
app.post("/whatsapp", async (req, res) => {
  try {
    const userMessage = req.body?.Body || "";
    const from = req.body?.From || "unknown";

    const profile = profiles[DEFAULT_PROFILE_ID];

    if (!sessions[from]) {
      sessions[from] = [{ role: "system", content: buildSystemPrompt(profile) }];
    }

    // Add user message
    sessions[from].push({ role: "user", content: userMessage });

    // Ask OpenAI
    const reply = await callOpenAIChat({
      messages: sessions[from],
      temperature: 0.6,
      model: "gpt-4.1-mini",
    });

    // Add assistant reply to session memory
    sessions[from].push({ role: "assistant", content: reply });

    // TwiML response
    const twilioResponse = `
<Response>
  <Message>${escapeXml(reply)}</Message>
</Response>
`.trim();

    res.type("text/xml").send(twilioResponse);
  } catch (error) {
    console.error("WHATSAPP ERROR:", error);

    const twilioResponse = `
<Response>
  <Message>${escapeXml("Beklager, det oppstod en feil. Prøv igjen.")}</Message>
</Response>
`.trim();

    res.type("text/xml").send(twilioResponse);
  }
});

// ---- Health check ----
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "concierge-mvp",
    default_profile: DEFAULT_PROFILE_ID,
    profiles: Object.keys(profiles),
  });
});

// ---- Profiles: view current profile (MVP) ----
app.get("/profile", (req, res) => {
  res.json(profiles[DEFAULT_PROFILE_ID] || null);
});

// ---- Ingest endpoint: scrape one or multiple URLs and build structured knowledge ----
// POST /ingest
// {
//   "profileId": "nyholmen",
//   "name": "Nyholmen Apartments",
//   "locale": "no",
//   "urls": ["https://...airbnb...", "https://docs.google.com/document/d/..."]
// }
app.post("/ingest", async (req, res) => {
  try {
    const { profileId, name, locale, urls } = req.body || {};

    const id = profileId || DEFAULT_PROFILE_ID;
    const profileName = name || profiles[id]?.name || "Nyholmen Apartments";
    const profileLocale = locale || profiles[id]?.locale || "no";

    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: "Missing urls[] in body" });
    }

    // Fetch raw text for each URL (MVP). Note: Google Docs must be publicly accessible to fetch without login.
    const sources = [];
    for (const u of urls) {
      const htmlOrText = await fetchText(u);
      sources.push({
        url: u,
        // Truncate to keep token cost sane
        content: htmlOrText.slice(0, 12000),
      });
    }

    // Ask OpenAI to extract structured knowledge in JSON
    const extractionPrompt = `
Extract structured property / concierge information from the given sources.
Return ONLY valid JSON.

Required keys (use null if unknown):
{
  "business_name": string,
  "address": string,
  "city": string,
  "check_in": {
    "time_from": string,
    "time_to": string,
    "instructions": string,
    "key_pickup": string
  },
  "check_out": {
    "time": string,
    "instructions": string
  },
  "wifi": {
    "network": string,
    "password": string,
    "notes": string
  },
  "house_rules": [string],
  "parking": {
    "available": boolean,
    "instructions": string
  },
  "amenities_notes": [string],
  "faq": [
    { "q": string, "a": string }
  ],
  "nearby": {
    "cafes": [{ "name": string, "reason": string, "maps_link": string }],
    "restaurants": [{ "name": string, "reason": string, "maps_link": string }],
    "attractions": [{ "name": string, "reason": string, "maps_link": string }]
  }
}

Important:
- If you find cafe/restaurant/attraction names, include maps_link using:
  https://www.google.com/maps/search/?api=1&query=<name+Tromsø>
- Focus on correctness and brevity. No marketing fluff.
`.trim();

    const messages = [
      { role: "system", content: "You are a precise data extractor. Output only valid JSON." },
      { role: "user", content: extractionPrompt },
      {
        role: "user",
        content: `SOURCES:\n${sources
          .map((s, i) => `--- SOURCE ${i + 1}: ${s.url}\n${s.content}`)
          .join("\n\n")}`,
      },
    ];

    const extractedJsonText = await callOpenAIChat({
      messages,
      temperature: 0,
      model: "gpt-4.1-mini",
    });

    // Try to parse JSON; if it fails, return raw for debugging.
    let knowledge;
    try {
      knowledge = JSON.parse(extractedJsonText);
    } catch (e) {
      return res.status(200).json({
        ok: false,
        warning: "OpenAI did not return valid JSON. Returning raw text for debugging.",
        raw: extractedJsonText,
      });
    }

    // Enrich nearby maps links if missing (simple safety net)
    const city = knowledge?.city || "Tromsø";
    const enrichList = (arr) =>
      Array.isArray(arr)
        ? arr.map((x) => ({
            ...x,
            maps_link: x?.maps_link || (x?.name ? toGoogleMapsSearchLink(x.name, city) : null),
          }))
        : arr;

    if (knowledge?.nearby) {
      knowledge.nearby.cafes = enrichList(knowledge.nearby.cafes);
      knowledge.nearby.restaurants = enrichList(knowledge.nearby.restaurants);
      knowledge.nearby.attractions = enrichList(knowledge.nearby.attractions);
    }

    profiles[id] = {
      id,
      name: profileName,
      locale: profileLocale,
      sources: urls,
      knowledge,
      updatedAt: new Date().toISOString(),
    };

    // Reset sessions so new prompt takes effect immediately for all users (MVP behavior)
    for (const k of Object.keys(sessions)) delete sessions[k];

    res.json({
      ok: true,
      profileId: id,
      name: profiles[id].name,
      updatedAt: profiles[id].updatedAt,
      note: "Profile ingested and sessions reset.",
    });
  } catch (error) {
    console.error("INGEST ERROR:", error);
    res.status(500).json({ error: String(error?.message || error) });
  }
});

// ---- Optional: keep your existing /scrape for quick tests (returns raw extracted JSON text) ----
app.post("/scrape", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing URL" });

    const html = await fetchText(url);

    const messages = [
      { role: "system", content: "You are a data extractor. Output only valid JSON." },
      {
        role: "user",
        content: `
Extract property/business info from the text below.
Return ONLY valid JSON with these keys:
- business_name
- address
- check_in_instructions
- house_rules
- wifi
- parking
- nearby_attractions
- faq

Text:
${html.slice(0, 12000)}
`.trim(),
      },
    ];

    const extracted = await callOpenAIChat({
      messages,
      temperature: 0,
      model: "gpt-4.1-mini",
    });

    res.json({ ok: true, extracted });
  } catch (error) {
    console.error("SCRAPE ERROR:", error);
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

// ---- Start server ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
