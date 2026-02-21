const Groq = require('groq-sdk').Groq;
const { getPromptDescription, getAllCommandIds } = require('./adminCommands');

const MODEL = 'llama-3.1-8b-instant';

const SYSTEM_PROMPT = `You are deciding whether a Discord bot should reply to the latest message in this conversation, and if so, what to say.

The bot talks like Gen Z: casual, relatable, mostly lowercase. Use slang naturally when it fits (e.g. lowkey, fr, ngl, tbh, vibe, based, that's valid, deadass, bet, ig, tuff, etc.). Use emojis like Gen Z / TikTok do—one or two per message when it fits. How to use them: 😂, 💀, 😭🙏, 💔, or 🥀 when something's funny or "im dead"; ✌️ for chill / peace / vibes; 👊 fistbump ("bro"); 🔥 when something's really good ("that's fire"); ✨ for emphasis or something good; 🤝 for agreement or "deal"; 🙂‍↕️ for "i agree" or "i hear you". Don't force one in every message—only when it matches the tone.

Do not make things up. Only say what you know. If you are unsure or don't know something, say so (e.g. "idk", "not sure") or stay silent. Do not invent facts, links, code, or details just to please the user.

Keep each reply to one clear message. Length is fine when needed (explanations, code, detail)—but do not repeat yourself. Say each thing once; do not restate the same idea in different words or add a redundant summary at the end. If your reply would say the same phrase or meaning twice, remove the duplicate.

The bot is named "{botName}". It should respond when:
- It is clearly addressed (e.g. @mentioned, asked a question, or asked by name), OR
- The latest message is a direct reply to a previous message from the bot (the user is continuing the conversation with the bot), OR
- Someone in the conversation seems unsure, confused, or could use help (e.g. "I'm not sure...", "does anyone know...", "idk", "help?", "stuck on...", "how do I...", "why isn't this working") and the bot can give a useful, relevant answer. Jump in to be helpful in those cases.

Stay silent for general chat, greetings not aimed at the bot, or when the message is not for the bot. Do not reply to every message—only when you can add clear value (addressed, reply-to-bot, or someone clearly unsure and you can help).

Reply with a single JSON object only, no other text. Use this exact format:
{"reply": "...", "adminCommand": "" or one of the command ids below, "roleName": "" or the role name when needed, "newRoleName": "" or only for renameRole the new name}

When the bot should stay silent, use "reply": "" and "adminCommand": "". When the bot should respond, set "reply" to your message. Use "roleName" for: createRole (name to create), deleteRole (name of role to delete if they said it), renameRole (current role name), addToRole/removeFromRole (role name if they said it). For renameRole only, also set "newRoleName" to the new name. Otherwise leave "roleName" and "newRoleName" as "".

Critical: The bot cannot perform admin actions (clear messages, kick, ban, add role, etc.) by itself. When you set adminCommand, a confirm button will appear; the action only runs after the user clicks it. So NEVER say the action is already done (e.g. "Done!", "I cleared it", "I kicked them", "Cleared!"). Always say they need to confirm (e.g. "Press the button below to confirm", "Click to confirm"). If you do NOT set adminCommand, never claim you performed any such action—you did not.
{adminCommandHint}

You may use Discord markdown when helpful: **bold**, *italic*, \`inline code\`, and multi-line code blocks with \`\`\`language on their own lines. Keep replies concise for simple questions; use longer messages and code blocks when the user asks for code, explanations, or detailed answers. Escape any quotes inside the reply string for valid JSON.`;

/**
 * Calls Groq to decide whether the bot should respond and to get the reply text.
 * Uses one LLM call with structured JSON output to save rate limits.
 *
 * @param {{ conversation: string, botName: string, isAdmin?: boolean }} context - Conversation history, bot name, and whether the user is server admin/owner
 * @returns {Promise<{ reply?: string, adminCommand?: string, roleName?: string, newRoleName?: string }>}
 */
async function shouldRespondAndReply(context) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('GROQ_API_KEY is not set. Copy .env.example to .env and add your API key.');
    return { reply: '' };
  }

  const validIds = getAllCommandIds();
  const adminCommandHint = context.isAdmin
    ? `Only set "adminCommand" when the user EXPLICITLY ASKS the bot to perform that action (e.g. "clear the messages", "kick @user", "add @user to Moderator"). Do NOT set adminCommand when they are only discussing or mentioning a topic (e.g. talking about message history without asking to clear it, or mentioning roles without asking to add/remove anyone). When they do explicitly request an action, set "adminCommand" to exactly one of these ids and your reply should say you can do it and they need to press the confirm button. Only use these ids: ${validIds.join(', ')}. When to use each:\n${getPromptDescription()}\nOtherwise use "adminCommand": "".`
    : 'Never set adminCommand to anything; always use "adminCommand": "".';

  const client = new Groq({ apiKey });
  const systemContent = SYSTEM_PROMPT.replace('{botName}', context.botName || 'the bot').replace(
    '{adminCommandHint}',
    adminCommandHint
  );
  const userContent = context.conversation || '';

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      max_tokens: 1024,
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() ?? '';
    if (!raw) return { reply: '' };

    // Try to parse JSON (handle possible markdown code fence)
    let text = raw;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) text = jsonMatch[0];

    text = escapeControlCharsInReplyValue(text);
    const parsed = JSON.parse(text);
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
    const rawCmd = typeof parsed.adminCommand === 'string' ? parsed.adminCommand.trim() : '';
    const adminCommand = validIds.includes(rawCmd) ? rawCmd : undefined;
    const roleCommands = ['createRole', 'deleteRole', 'renameRole', 'addToRole', 'removeFromRole'];
    const roleName =
      adminCommand && roleCommands.includes(adminCommand) && typeof parsed.roleName === 'string' && parsed.roleName.trim()
        ? parsed.roleName.trim().slice(0, 100)
        : undefined;
    const newRoleName =
      adminCommand === 'renameRole' && typeof parsed.newRoleName === 'string' && parsed.newRoleName.trim()
        ? parsed.newRoleName.trim().slice(0, 100)
        : undefined;

    return { reply: reply || undefined, adminCommand, roleName, newRoleName };
  } catch (err) {
    console.error('Groq API error:', err.message);
    return { reply: '' };
  }
}

/**
 * Escapes literal newlines, carriage returns, and tabs inside the "reply" JSON string value
 * so JSON.parse can succeed. The LLM sometimes outputs multi-line reply content with
 * unescaped control characters.
 */
function escapeControlCharsInReplyValue(jsonStr) {
  const key = '"reply"';
  const keyIdx = jsonStr.indexOf(key);
  if (keyIdx === -1) return jsonStr;
  const valueStart = jsonStr.indexOf('"', keyIdx + key.length);
  if (valueStart === -1) return jsonStr;
  let i = valueStart + 1;
  let result = jsonStr.slice(0, i);
  while (i < jsonStr.length) {
    const c = jsonStr[i];
    if (c === '\\') {
      result += c + (jsonStr[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (c === '"') {
      result += jsonStr.slice(i);
      return result;
    }
    if (c === '\n') {
      result += '\\n';
      i++;
      continue;
    }
    if (c === '\r') {
      result += '\\r';
      i++;
      continue;
    }
    if (c === '\t') {
      result += '\\t';
      i++;
      continue;
    }
    result += c;
    i++;
  }
  return result;
}

module.exports = { shouldRespondAndReply };
