/**
 * Server-only AI sales pipeline: catalog search, cart, orders, receipts,
 * product photos and human handoff, backed by the database.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { generateSalesReply, type AiReplyResult } from "@/lib/gemini.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = SupabaseClient<Database> | SupabaseClient<any>;

export interface OutboundMedia {
  type: "image";
  url: string;
  caption: string;
}

export interface CartItem {
  product_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  image_url: string | null;
}

export interface BuildAiReplyInput {
  businessId: string;
  conversationId: string;
  contactId: string;
  customerPhone: string;
  customerName: string | null;
  customerMessage: string;
}

export type SalesReply =
  | {
      ok: true;
      text: string;
      model: string;
      media: OutboundMedia[];
      receipt: string | null;
      shownProductIds: string[];
      shown: { id: string; name: string }[];
      handoff: boolean;
    }
  | Extract<AiReplyResult, { ok: false }>;

const STOP = new Set(["the", "and", "for", "you", "naomba", "nataka", "bei", "gani", "je", "na", "ya", "wa", "kwa", "ni", "mna", "ipo", "zipo", "hii", "hiyo"]);
const ALIASES: Record<string, string[]> = {
  nguo: ["dress", "shirt", "gauni", "suruali", "tshirt"],
  viatu: ["shoes", "sneakers", "raba", "sandals"],
  simu: ["phone", "iphone", "samsung"],
  saa: ["watch"],
};

function terms(q: string) {
  const raw = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && !STOP.has(w));
  const out = new Set(raw);
  raw.forEach((t) => (ALIASES[t] ?? []).forEach((a) => out.add(a)));
  return [...out];
}

export function formatTzs(n: number, currency = "TZS") {
  return `${currency} ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n)}`;
}

export function cartTotal(items: CartItem[]) {
  return items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
}

export function buildReceipt(o: {
  orderNumber: string;
  customer: string;
  address: string;
  date: Date;
  items: CartItem[];
  currency: string;
  paymentMethod: string | null;
  businessName: string;
}) {
  const lines = o.items.map((i) => `• ${i.name} × ${i.quantity} — ${formatTzs(i.unit_price * i.quantity, o.currency)}`).join("\n");
  const d = o.date.toLocaleString("en-GB", { timeZone: "Africa/Dar_es_Salaam", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return [
    `🧾 *RISITI YA ODA* — ${o.businessName}`,
    ``,
    `📌 Namba ya Oda: *${o.orderNumber}*`,
    `👤 Mteja: ${o.customer}`,
    `📍 Mahali pa kupeleka: ${o.address}`,
    `📅 Tarehe: ${d}`,
    ``,
    `🛒 Bidhaa:`,
    lines,
    ``,
    `💰 *JUMLA KUU: ${formatTzs(cartTotal(o.items), o.currency)}*`,
    `💳 Malipo: ${o.paymentMethod || "Tutawasiliana nawe kuhusu malipo"}`,
    `📦 Hali: Inasubiri uthibitisho`,
    ``,
    `🙏 Asante kwa kuagiza nasi!`,
  ].join("\n");
}

export async function buildAiReply(supabaseIn: Client, input: BuildAiReplyInput): Promise<SalesReply> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = supabaseIn as SupabaseClient<any>;
  const { businessId, conversationId, contactId } = input;

  const [businessRes, settingsRes, promptRes, knowledgeRes, historyRes, cartRes] = await Promise.all([
    supabase.from("businesses").select("*").eq("id", businessId).maybeSingle(),
    supabase.from("business_settings").select("*").eq("business_id", businessId).maybeSingle(),
    supabase.from("ai_prompts").select("*").eq("business_id", businessId).maybeSingle(),
    supabase.from("knowledge_base").select("title, category, content").eq("business_id", businessId).eq("status", "PUBLISHED").limit(100),
    supabase.from("messages").select("sender_type, content, metadata").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(16),
    supabase.from("carts").select("items").eq("business_id", businessId).eq("contact_id", contactId).maybeSingle(),
  ]);

  const business = businessRes.data;
  if (!business) return { ok: false, code: "UPSTREAM_ERROR", message: "Business not found" };
  const settings = settingsRes.data;
  const prompt = promptRes.data;
  const businessName = settings?.business_name ?? business.name;

  let cart: CartItem[] = Array.isArray(cartRes.data?.items) ? (cartRes.data!.items as CartItem[]) : [];
  const saveCart = async () => {
    await supabase.from("carts").upsert(
      { business_id: businessId, contact_id: contactId, items: cart, updated_at: new Date().toISOString() },
      { onConflict: "business_id,contact_id" },
    );
  };

  const historyRows = (historyRes.data ?? []).slice(1).reverse(); // newest row is the message just stored
  const recentShown: { id: string; name: string }[] = [];
  for (const row of [...historyRows].reverse()) {
    const ids = (row.metadata as { shown?: { id: string; name: string }[] } | null)?.shown;
    if (ids?.length) { recentShown.push(...ids); if (recentShown.length >= 8) break; }
  }

  const media: OutboundMedia[] = [];
  const shown = new Map<string, { id: string; name: string }>();
  let receipt: string | null = null;
  let handoff = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const showProduct = (p: any) => {
    if (shown.has(p.id)) return;
    shown.set(p.id, { id: p.id, name: p.name });
    if (p.image_url && media.length < 5) {
      media.push({
        type: "image",
        url: p.image_url,
        caption: [`🛍️ *${p.name}*`, `💰 ${formatTzs(Number(p.price), p.currency)}`, `📦 ${p.availability === "IN_STOCK" ? "Inapatikana" : p.availability === "PREORDER" ? "Pre-order" : "Imeisha kwa sasa"}`, p.description ?? ""].filter(Boolean).join("\n"),
      });
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const productPayload = (p: any) => ({ id: p.id, name: p.name, price: p.price, currency: p.currency, availability: p.availability, stock: p.stock, description: p.description, category: p.category, has_image: Boolean(p.image_url) });
  const getProduct = async (id: string) =>
    (await supabase.from("products").select("*").eq("business_id", businessId).eq("id", id).maybeSingle()).data;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const executeTool = async (name: string, a: any): Promise<unknown> => {
    switch (name) {
      case "search_products": {
        const { data } = await supabase.from("products").select("*").eq("business_id", businessId).limit(500);
        const t = terms(String(a.query ?? ""));
        const max = Math.min(8, Math.max(1, Number(a.max_results ?? 4)));
        const ranked = (data ?? [])
          .map((p) => {
            const name = String(p.name).toLowerCase();
            const hay = `${name} ${p.description ?? ""} ${p.category ?? ""} ${(p.tags ?? []).join(" ")}`.toLowerCase();
            const score = t.reduce((s, w) => s + (name.includes(w) ? 4 : hay.includes(w) ? 1 : 0), 0);
            return { p, score };
          })
          .filter((x) => x.score > 0 || t.length === 0)
          .sort((x, y) => y.score - x.score)
          .slice(0, max)
          .map((x) => x.p);
        ranked.forEach(showProduct);
        return { ok: true, products: ranked.map(productPayload) };
      }
      case "get_product": {
        const p = await getProduct(String(a.product_id ?? ""));
        if (!p) return { ok: false, error: "Product not found" };
        showProduct(p);
        return { ok: true, product: productPayload(p) };
      }
      case "get_cart":
        return { ok: true, items: cart, total: cartTotal(cart) };
      case "add_to_cart": {
        const p = await getProduct(String(a.product_id ?? ""));
        if (!p) return { ok: false, error: "Product not found" };
        if (p.availability === "OUT_OF_STOCK") return { ok: false, error: "Product is out of stock" };
        const qty = Math.max(1, Math.floor(Number(a.quantity ?? 1)));
        const line = cart.find((i) => i.product_id === p.id);
        const next = (line?.quantity ?? 0) + qty;
        if (p.stock > 0 && next > p.stock) return { ok: false, error: `Only ${p.stock} available` };
        if (line) line.quantity = next;
        else cart.push({ product_id: p.id, name: p.name, quantity: qty, unit_price: Number(p.price), image_url: p.image_url });
        await saveCart();
        return { ok: true, items: cart, total: cartTotal(cart) };
      }
      case "update_cart":
      case "remove_from_cart": {
        const id = String(a.product_id ?? "");
        const qty = name === "remove_from_cart" ? 0 : Math.max(0, Math.floor(Number(a.quantity ?? 0)));
        if (qty === 0) cart = cart.filter((i) => i.product_id !== id);
        else {
          const line = cart.find((i) => i.product_id === id);
          if (!line) return { ok: false, error: "Item not in cart" };
          line.quantity = qty;
        }
        await saveCart();
        return { ok: true, items: cart, total: cartTotal(cart) };
      }
      case "create_order": {
        if (!cart.length) return { ok: false, error: "Cart is empty" };
        const total = cartTotal(cart);
        const orderNumber = `ORD-${Date.now().toString(36).toUpperCase().slice(-6)}`;
        const currency = "TZS";
        const paymentMethod = (a.payment_method as string) || settings?.payment_methods || null;
        const { data: order, error } = await supabase
          .from("orders")
          .insert({
            business_id: businessId,
            contact_id: contactId,
            conversation_id: conversationId,
            order_number: orderNumber,
            total,
            currency,
            delivery_address: String(a.delivery_address ?? ""),
            payment_method: paymentMethod,
            notes: (a.notes as string) ?? null,
          })
          .select("id")
          .single();
        if (error || !order) return { ok: false, error: error?.message ?? "Could not create order" };
        await supabase.from("order_items").insert(
          cart.map((i) => ({ business_id: businessId, order_id: order.id, product_id: i.product_id, product_name: i.name, quantity: i.quantity, unit_price: i.unit_price, subtotal: i.unit_price * i.quantity })),
        );
        const customer = (a.customer_name as string) || input.customerName || input.customerPhone;
        if (a.customer_name) await supabase.from("contacts").update({ name: customer }).eq("id", contactId);
        await supabase.from("contacts").update({ stage: "ORDERED" }).eq("id", contactId);
        await supabase.from("usage_events").insert({ business_id: businessId, event_type: "ORDER", quantity: 1, metadata: { order_id: order.id } });
        receipt = buildReceipt({ orderNumber, customer, address: String(a.delivery_address ?? ""), date: new Date(), items: cart, currency, paymentMethod, businessName });
        cart = [];
        await saveCart();
        return { ok: true, order_number: orderNumber, total, note: "Receipt will be sent automatically." };
      }
      case "get_order_status": {
        const { data } = await supabase.from("orders").select("order_number, status, total, currency, created_at").eq("business_id", businessId).eq("contact_id", contactId).order("created_at", { ascending: false }).limit(5);
        return { ok: true, orders: data ?? [] };
      }
      case "handoff_to_human":
        handoff = true;
        await supabase.from("conversations").update({ ai_mode: "HUMAN_ACTIVE" }).eq("id", conversationId);
        return { ok: true, message: "A staff member will continue the chat." };
      default:
        return { ok: false, error: "Unknown tool" };
    }
  };

  const knowledge = (knowledgeRes.data ?? []).slice(0, 30).map((k) => `- [${k.category}] ${k.title}: ${k.content ?? ""}`).join("\n");
  const systemInstruction = [
    "BUSINESS OWNER INSTRUCTIONS:",
    prompt?.system_prompt ?? "Wewe ni msaidizi wa mauzo wa biashara hii kwenye WhatsApp.",
    `Personality: ${prompt?.personality ?? "Friendly"}. Response length: ${prompt?.response_length ?? "SHORT"}.`,
    "",
    "BUSINESS PROFILE",
    `Name: ${businessName}`,
    settings?.description ? `About: ${settings.description}` : "",
    settings?.location ? `Location: ${settings.location}` : "",
    settings?.opening_hours ? `Hours: ${settings.opening_hours}` : "",
    settings?.delivery_info ? `Delivery: ${settings.delivery_info}` : "",
    settings?.payment_methods ? `Payment methods: ${settings.payment_methods}` : "",
    business.contact_phone ? `Phone: ${business.contact_phone}` : "",
    "",
    "KNOWLEDGE",
    knowledge || "none",
    "",
    `CUSTOMER: ${input.customerName ?? "unknown name"} (${input.customerPhone})`,
    `CURRENT CART: ${cart.length ? cart.map((i) => `${i.product_id} | ${i.name} | qty=${i.quantity} | ${i.unit_price}`).join("; ") : "empty"}`,
    `RECENTLY SHOWN PRODUCTS (1 = first): ${recentShown.length ? recentShown.map((p, i) => `${i + 1}. ${p.id} | ${p.name}`).join("; ") : "none"}`,
  ].filter(Boolean).join("\n");

  const history = historyRows
    .filter((r) => r.content)
    .map((r) => ({ senderType: r.sender_type as "CUSTOMER" | "AI" | "HUMAN", content: r.content as string }));

  const result = await generateSalesReply({ systemInstruction, history, message: input.customerMessage, executeTool });
  if (!result.ok) return result;
  return { ...result, media, receipt, shownProductIds: [...shown.keys()], handoff, shown: [...shown.values()] };
}
