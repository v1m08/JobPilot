// OpenAI Responses API adapter. Uses fetch so the unpacked extension needs no build.
export const OPENAI_MODELS = [
  { id: "gpt-5-mini", label: "GPT-5 mini (reasoning, lower cost)" },
  { id: "gpt-4.1", label: "GPT-4.1 (fast, no reasoning)" },
];

export const DEFAULT_OPENAI_MODEL = "gpt-5-mini";

function apiError(status, error = {}) {
  if (status === 401) return new Error("Your OpenAI API key was rejected. Check it in Settings.");
  if (status === 403) return new Error("Your OpenAI API key doesn't have access to that model. Try another model in Settings.");
  if (status === 404) return new Error("OpenAI model not found. Pick a different model in Settings.");
  if (error.code === "insufficient_quota") return new Error("Your OpenAI API account is out of quota. Check API billing and usage limits at platform.openai.com.");
  if (status === 429) return new Error("Rate limited by OpenAI. Wait a minute and try again.");
  if (status >= 500) return new Error("OpenAI's API had a server error. Try again in a moment.");
  return new Error(`OpenAI rejected the request (HTTP ${status}). Check your model and API account settings.`);
}

export function buildOpenAIRequest(model, { system, content, schema, effort = "low", maxTokens = 16000 }) {
  const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
  const input = parts.map((part) => {
    if (part.type === "text") return { type: "input_text", text: part.text };
    if (part.type === "document" && part.source?.media_type === "application/pdf") {
      return { type: "input_file", filename: "resume.pdf", file_data: `data:application/pdf;base64,${part.source.data}` };
    }
    throw new Error("Unsupported document type for OpenAI.");
  });
  const body = {
    model,
    instructions: system,
    input: [{ role: "user", content: input }],
    text: { format: { type: "json_schema", name: "jobpilot_result", strict: true, schema } },
    max_output_tokens: maxTokens,
    store: false,
  };
  if (model === "gpt-5-mini") body.reasoning = { effort };

  return body;
}

export async function callOpenAI(settings, opts) {
  if (!settings.openaiApiKey?.trim()) throw new Error("Add your OpenAI API key in Settings first.");
  const body = buildOpenAIRequest(settings.openaiModel || DEFAULT_OPENAI_MODEL, opts);
  let data;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    let response;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.openaiApiKey.trim()}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      data = await response.json();
    } catch (error) {
      if (error.name === "AbortError") throw new Error("OpenAI took too long (2 minutes). Try again.");
      throw new Error("Couldn't read a response from OpenAI. Check your internet connection and try again.");
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) break;
    const retryable = (response.status === 429 && data.error?.code !== "insufficient_quota") || response.status >= 500;
    if (!retryable || attempt === 2) throw apiError(response.status, data.error);
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = retryAfter > 0 ? Math.min(retryAfter * 1000, 30000) : 1000 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  return parseOpenAIResponse(data);
}

export function parseOpenAIResponse(data) {
  const messages = (data.output || []).filter((item) => item.type === "message" && (!item.role || item.role === "assistant"));
  const output = messages.flatMap((item) => item.content || []);
  if (output.some((part) => part.type === "refusal")) throw new Error("The model declined this request. Try rephrasing or a different model.");
  if (data.status === "incomplete") throw new Error("The OpenAI response was incomplete. Try again or select another model.");
  if (data.status !== "completed") throw new Error("OpenAI didn't complete the request. Try again.");
  // Intermediate commentary is a separate message, not part of the JSON answer.
  const answer = messages.filter((item) => item.phase === "final_answer").at(-1)
    || messages.filter((item) => item.phase !== "commentary").at(-1);
  const text = (answer?.content || []).filter((part) => part.type === "output_text").map((part) => part.text).join("");
  if (!text.trim()) {
    const error = new Error("OpenAI completed the request without an answer. Update the JobPilot bridge and try again.");
    error.code = "OPENAI_EMPTY_OUTPUT";
    throw error;
  }
  try {
    const result = JSON.parse(text);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    const error = new Error("OpenAI returned an answer that isn't a JSON object. Try again or select another model.");
    error.code = "OPENAI_INVALID_JSON";
    throw error;
  }
}
