/**
 * Server-only Gemini sales agent with function calling.
 * GEMINI_API_KEY / GEMINI_MODEL are read at call time.
 */

export interface AiHistoryTurn {
  senderType: "CUSTOMER" | "AI" | "HUMAN";
  content: string;
}

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type AiReplyResult =
  | { ok: true; text: string; model: string }
  | { ok: false; code: "NOT_CONFIGURED" | "UPSTREAM_ERROR" | "QUOTA_EXCEEDED"; message: string };

export function isGeminiConfigured() {
  return Boolean(process.env["GEMINI_API_KEY"]);
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});

export const SALES_TOOLS = [
  { name: "search_products", description: "Search the live catalog. Return one product when the customer names a specific one; several (3-5) for broad requests.", parameters: obj({ query: { type: "string" }, max_results: { type: "integer" } }, ["query"]) },
  { name: "get_product", description: "Get one product by id.", parameters: obj({ product_id: { type: "string" } }, ["product_id"]) },
  { name: "get_cart", description: "Get the current customer's cart.", parameters: obj({ note: { type: "string" } }) },
  { name: "add_to_cart", description: "Add a product to the cart (increases quantity if already there).", parameters: obj({ product_id: { type: "string" }, quantity: { type: "integer" } }, ["product_id", "quantity"]) },
  { name: "update_cart", description: "Set the FINAL quantity of a cart item (0 removes). 'ziwe/iwe N' = set to N. 'ongeza N' = current+N, 'punguza N' = current-N: call get_cart first and pass the final number.", parameters: obj({ product_id: { type: "string" }, quantity: { type: "integer" } }, ["product_id", "quantity"]) },
  { name: "remove_from_cart", description: "Remove a product from the cart.", parameters: obj({ product_id: { type: "string" } }, ["product_id"]) },
  { name: "create_order", description: "Place the order from the current cart. Only call after the customer confirmed the cart AND gave delivery location. A receipt is sent automatically.", parameters: obj({ customer_name: { type: "string" }, delivery_address: { type: "string" }, payment_method: { type: "string" }, notes: { type: "string" } }, ["delivery_address"]) },
  { name: "get_order_status", description: "List the customer's recent orders.", parameters: obj({ note: { type: "string" } }) },
  { name: "handoff_to_human", description: "Transfer the chat to a human staff member.", parameters: obj({ reason: { type: "string" } }, ["reason"]) },
];

export const UNIVERSAL_RULES = `
You are an AI sales agent inside a WhatsApp shop.
- Use tools for products, prices, stock, carts and orders. Never invent business data.
- Never print image URLs; product photos are sent automatically after you call search_products/get_product.
- Never fake buttons or markdown links.
- When the customer says "hii", "hiyo", "ile", "ya kwanza", "ya pili", use the RECENTLY SHOWN PRODUCTS list. For "nyingine", avoid already-shown products.
- A cart is not an order. Before create_order, show the cart total and ask for delivery location; then call create_order. Never claim an order exists unless create_order succeeded. Do not repeat the full receipt – it is sent automatically.
- For quantity changes follow the update_cart rules exactly.
- If the customer wants a person, call handoff_to_human.
- Reply mainly in natural Tanzanian Swahili, follow the customer's language, keep messages short.
`;

interface Part {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: unknown;
  [k: string]: unknown;
}

export async function generateSalesReply(args: {
  systemInstruction: string;
  history: AiHistoryTurn[];
  message: string;
  executeTool: ToolExecutor;
}): Promise<AiReplyResult> {
  const apiKey = process.env["GEMINI_API_KEY"];
  const model = process.env["GEMINI_MODEL"] ?? "gemini-2.5-flash";
  if (!apiKey) {
    return { ok: false, code: "NOT_CONFIGURED", message: "Add GEMINI_API_KEY to enable AI replies." };
  }

  const contents: { role: string; parts: Part[] }[] = [
    ...args.history.map((t) => ({ role: t.senderType === "CUSTOMER" ? "user" : "model", parts: [{ text: t.content }] })),
    { role: "user", parts: [{ text: args.message }] },
  ];

  try {
    for (let turn = 0; turn < 6; turn++) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: `${UNIVERSAL_RULES}\n\n${args.systemInstruction}` }] },
            contents,
            tools: [{ functionDeclarations: SALES_TOOLS }],
            generationConfig: { temperature: 0.35, maxOutputTokens: 1200 },
          }),
        },
      );
      const payload = (await res.json()) as {
        candidates?: { content?: { parts?: Part[] } }[];
        error?: { message?: string };
      };
      if (!res.ok) {
        return { ok: false, code: "UPSTREAM_ERROR", message: payload.error?.message ?? `Gemini ${res.status}` };
      }
      const parts = payload.candidates?.[0]?.content?.parts ?? [];
      const calls = parts.filter((p) => p.functionCall);
      if (!calls.length) {
        const text = parts.map((p) => p.text ?? "").join("").trim();
        if (!text) return { ok: false, code: "UPSTREAM_ERROR", message: "Gemini returned an empty response." };
        return { ok: true, text, model };
      }
      // Preserve original parts (keeps thoughtSignature intact).
      contents.push({ role: "model", parts });
      const responses: Part[] = [];
      for (const p of calls) {
        const name = p.functionCall!.name;
        let result: unknown;
        try {
          result = await args.executeTool(name, p.functionCall!.args ?? {});
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        const response = result && typeof result === "object" && !Array.isArray(result) ? result : { value: result };
        responses.push({ functionResponse: { name, response } });
      }
      contents.push({ role: "user", parts: responses });
    }
    return { ok: false, code: "UPSTREAM_ERROR", message: "AI tool loop exceeded its limit." };
  } catch (error) {
    return { ok: false, code: "UPSTREAM_ERROR", message: error instanceof Error ? error.message : "Gemini request failed" };
  }
}
