/**
 * Discord Bot Entry Point
 * 
 * This is the main entry point for a Discord bot that uses AI (via Groq/Llama)
 * to respond to messages in a conversational manner. The bot also provides
 * a /clear slash command for moderators to bulk delete messages.
 */

// Load environment variables from .env file (DISCORD_TOKEN, GROQ_API_KEY, etc.)
require('dotenv').config();

// Node.js HTTP module - used for the health check server
const http = require('http');

// Discord.js library components for building the bot
const {
  Client,          // Main Discord client class
  Events,          // Event name constants (ClientReady, MessageCreate, etc.)
  IntentsBitField, // Bit flags for specifying which events the bot receives
  PermissionsBitField, // Bit flags for Discord permissions
  REST,            // REST API client for registering slash commands
  Routes,          // API route builders for Discord REST endpoints
  SlashCommandBuilder, // Builder class for creating slash commands
} = require('discord.js');

// Import the AI response function from our Groq integration
const { shouldRespondAndReply } = require('./lib/groq');

// ============================================================================
// HEALTH CHECK SERVER
// ============================================================================
// Simple HTTP server that responds with "ok" - useful for deployment platforms
// (like Railway, Heroku, etc.) that need to verify the app is running
const PORT = Number(process.env.PORT) || 8000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});
server.listen(PORT, () => console.log(`Health check listening on port ${PORT}`));

// ============================================================================
// CONFIGURATION
// ============================================================================
// Number of recent messages to fetch for conversation context
// The AI uses this history to understand the ongoing conversation
const RECENT_MESSAGES_LIMIT = 15;

// ============================================================================
// DISCORD CLIENT SETUP
// ============================================================================
// Create the Discord client with specific intents
// Intents tell Discord which events we want to receive
const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,           // Access to guild (server) data
    IntentsBitField.Flags.GuildMembers,     // Access to member join/leave events
    IntentsBitField.Flags.GuildMessages,    // Access to message events
    IntentsBitField.Flags.GuildVoiceStates, // Access to voice channel events
    IntentsBitField.Flags.MessageContent,   // Access to message content (privileged intent)
  ],
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Formats a Discord message into a simple "username: content" string
 * This format is used when building conversation history for the AI
 * 
 * @param {Message} msg - Discord message object
 * @returns {string} Formatted message string
 */
function formatMessage(msg) {
  const name = msg.author?.username ?? 'Unknown';
  const content = msg.content?.trim() || '(no text)';
  return `${name}: ${content}`;
}

/**
 * Checks if a message is a direct reply to the bot
 * This helps the AI know when it should definitely respond
 * 
 * @param {Message} message - The incoming Discord message
 * @returns {Promise<boolean>} True if the message is replying to the bot
 */
async function isReplyToBot(message) {
  // If there's no message reference, it's not a reply
  if (!message.reference?.messageId) return false;
  
  try {
    // Fetch the original message being replied to
    const ref = await message.channel.messages.fetch(message.reference.messageId);
    // Check if the bot authored that message
    return ref.author?.id === message.client.user?.id;
  } catch {
    // If we can't fetch the reference (deleted, permissions, etc.), assume false
    return false;
  }
}

/**
 * Builds the conversation history for the AI model
 * Fetches recent messages and formats them as chat turns
 * 
 * @param {TextChannel} channel - The Discord channel to fetch messages from
 * @param {Message} newMessage - The new incoming message
 * @param {string} botId - The bot's Discord user ID
 * @returns {Promise<{turns: Array, replyToBot: boolean}>} Conversation turns and reply status
 */
async function buildConversationMessages(channel, newMessage, botId) {
  // Fetch the most recent messages from the channel
  const messages = await channel.messages.fetch({ limit: RECENT_MESSAGES_LIMIT });
  
  // Sort messages chronologically (oldest first) for proper conversation flow
  const sorted = [...messages.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );
  
  // Check if the new message is a direct reply to the bot
  const replyToBot = await isReplyToBot(newMessage);
  
  // Convert messages to the chat format expected by the AI
  // Bot messages become "assistant" role, user messages become "user" role
  const turns = sorted.map((msg) => ({
    role: msg.author.id === botId ? 'assistant' : 'user',
    content: formatMessage(msg),
  }));
  
  return { turns, replyToBot };
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Client Ready Event
 * Fires once when the bot successfully connects to Discord
 * Used here to register slash commands
 */
client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  // Build the /clear slash command
  // This command allows moderators to bulk delete messages
  const clearCommand = new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear recent messages in this channel')
    // Only users with "Manage Messages" permission can use this command
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages);

  // Register the command globally using Discord's REST API
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(c.user.id), {
    body: [clearCommand.toJSON()],
  }).catch((err) => {
    console.error('Failed to register slash command:', err.message);
  });
});

/**
 * Message Create Event
 * Fires whenever a new message is sent in a channel the bot can see
 * This is the main handler for AI-powered responses
 */
client.on(Events.MessageCreate, async (message) => {
  // Ignore messages from bots (including itself) to prevent loops
  if (message.author.bot) return;

  // Build the conversation context from recent messages
  const { turns, replyToBot } = await buildConversationMessages(
    message.channel,
    message,
    message.client.user.id
  );
  
  // Get the bot's display name for personalization
  const botName = message.client.user.username;

  // Ask the AI whether and how to respond
  const { reply } = await shouldRespondAndReply({
    messages: turns,
    botName,
    replyToBot,
  });

  // If the AI returns an empty reply, stay silent
  if (!reply?.trim()) return;

  // Send the AI's response to the channel
  try {
    await message.channel.send(reply);
  } catch (err) {
    console.error('Failed to send reply:', err.message);
  }
});

/**
 * Interaction Create Event
 * Fires when a user triggers an interaction (slash command, button, etc.)
 * Handles the /clear command for bulk message deletion
 */
client.on(Events.InteractionCreate, async (interaction) => {
  // Only handle the /clear slash command
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'clear') return;

  // Defer the reply to give us time to process (ephemeral = only visible to the user)
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const channel = interaction.channel;
  
  // Helper function to safely send messages to the channel
  const sendChannelMessage = async (content) => {
    if (typeof channel?.send !== 'function') return;
    await channel.send(content).catch(() => {});
  };

  // Check if the channel supports bulk deletion (e.g., not DMs)
  if (typeof channel?.bulkDelete !== 'function') {
    await sendChannelMessage("Can't clear messages in this channel.");
    await interaction.deleteReply().catch(() => {});
    return;
  }

  try {
    // Bulk delete up to 100 messages
    // The 'true' parameter filters out messages older than 14 days (Discord limitation)
    const deleted = await channel.bulkDelete(100, true);
    await sendChannelMessage(`Cleared ${deleted.size} message(s).`);
  } catch (err) {
    console.error('Clear error:', err.message);
    await sendChannelMessage(`Failed: ${err.message}`);
  } finally {
    // Clean up the ephemeral reply
    await interaction.deleteReply().catch(() => {});
  }
});

// ============================================================================
// BOT LOGIN
// ============================================================================

// Get the Discord bot token from environment variables
const token = process.env.DISCORD_TOKEN;

// Validate that the token exists
if (!token) {
  console.error('DISCORD_TOKEN is not set. Copy .env.example to .env and add your token.');
  process.exit(1);
}

// Connect the bot to Discord
client.login(token).catch((err) => {
  console.error('Login failed:', err.message);
  process.exit(1);
});
