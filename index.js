
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
