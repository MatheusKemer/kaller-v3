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
const { StreamService } = require("./services/stream-service"); //
const { TranscriptionService } = require("./services/transcription-service");
const { TextToSpeechService } = require("./services/tts-service");
const { recordingService } = require("./services/recording-service");
const { makeOutboundCall } = require("./scripts/outbound-call-api"); // Vamos criar este arquivo a seguir

const VoiceResponse = require("twilio").twiml.VoiceResponse;

// --- App Setup ---
const app = express();
ExpressWs(app);
const PORT = process.env.PORT || 3000; //

// --- Middleware ---
// Parse JSON bodies for API requests
app.use(express.json());

// --- Basic Authentication ---
// IMPORTANT: Set YOUR_USERNAME and YOUR_PASSWORD in your .env file
const users = {};
const user = process.env.DASHBOARD_USERNAME || "admin";
const password = process.env.DASHBOARD_PASSWORD || "password";
users[user] = password;

const unauthResponse = (req) => {
  return req.auth
    ? `Credentials ${req.auth.user}:${req.auth.password} rejected`
    : "No credentials provided";
};

const authMiddleware = basicAuth({
  users,
  challenge: true, // Shows a login prompt in the browser
  unauthorizedResponse: unauthResponse,
});

// --- API Endpoints for Dashboard ---
app.post("/api/dial", authMiddleware, async (req, res) => {
  console.log("[API-DIAL] Request received.".blue);
  const { number } = req.body;

  if (!number) {
    console.error(
      "[API-DIAL] Error: Phone number is missing in the request body.".red
    );
    return res.status(400).json({ message: "Phone number is required" });
  }

  // Log the variables being used to make sure they are loaded correctly
  console.log("[API-DIAL] Attempting call with the following config:".yellow);
  console.log(`[API-DIAL] -> To: ${number}`);
  console.log(`[API-DIAL] -> From: ${process.env.FROM_NUMBER}`);
  console.log(
    `[API-DIAL] -> Server URL for Twilio Webhook: https://${process.env.SERVER}/incoming`
  );

  // Check for missing ENV VARS
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
    // This block will catch errors from makeOutboundCall
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

app.get("/api/prompt", authMiddleware, (req, res) => {
  try {
    const promptConfig = JSON.parse(fs.readFileSync("prompt.json", "utf-8"));
    res.status(200).json(promptConfig);
  } catch (error) {
    console.error("Error reading prompt file:", error);
    res.status(500).send("Could not load prompt.");
  }
});

app.post("/api/prompt", authMiddleware, (req, res) => {
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

// --- Static Files for Dashboard ---
// Serve the public directory under authentication
app.use("/", authMiddleware, express.static(path.join(__dirname, "public")));

// --- Twilio WebHook for Incoming Calls ---
app.post("/incoming", (req, res) => {
  try {
    const response = new VoiceResponse();
    const connect = response.connect();
    connect.stream({ url: `wss://${process.env.SERVER}/connection` });

    res.type("text/xml");
    res.end(response.toString());
  } catch (err) {
    console.log(err);
  }
});

// --- Twilio Media Stream WebSocket Connection ---
app.ws("/connection", (ws) => {
  //
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

        // Set RECORDING_ENABLED='true' in .env to record calls
        recordingService(ttsService, callSid).then(() => {
          console.log(
            `Twilio -> Starting Media Stream for ${streamSid}`.underline.red
          );
          // Use the initial greeting from GptService
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
      // Log interim transcripts from Deepgram
      console.log(`[STT-INTERIM] ${text}`);
      if (marks.length > 0 && text?.length > 5) {
        console.log("Twilio -> Interruption, Clearing stream".red);
        ws.send(JSON.stringify({ streamSid, event: "clear" }));
      }
    });

    transcriptionService.on("transcription", async (text) => {
      //
      if (!text) {
        return;
      }
      console.log(
        `Interaction ${interactionCount} – STT -> GPT: ${text}`.yellow
      );
      gptService.completion(text, interactionCount);
      interactionCount += 1;
    });

    gptService.on("gptreply", async (gptReply, icount) => {
      //
      console.log(
        `Interaction ${icount}: GPT -> TTS: ${gptReply.partialResponse}`.green
      );
      ttsService.generate(gptReply, icount);
    });

    ttsService.on("speech", (responseIndex, audio, label, icount) => {
      //
      console.log(`Interaction ${icount}: TTS -> TWILIO: ${label}`.blue);

      streamService.buffer(responseIndex, audio);
    });

    streamService.on("audiosent", (markLabel) => {
      //
      marks.push(markLabel);
    });
  } catch (err) {
    console.log(err);
  }
});

// --- Server Start ---
app.listen(PORT, () => {
  console.log(`Server and dashboard running on port ${PORT}`.cyan);
  const promptFilePath = path.join(__dirname, "prompt.json");

  // Check if prompt.json exists, if not, create it with default values
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
