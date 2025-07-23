import { OpenAIStream, StreamingTextResponse } from "ai";
import { ChatCompletionRequestMessage, Configuration, OpenAIApi } from "openai";
import fullScriptLogic from "@/utils/fullScriptLogic";
import { getSavedProgress, saveUserResponse } from "@/utils/session";
import { detectFAQ, answerFAQ } from "@/utils/faqs";
import { getUserLanguagePreference } from "@/utils/language";
import { buildInitiateMessage } from "@/utils/initiate";

// GPT models
const config = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
const openai = new OpenAIApi(config);

export const runtime = "edge";

export async function POST(req: Request): Promise<Response> {
  const body = await req.json();
  const messages: ChatCompletionRequestMessage[] = body.messages;

  const userInput = messages[messages.length - 1].content.trim().toLowerCase();

  // INITIATE message handling
  if (userInput === "initiate" && messages.length === 1) {
    const initiateMessage = await buildInitiateMessage();
    return new Response(JSON.stringify({ message: initiateMessage }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Fallback humor for off-topic inputs
  const offTopicTriggers = ["tell me a joke", "who are you", "what's your name", "marry me"];
  const cheekyFallbacks = [
    "That’s a plot twist I didn’t see coming… but let’s stick to becoming debt-free, yeah?",
    "I'm flattered you think I can do that, but I'm all about debt solutions, not dating.",
    "Haha – cheeky! Let’s get back on track with your debts.",
  ];
  if (offTopicTriggers.some((trigger) => userInput.includes(trigger))) {
    const fallback = cheekyFallbacks[Math.floor(Math.random() * cheekyFallbacks.length)];
    return new Response(JSON.stringify({ message: fallback }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // FAQ detection
  const matchedFAQ = detectFAQ(userInput);
  if (matchedFAQ) {
    const faqResponse = answerFAQ(matchedFAQ);
    return new Response(JSON.stringify({ message: faqResponse }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Session tracking (stubbed)
  const sessionId = body.sessionId || null;
  const savedState = sessionId ? await getSavedProgress(sessionId) : null;

  // Get next scripted response
  const nextMessage = fullScriptLogic(messages, savedState);
  if (sessionId) await saveUserResponse(sessionId, userInput, nextMessage);

  // Model switching: use GPT-4o if long input or complex flow
  const model =
    userInput.length > 150 || messages.length > 10 ? "gpt-4o" : "gpt-3.5-turbo";

  const response = await openai.createChatCompletion({
    model,
    messages: [...messages, { role: "assistant", content: nextMessage }],
    stream: true,
  });

  const stream = OpenAIStream(response);
  return new StreamingTextResponse(stream);
}
