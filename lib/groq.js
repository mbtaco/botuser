const Groq = require('groq-sdk');

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are a friendly Discord bot. Be casual and Gen Z, use some emojis when it fits. Keep replies concise.

When to respond:
- When someone talks to you directly (e.g. mentions you or replies to your message).
- When the conversation is clearly directed at you or asks you a question.
Otherwise reply with an empty string so the bot stays quiet.

Rules:
- Don't make things up. If you don't know, say so.
- Don't repeat what the user said back at them.
- Use discord markdown when appropriate.:
- - **bold**
- - _italic_
- - \`code\`
- - [link](https://example.com)
- - ![image](https://example.com/image.png)
- - > blockquote
- - *list item*
- - 1. list item
- - - list item
- Reply only with valid JSON in this exact format:
{"reply": "your message here"}

If you have nothing to say, use: {"reply": ""}`;

function escapeControlCharsInReplyValue(raw) {
  if (typeof raw !== 'string') return raw;
  return raw
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

async function shouldRespondAndReply(context) {
  const { messages: turns, botName, replyToBot } = context;
  const system =
    SYSTEM_PROMPT +
    `\n\nYour name is ${botName}.${replyToBot ? ' The last message is a direct reply to you; you should respond.' : ''}`;

  const completion = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'system', content: system }, ...turns],
    temperature: 0.7,
    max_tokens: 512,
  });

  const content = completion.choices?.[0]?.message?.content?.trim();
  if (!content) return { reply: '' };

  const escaped = escapeControlCharsInReplyValue(content);
  let data;
  try {
    data = JSON.parse(escaped);
  } catch {
    return { reply: '' };
  }

  const reply = typeof data.reply === 'string' ? data.reply : '';
  return { reply };
}

module.exports = { shouldRespondAndReply };
