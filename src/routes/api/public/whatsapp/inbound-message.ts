/**
 * Inbound WhatsApp message from the external worker.
 *
 * POST /api/public/whatsapp/inbound-message
 * Authorization: Bearer <WHATSAPP_WORKER_TOKEN>
 *
 * The business is resolved from the stored WhatsApp account, never from the
 * request body. The message is stored, and when the conversation is in AI mode
 * an AI reply is generated and returned for the worker to send.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Body = z.object({
  accountId: z.string().uuid(),
  phone: z.string().min(5).max(32),
  jid: z.string().max(120).nullish(),
  name: z.string().max(120).nullish(),
  message: z.string().min(1).max(8000),
  externalId: z.string().max(200).nullish(),
  messageType: z
    .enum(["TEXT", "IMAGE", "AUDIO", "VIDEO", "DOCUMENT", "LOCATION", "OTHER"])
    .default("TEXT"),
  fromMe: z.boolean().optional(),
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/whatsapp/inbound-message")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = process.env["WHATSAPP_WORKER_TOKEN"];
        if (!token) return json({ ok: false, code: "NOT_CONFIGURED" }, 503);
        if (request.headers.get("authorization") !== `Bearer ${token}`) {
          return json({ ok: false, code: "UNAUTHORIZED" }, 401);
        }

        const parsed = Body.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return json({ ok: false, code: "INVALID_REQUEST", message: "Invalid payload" }, 400);
        }
        const input = parsed.data;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: account } = await supabaseAdmin
          .from("whatsapp_accounts")
          .select("id, business_id")
          .eq("id", input.accountId)
          .maybeSingle();
        if (!account) return json({ ok: false, code: "UNKNOWN_ACCOUNT" }, 404);

        const businessId = account.business_id;
        const now = new Date().toISOString();

        // Owner commands typed from the business phone (/takeover, /release, /status)
        if (input.fromMe) {
          const cmd = input.message.trim().toLowerCase();
          const { data: c } = await supabaseAdmin
            .from("contacts").select("id").eq("business_id", businessId).eq("phone", input.phone).maybeSingle();
          if (!c) return json({ ok: true, reply: null, reason: "NO_CONTACT" });
          const { data: conv } = await supabaseAdmin
            .from("conversations").select("id, ai_mode").eq("business_id", businessId).eq("contact_id", c.id)
            .eq("status", "OPEN").order("last_message_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
          if (!conv) return json({ ok: true, reply: null, reason: "NO_CONVERSATION" });
          if (["/takeover", "/off", "/human"].includes(cmd)) {
            await supabaseAdmin.from("conversations").update({ ai_mode: "HUMAN_ACTIVE" }).eq("id", conv.id);
          } else if (["/release", "/on", "/ai"].includes(cmd)) {
            await supabaseAdmin.from("conversations").update({ ai_mode: "AI_ACTIVE" }).eq("id", conv.id);
          }
          return json({ ok: true, reply: null, ownerCommand: cmd });
        }

        // contact
        const { data: existingContact } = await supabaseAdmin
          .from("contacts")
          .select("id")
          .eq("business_id", businessId)
          .eq("phone", input.phone)
          .maybeSingle();

        let contactId = existingContact?.id ?? null;
        if (contactId) {
          await supabaseAdmin
            .from("contacts")
            .update({ last_interaction_at: now, ...(input.jid ? { jid: input.jid } : {}) })
            .eq("id", contactId);
        } else {
          const { data: created, error } = await supabaseAdmin
            .from("contacts")
            .insert({
              business_id: businessId,
              phone: input.phone,
              name: input.name ?? null,
              jid: input.jid ?? null,
              last_interaction_at: now,
            })
            .select("id")
            .single();
          if (error || !created) return json({ ok: false, code: "DB_ERROR" }, 500);
          contactId = created.id;
        }

        // conversation
        const { data: openConversation } = await supabaseAdmin
          .from("conversations")
          .select("id, ai_mode")
          .eq("business_id", businessId)
          .eq("contact_id", contactId)
          .eq("status", "OPEN")
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle();

        let conversationId = openConversation?.id ?? null;
        let aiMode = openConversation?.ai_mode ?? "AI_ACTIVE";
        if (conversationId) {
          await supabaseAdmin
            .from("conversations")
            .update({ last_message_at: now })
            .eq("id", conversationId);
        } else {
          const { data: created, error } = await supabaseAdmin
            .from("conversations")
            .insert({
              business_id: businessId,
              contact_id: contactId,
              whatsapp_account_id: account.id,
              last_message_at: now,
            })
            .select("id, ai_mode")
            .single();
          if (error || !created) return json({ ok: false, code: "DB_ERROR" }, 500);
          conversationId = created.id;
          aiMode = created.ai_mode;
        }

        await supabaseAdmin.from("messages").insert({
          business_id: businessId,
          conversation_id: conversationId,
          sender_type: "CUSTOMER",
          sender: input.phone,
          content: input.message,
          message_type: input.messageType,
          external_id: input.externalId ?? null,
        });
        await supabaseAdmin
          .from("usage_events")
          .insert({ business_id: businessId, event_type: "MESSAGE", quantity: 1 });

        if (aiMode !== "AI_ACTIVE") {
          return json({ ok: true, conversationId, reply: null, reason: "HUMAN_ACTIVE" });
        }

        const { data: prompt } = await supabaseAdmin
          .from("ai_prompts")
          .select("ai_enabled")
          .eq("business_id", businessId)
          .maybeSingle();
        if (prompt && prompt.ai_enabled === false) {
          return json({ ok: true, conversationId, reply: null, reason: "AI_DISABLED" });
        }

        // Subscription quota
        const { canSendAiReply } = await import("@/lib/plans");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: sub } = await (supabaseAdmin as any)
          .from("businesses")
          .select("plan_id, plan_started_at, plan_expires_at, ai_replies_used, created_at")
          .eq("id", businessId)
          .maybeSingle();
        if (sub && !canSendAiReply(sub)) {
          return json({ ok: true, conversationId, reply: null, reason: "QUOTA_EXCEEDED" });
        }

        const { buildAiReply } = await import("@/lib/ai-reply.server");
        const result = await buildAiReply(supabaseAdmin, {
          businessId,
          conversationId,
          contactId: contactId!,
          customerPhone: input.phone,
          customerName: input.name ?? null,
          customerMessage: input.message,
        });

        if (!result.ok) {
          return json({
            ok: true,
            conversationId,
            reply: null,
            reason: result.code,
            message: result.message,
          });
        }

        await supabaseAdmin.from("messages").insert({
          business_id: businessId,
          conversation_id: conversationId,
          sender_type: "AI",
          content: result.text,
          message_type: "TEXT",
          metadata: { model: result.model, shown: result.shown },
        });
        if (result.receipt) {
          await supabaseAdmin.from("messages").insert({
            business_id: businessId,
            conversation_id: conversationId,
            sender_type: "AI",
            content: result.receipt,
            message_type: "TEXT",
            metadata: { kind: "receipt" },
          });
        }
        if (sub) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabaseAdmin as any)
            .from("businesses")
            .update({ ai_replies_used: (sub.ai_replies_used ?? 0) + 1 })
            .eq("id", businessId);
        }
        await supabaseAdmin.from("usage_events").insert({
          business_id: businessId,
          event_type: "AI_REPLY",
          quantity: 1,
          metadata: { model: result.model },
        });
        await supabaseAdmin
          .from("conversations")
          .update({ last_message_at: new Date().toISOString() })
          .eq("id", conversationId);

        return json({
          ok: true,
          conversationId,
          reply: result.text,
          media: result.media,
          receipt: result.receipt,
          model: result.model,
        });
      },
    },
  },
});
