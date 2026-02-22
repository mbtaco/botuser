/**
 * Groq AI Integration Module
 * 
 * This module handles communication with the Groq API to generate AI responses.
 * It uses the Llama 3.3 70B model to create conversational, Gen Z-style replies
 * for the Discord bot.
 */

// Groq SDK for interacting with the Groq AI API
const Groq = require('groq-sdk');

// Initialize the Groq client with the API key from environment variables
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ============================================================================
// SYSTEM PROMPT
// ============================================================================
// This prompt defines the bot's personality and behavior rules
// The AI follows these instructions when generating responses
const SYSTEM_PROMPT = `You are a friendly Discord bot. Be casual and Gen Z, use some emojis when it fits. Keep replies concise.

When to respond:
- When someone talks to you directly (e.g. mentions you or replies to your message).
- When the conversation is clearly directed at you or asks you a question.
Otherwise reply with an empty string so the bot stays quiet.

Rules:
- Don't make things up. If you don't know, say so.
- Don't repeat what the user said back at them.
- You may use Discord markdown when it improves readability.
- Discord markdown examples you can use:
  - **bold**
  - *italic*
  - __underline__
  - ~~strikethrough~~
  - ||spoiler||
  - \`inline code\`
  - \`\`\`js
    const answer = 42;
    \`\`\`
  - > block quote
  - - list item
  - 1. numbered item
  - [link text](https://example.com)
- Reply only with valid JSON in this exact format:
{"reply": "your message here"}

If you have nothing to say, use: {"reply": ""}`;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Escapes control characters in the AI's response
 * 
 * The AI sometimes outputs literal newlines/tabs in its JSON response,
 * which breaks JSON.parse(). This function converts them to escaped versions
 * so the JSON can be parsed correctly.
 * 
 * @param {string} raw - The raw response string from the AI
 * @returns {string} The string with control characters escaped
 */
function escapeControlCharsInReplyValue(raw) {
  if (typeof raw !== 'string') return raw;
  return raw
    .replace(/\n/g, '\\n')  // Escape newlines
    .replace(/\r/g, '\\r')  // Escape carriage returns
    .replace(/\t/g, '\\t'); // Escape tabs
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

/**
 * Determines whether the bot should respond and generates a reply
 * 
 * This is the main function that interfaces with the Groq AI API.
 * It takes the conversation context and returns an appropriate reply,
 * or an empty string if the bot should stay silent.
 * 
 * @param {Object} context - The conversation context
 * @param {Array} context.messages - Array of message objects with role and content
 * @param {string} context.botName - The bot's display name
 * @param {boolean} context.replyToBot - Whether the user is directly replying to the bot
 * @returns {Promise<{reply: string}>} Object containing the reply (or empty string)
 */
async function shouldRespondAndReply(context) {
  const { messages: turns, botName, replyToBot } = context;
  
  // Build the system prompt with the bot's name and reply context
  // If the user is directly replying to the bot, we tell the AI to definitely respond
  const system =
    SYSTEM_PROMPT +
    `\n\nYour name is ${botName}.${replyToBot ? ' The last message is a direct reply to you; you should respond.' : ''}`;

  // Call the Groq API to generate a response
  const completion = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile', // Using Llama 3.3 70B - fast and capable
    messages: [
      { role: 'system', content: system }, // System instructions
      ...turns                              // Conversation history
    ],
    temperature: 0.7,   // Moderate creativity (0 = deterministic, 1 = very random)
    max_tokens: 512,    // Maximum length of the response
  });

  // Extract the response content from the API result
  const content = completion.choices?.[0]?.message?.content?.trim();
  
  // If no content, return empty reply (bot stays silent)
  if (!content) return { reply: '' };

  // Escape control characters so JSON.parse() doesn't fail
  const escaped = escapeControlCharsInReplyValue(content);
  
  // Parse the JSON response from the AI
  let data;
  try {
    data = JSON.parse(escaped);
  } catch {
    // If JSON parsing fails, return empty reply (fail silently)
    return { reply: '' };
  }

  // Extract the reply string, defaulting to empty if invalid
  const reply = typeof data.reply === 'string' ? data.reply : '';
  return { reply };
}

// Export the main function for use in index.js
module.exports = { shouldRespondAndReply };
