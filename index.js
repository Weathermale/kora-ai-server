
import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const sessions = {};


const SYSTEM_PROMPT = `
const SYSTEM_PROMPT = `
You are Mildrid, a friendly international speaking AI assistant.
Speak in simple and natural language.
Help users with being a personal concierge in the Tromsoe area, writing messages, customer communication, and daily productivity.

Når du anbefaler et fysisk sted (kafé, restaurant, attraksjon), skal du alltid inkludere en Google Maps-lenke i svaret.
Bruk formatet:
https://www.google.com/maps/search/?api=1&query=<stedsnavn+by>

Keep answers short, helpful, and polite.
`;

`;

app.post("/whatsapp", async (req, res) => {
  const userMessage = req.body.Body;
  const from = req.body.From;

  if (!sessions[from]) {
    sessions[from] = [
      { role: "system", content: SYSTEM_PROMPT }
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
        temperature: 0.7
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
  <Message>Desculpe, ocorreu um erro. Tente novamente.</Message>
</Response>
`);
  }
});

app.get("/", (req, res) => {
  res.send("Kora AI is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));

app.post("/scrape", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "Missing URL" });
  }

  try {
    const pageResponse = await fetch(url);
    const html = await pageResponse.text();

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
            content: "You are a data extractor. Extract structured business information from the following webpage text."
          },
          {
            role: "user",
            content: `
Extract the following fields from this webpage:
- Business name
- Address
- Check-in instructions
- House rules
- Wifi info
- Parking info
- Nearby attractions
- FAQ

Return as JSON.

Webpage content:
${html.slice(0, 12000)}
`
          }
        ],
        temperature: 0
      })
    });

    const data = await openaiResponse.json();
    const extracted = data.choices[0].message.content;

    res.json({ extracted });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Scraping failed" });
  }
});

