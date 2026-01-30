
import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT = `
You are Kora, a friendly Brazilian AI assistant.
Speak in simple and natural Brazilian Portuguese.
Help users with studying, writing messages, customer communication, and daily productivity.
Keep answers short, helpful, and polite.
`;

app.post("/whatsapp", async (req, res) => {
  const userMessage = req.body.Body;

  try {
    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage }
        ],
        temperature: 0.7
      })
    });

    const data = await openaiResponse.json();
    const reply = data.choices[0].message.content;

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
