// FILE: app.js
// DESCRIPTION: Main application file with Express server, WebSocket handling, and dashboard API.

// --- Imports ---
require("dotenv").config();
require("colors");

const express = require("express");
const ExpressWs = require("express-ws");
const path = require("path");
const fs = require("fs");
const basicAuth = require("express-basic-auth");

const { GptService } = require("./services/gpt-service");
const { StreamService } = require("./services/stream-service");
const { TranscriptionService } = require("./services/transcription-service");
const { TextToSpeechService } = require("./services/tts-service");
const { recordingService } = require("./services/recording-service");
const { makeOutboundCall } = require("./scripts/outbound-call-api");

const VoiceResponse = require("twilio").twiml.VoiceResponse;

// --- App Setup ---
const app = express();
ExpressWs(app);
const PORT = process.env.PORT || 3000;

// --- Middleware ---
// Parse JSON bodies for API requests - This should come early
app.use(express.json());

// ==================================================================
// == PUBLIC ROUTES (FOR TWILIO) - NO AUTHENTICATION NEEDED ==
// ==================================================================

app.post("/incoming", (req, res) => {
  try {
    const response = new VoiceResponse();
    const connect = response.connect();
    connect.stream({ url: `wss://${process.env.SERVER}/connection` });

    res.type("text/xml");
    res.end(response.toString());
  } catch (err) {
    console.log("Error in /incoming webhook:".red, err);
    res.status(500).send("Internal Server Error");
  }
});

app.ws("/connection", (ws) => {
  try {
    ws.on("error", console.error);
    // Filled in from start message
    let streamSid;
    let callSid;

    const gptService = new GptService();
    const streamService = new StreamService(ws);
    const transcriptionService = new TranscriptionService();
    const ttsService = new TextToSpeechService({});

    let marks = [];
    let interactionCount = 0;

    // Incoming from MediaStream
    ws.on("message", function message(data) {
      const msg = JSON.parse(data);
      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        streamService.setStreamSid(streamSid);
        gptService.setCallSid(callSid);
        recordingService(ttsService, callSid).then(() => {
          console.log(
            `Twilio -> Starting Media Stream for ${streamSid}`.underline.red
          );
          ttsService.generate(gptService.getInitialGreeting(), 0);
        });
      } else if (msg.event === "media") {
        transcriptionService.send(msg.media.payload);
      } else if (msg.event === "mark") {
        const label = msg.mark.name;
        console.log(
          `Twilio -> Audio completed mark (${msg.sequenceNumber}): ${label}`.red
        );
        marks = marks.filter((m) => m !== msg.mark.name);
      } else if (msg.event === "stop") {
        console.log(`Twilio -> Media stream ${streamSid} ended.`.underline.red);
      }
    });

    transcriptionService.on("utterance", async (text) => {
      console.log(`[STT-INTERIM] ${text}`);
      if (marks.length > 0 && text?.length > 5) {
        console.log("Twilio -> Interruption, Clearing stream".red);
        ws.send(JSON.stringify({ streamSid, event: "clear" }));
      }
    });

    transcriptionService.on("transcription", async (text) => {
      if (!text) return;
      console.log(
        `Interaction ${interactionCount} – STT -> GPT: ${text}`.yellow
      );
      gptService.completion(text, interactionCount);
      interactionCount += 1;
    });

    gptService.on("gptreply", async (gptReply, icount) => {
      console.log(
        `Interaction ${icount}: GPT -> TTS: ${gptReply.partialResponse}`.green
      );
      ttsService.generate(gptReply, icount);
    });

    ttsService.on("speech", (responseIndex, audio, label, icount) => {
      console.log(`Interaction ${icount}: TTS -> TWILIO: ${label}`.blue);
      streamService.buffer(responseIndex, audio);
    });

    streamService.on("audiosent", (markLabel) => {
      marks.push(markLabel);
    });
  } catch (err) {
    console.log(err);
  }
});

// ==================================================================
// == PRIVATE ROUTES (FOR DASHBOARD) - AUTHENTICATION REQUIRED ==
// ==================================================================

// --- Basic Authentication Setup ---
const users = {};
const user = process.env.DASHBOARD_USERNAME || "admin";
const password = process.env.DASHBOARD_PASSWORD || "password";
users[user] = password;

const authMiddleware = basicAuth({
  users,
  challenge: true,
  unauthorizedResponse: (req) =>
    req.auth
      ? `Credentials for ${req.auth.user} rejected`
      : "No credentials provided",
});

// Apply authentication to all routes defined after this point
app.use(authMiddleware);

// --- Authenticated API Endpoints ---
app.post("/api/dial", async (req, res) => {
  // ... (código do /api/dial que já funcionava, não precisa mudar)
  console.log("[API-DIAL] Request received.".blue);
  const { number } = req.body;
  if (!number) {
    console.error(
      "[API-DIAL] Error: Phone number is missing in the request body.".red
    );
    return res.status(400).json({ message: "Phone number is required" });
  }
  if (
    !process.env.FROM_NUMBER ||
    !process.env.SERVER ||
    !process.env.TWILIO_ACCOUNT_SID ||
    !process.env.TWILIO_AUTH_TOKEN
  ) {
    console.error(
      "[API-DIAL] CRITICAL: One or more required environment variables for Twilio are missing."
        .red
    );
    return res
      .status(500)
      .json({
        message:
          "Server configuration error. Check Twilio environment variables.",
      });
  }
  try {
    const callSid = await makeOutboundCall(number);
    console.log(
      `[API-DIAL] Call initiated successfully. SID: ${callSid}`.green
    );
    res.status(200).json({ message: "Call initiated successfully", callSid });
  } catch (error) {
    console.error(
      "[API-DIAL] CRITICAL: Caught an error while making the outbound call:"
        .red,
      error
    );
    res
      .status(500)
      .json({ message: "Failed to initiate call.", error: error.message });
  }
});

app.get("/api/prompt", (req, res) => {
  try {
    const promptConfig = JSON.parse(fs.readFileSync("prompt.json", "utf-8"));
    res.status(200).json(promptConfig);
  } catch (error) {
    console.error("Error reading prompt file:", error);
    res.status(500).send("Could not load prompt.");
  }
});

app.post("/api/prompt", (req, res) => {
  const { system_prompt, assistant_prompt } = req.body;
  if (!system_prompt || !assistant_prompt) {
    return res
      .status(400)
      .send("Both system_prompt and assistant_prompt are required.");
  }
  try {
    const promptConfig = { system_prompt, assistant_prompt };
    fs.writeFileSync("prompt.json", JSON.stringify(promptConfig, null, 2));
    res.status(200).send("Prompt updated successfully.");
  } catch (error) {
    console.error("Error writing prompt file:", error);
    res.status(500).send("Failed to update prompt.");
  }
});

// --- Authenticated Static Files for Dashboard ---
app.use("/", express.static(path.join(__dirname, "public")));

// --- Server Start ---
app.listen(PORT, () => {
  console.log(`Server and dashboard running on port ${PORT}`.cyan);
  const promptFilePath = path.join(__dirname, "prompt.json");
  if (!fs.existsSync(promptFilePath)) {
    console.log("Creating default prompt.json file...".yellow);
    const defaultPrompts = {
      system_prompt:
        "Você é um representante de vendas outbound que vende AirPods da Apple. Você tem uma personalidade jovem e alegre. Mantenha suas respostas o mais breve possível, mas faça todo o possível para manter o interlocutor ao telefone sem ser rude. Não faça mais de uma pergunta por vez. Não faça suposições sobre quais valores inserir nas funções. Peça esclarecimentos se a solicitação de um usuário for ambígua. Fale todos os preços, incluindo a moeda. Ajude-os a decidir entre os AirPods, AirPods Pro e AirPods Max, fazendo perguntas como 'Você prefere fones de ouvido intra-auriculares ou sobre a orelha?'. Se eles estiverem tentando escolher entre os AirPods e os AirPods Pro, tente perguntar se eles precisam de cancelamento de ruído. Depois de saber qual modelo eles gostariam, pergunte quantos eles gostariam de comprar e tente fazê-los fazer um pedido. Você deve adicionar um símbolo '•' a cada 5 a 10 palavras em pausas naturais, onde sua resposta pode ser dividida para conversão de texto em fala.",
      assistant_prompt:
        "Olá! Entendo que você está procurando um par de AirPods, correto?",
    };
    fs.writeFileSync(promptFilePath, JSON.stringify(defaultPrompts, null, 2));
    console.log("Default prompt.json created successfully.".green);
  }
});
