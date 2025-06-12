// file: test-deepgram.js

// Make sure to load environment variables for this test script
require("dotenv").config();
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");

console.log("--- Iniciando Teste de Conexão com Deepgram ---");

// CRITICAL: Let's re-verify the API key right here.
// Is it printing the key correctly or is it 'undefined'?
const apiKey = process.env.DEEPGRAM_API_KEY;
console.log(
  "API Key Carregada:",
  apiKey
    ? `Sim, uma chave de ${apiKey.length} caracteres foi encontrada.`
    : "Não, a chave é UNDEFINED."
);

if (!apiKey) {
  console.error(
    "ERRO: A variável de ambiente DEEPGRAM_API_KEY não foi encontrada. Pare o script e corrija seu arquivo .env ou a forma como as variáveis são carregadas."
  );
  return;
}

try {
  // Initialize the client
  const deepgram = createClient(apiKey);

  // Create the live connection with the exact same parameters
  const connection = deepgram.listen.live({
    model: "nova-2",
    language: "pt-BR",
    encoding: "mulaw",
    sample_rate: 8000,
    punctuate: true,
    smart_format: true,
    interim_results: true,
    endpointing: 300,
    utterance_end_ms: 1000,
  });

  // Listen for events
  connection.on(LiveTranscriptionEvents.Open, () => {
    console.log("SUCESSO: Conexão com Deepgram aberta com sucesso!".green);
    console.log("Aguardando 10 segundos antes de fechar...");

    // After 10 seconds, close the connection gracefully
    setTimeout(() => {
      console.log("Fechando a conexão.");
      connection.finish();
    }, 10000);
  });

  connection.on(LiveTranscriptionEvents.Error, (error) => {
    console.error("ERRO: O Deepgram retornou um erro.".red, error);
  });

  connection.on(LiveTranscriptionEvents.Close, () => {
    console.log("INFO: Conexão com Deepgram fechada.".yellow);
    console.log("--- Teste Finalizado ---");
  });
} catch (e) {
  console.error(
    "ERRO CRÍTICO: Ocorreu uma exceção ao tentar criar o cliente Deepgram.".red,
    e
  );
}
