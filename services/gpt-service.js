// FILE: services/gpt-service.js
// DESCRIPTION: Manages interaction with OpenAI GPT, now with dynamic prompts from a file.

require("colors");
const EventEmitter = require("events");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const tools = require("../functions/function-manifest");

// Import all functions included in function manifest
const availableFunctions = {};
tools.forEach((tool) => {
  let functionName = tool.function.name;
  availableFunctions[functionName] = require(`../functions/${functionName}`);
});

class GptService extends EventEmitter {
  constructor() {
    super();
    this.openai = new OpenAI();
    this.userContext = this.loadPromptFromFile();
    this.partialResponseIndex = 0;
  }

  /**
   * Loads the system and assistant prompts from the prompt.json file.
   * @returns {Array<Object>} The initial user context array.
   */
  loadPromptFromFile() {
    try {
      const promptPath = path.join(__dirname, "..", "prompt.json");
      const promptData = JSON.parse(fs.readFileSync(promptPath, "utf-8"));

      console.log("[GPT] Loaded prompt from prompt.json".cyan);

      return [
        {
          role: "system",
          content: promptData.system_prompt,
        },
        {
          role: "assistant",
          content: promptData.assistant_prompt,
        },
      ];
    } catch (error) {
      console.error(
        "Error loading prompt.json, using default fallback.".red,
        error
      );
      // Fallback to a default prompt if the file doesn't exist or is invalid
      return [
        {
          role: "system",
          content: "You are a helpful assistant.",
        },
        {
          role: "assistant",
          content: "Hello! How can I help you today?",
        },
      ];
    }
  }

  /**
   * Returns the initial greeting message for TTS service.
   * @returns {{partialResponseIndex: null, partialResponse: string}}
   */
  getInitialGreeting() {
    // Find the assistant's first message from the context
    const initialAssistantMessage = this.userContext.find(
      (m) => m.role === "assistant"
    );
    return {
      partialResponseIndex: null,
      partialResponse: initialAssistantMessage
        ? initialAssistantMessage.content
        : "Hello.",
    };
  }

  // Add the callSid to the chat context in case
  // ChatGPT decides to transfer the call.
  setCallSid(callSid) {
    this.userContext.push({ role: "system", content: `callSid: ${callSid}` });
  }

  validateFunctionArgs(args) {
    try {
      return JSON.parse(args);
    } catch (error) {
      console.log(
        "Warning: Double function arguments returned by OpenAI:",
        args
      );
      // Seeing an error where sometimes we have two sets of args
      if (args.indexOf("{") != args.lastIndexOf("{")) {
        return JSON.parse(
          args.substring(args.indexOf(""), args.indexOf("}") + 1)
        );
      }
    }
  }

  updateUserContext(name, role, text) {
    if (name !== "user") {
      this.userContext.push({ role: role, name: name, content: text });
    } else {
      this.userContext.push({ role: role, content: text });
    }
  }

  async completion(text, interactionCount, role = "user", name = "user") {
    this.updateUserContext(name, role, text);

    // Step 1: Send user transcription to Chat GPT
    const stream = await this.openai.chat.completions.create({
      model: "gpt-4-1106-preview", // Consider using a more recent model if available
      messages: this.userContext,
      tools: tools,
      stream: true,
    });

    let completeResponse = "";
    let partialResponse = "";
    let functionName = "";
    let functionArgs = "";
    let finishReason = "";

    function collectToolInformation(deltas) {
      let name = deltas.tool_calls[0]?.function?.name || "";
      if (name) {
        functionName = name;
      }
      let args = deltas.tool_calls[0]?.function?.arguments || "";
      if (args) {
        // args are streamed as JSON string so we need to concatenate all chunks
        functionArgs += args;
      }
    }

    for await (const chunk of stream) {
      let content = chunk.choices[0]?.delta?.content || "";
      let deltas = chunk.choices[0].delta;
      finishReason = chunk.choices[0].finish_reason;

      // Step 2: check if GPT wanted to call a function
      if (deltas.tool_calls) {
        // Step 3: Collect the tokens containing function data
        collectToolInformation(deltas);
      }

      // need to call function on behalf of Chat GPT with the arguments it parsed from the conversation
      if (finishReason === "tool_calls") {
        const functionToCall = availableFunctions[functionName];
        const validatedArgs = this.validateFunctionArgs(functionArgs);

        const toolData = tools.find(
          (tool) => tool.function.name === functionName
        );
        const say = toolData.function.say;

        this.emit(
          "gptreply",
          {
            partialResponseIndex: null,
            partialResponse: say,
          },
          interactionCount
        );
        let functionResponse = await functionToCall(validatedArgs);

        // Step 4: send the info on the function call and function response to GPT
        this.updateUserContext(functionName, "function", functionResponse);

        await this.completion(
          functionResponse,
          interactionCount,
          "function",
          functionName
        );
      } else {
        // We use completeResponse for userContext
        completeResponse += content;
        // We use partialResponse to provide a chunk for TTS
        partialResponse += content;
        // Emit last partial response and add complete response to userContext
        if (content.trim().slice(-1) === "•" || finishReason === "stop") {
          const gptReply = {
            partialResponseIndex: this.partialResponseIndex,
            partialResponse,
          };
          this.emit("gptreply", gptReply, interactionCount);
          this.partialResponseIndex++;
          partialResponse = "";
        }
      }
    }
    this.userContext.push({ role: "assistant", content: completeResponse });
    console.log(`GPT -> user context length: ${this.userContext.length}`.green);
  }
}

module.exports = { GptService };
