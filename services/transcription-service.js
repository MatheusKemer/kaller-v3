// services/TranscriptionService.js

// Import required packages
require("colors");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const { Buffer } = require("node:buffer");
const EventEmitter = require("events");

/**
 * @class TranscriptionService
 * @description Handles real-time transcription of audio streams using Deepgram.
 * It is specifically configured for Twilio Media Streams (mulaw, 8000Hz) and Brazilian Portuguese.
 * * @emits 'transcription' with the final transcript of a speech segment.
 * @emits 'utterance' with interim, non-final transcripts.
 */
class TranscriptionService extends EventEmitter {
  constructor() {
    super();

    // Initialize the Deepgram client
    const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

    // Create a live transcription connection with optimized settings for Twilio and PT-BR
    this.dgConnection = deepgram.listen.live({
      // --- Core Settings for Twilio & PT-BR ---
      model: "nova-2", // Best model for telephony audio
      language: "pt-BR", // Set language to Brazilian Portuguese
      encoding: "mulaw", // Audio encoding used by Twilio Media Streams
      sample_rate: 8000, // Sample rate used by Twilio Media Streams

      // --- Features for Better Transcription Quality ---
      punctuate: true, // Add punctuation (e.g., periods, commas)
      smart_format: true, // Format things like numbers, dates, etc.
      interim_results: true, // Get partial results for lower latency feedback

      // --- Endpointing Configuration ---
      // Determines when to finalize a transcript. Tune these for your use case.
      endpointing: 300, // ms of silence to trigger an endpoint
      utterance_end_ms: 1000, // ms of silence to consider an utterance complete

      // --- Optional: Boost accuracy for specific words ---
      // keywords: ["ajuda", "suporte", "cancelar:3", "atendente"],
    });

    this.finalResult = "";
    this.speechFinal = false; // Flag to track if a `speech_final` event has been received.

    this.setupEventListeners();
  }

  /**
   * Sets up the event listeners for the Deepgram connection.
   */
  setupEventListeners() {
    this.dgConnection.on(LiveTranscriptionEvents.Open, () => {
      console.log("[STT] Deepgram connection opened.".green);
    });

    this.dgConnection.on(LiveTranscriptionEvents.Transcript, (transcriptionEvent) => {
      const alternatives = transcriptionEvent.channel?.alternatives;
      const text = alternatives && alternatives[0]?.transcript
        ? alternatives[0].transcript
        : "";
      // Log every Deepgram transcription event for debugging (interim and final)
      console.log(
        `[STT] Deepgram event type=${transcriptionEvent.type} is_final=${transcriptionEvent.is_final} speech_final=${transcriptionEvent.speech_final} transcript="${text}"`
      );

        // The 'UtteranceEnd' event signals that Deepgram has detected the end of a segment of speech.
        // We use it as a fallback in case the stream ends without a `speech_final` event.
        if (transcriptionEvent.type === "UtteranceEnd") {
          if (!this.speechFinal && this.finalResult.length > 0) {
            console.log(
              `[STT] UtteranceEnd received before speechFinal. Emitting final result: "${this.finalResult}"`
                .yellow
            );
            this.emit("transcription", this.finalResult);
            this.finalResult = ""; // Reset for the next utterance
          } else {
            console.log(
              "[STT] UtteranceEnd received, but speech was already final. No action needed."
                .grey
            );
          }
          return;
        }

        // If `is_final` is true, the transcript segment is stable. We append it to our final result.
        if (transcriptionEvent.is_final && text.trim().length > 0) {
          this.finalResult += `${text} `;

          // If `speech_final` is also true, it means Deepgram detected a natural pause,
          // indicating the end of a complete thought or sentence. This is the ideal time to process the transcript.
          if (transcriptionEvent.speech_final) {
            this.speechFinal = true; // Mark that we've received a definitive end.
            console.log(
              `[STT] SpeechFinal received. Emitting final result: "${this.finalResult}"`
                .cyan
            );
            this.emit("transcription", this.finalResult);
            this.finalResult = ""; // Reset for the next utterance
          } else {
            // If we get a final segment that is not the end of speech, we reset the `speechFinal` flag.
            // This allows a subsequent UtteranceEnd to correctly finalize the transcript if needed.
            this.speechFinal = false;
          }
        } else if (text.trim().length > 0) {
          // This is an interim result, useful for displaying real-time feedback to a user.
          this.emit("utterance", text);
        }
      }
    );

    this.dgConnection.on(LiveTranscriptionEvents.Error, (error) => {
      console.error("[STT] Deepgram error:".red, error);
    });

    this.dgConnection.on(LiveTranscriptionEvents.Warning, (warning) => {
      console.warn("[STT] Deepgram warning:".yellow, warning);
    });

    this.dgConnection.on(LiveTranscriptionEvents.Metadata, (metadata) => {
      console.log("[STT] Deepgram metadata:".grey, metadata);
    });

    this.dgConnection.on(LiveTranscriptionEvents.Close, () => {
      console.log("[STT] Deepgram connection closed.".yellow);
    });
  }

  /**
   * Sends an audio payload to Deepgram for transcription.
   * @param {String} payload A base64 encoded string of MULAW/8000 audio from Twilio.
   */
  send(payload) {
    // Check if the connection is open before sending data
    if (this.dgConnection.getReadyState() === 1 /* OPEN */) {
      this.dgConnection.send(Buffer.from(payload, "base64"));
    }
  }

  /**
   * Gracefully closes the Deepgram connection and cleans up listeners.
   */
  close() {
    console.log("[STT] Closing Deepgram connection.".yellow);
    if (this.dgConnection) {
      this.dgConnection.finish();
    }
    this.removeAllListeners(); // Clean up event listeners to prevent memory leaks
  }
}

module.exports = { TranscriptionService };
