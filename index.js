require('dotenv').config();
const http = require('http');
const {
  Client,
  Events,
  IntentsBitField,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const { shouldRespondAndReply } = require('./lib/groq');

const PORT = Number(process.env.PORT) || 8000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});
server.listen(PORT, () => console.log(`Health check listening on port ${PORT}`));

const RECENT_MESSAGES_LIMIT = 15;

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.GuildVoiceStates,
    IntentsBitField.Flags.MessageContent,
  ],
});

function formatMessage(msg) {
  const name = msg.author?.username ?? 'Unknown';
  const content = msg.content?.trim() || '(no text)';
  return `${name}: ${content}`;
}

async function isReplyToBot(message) {
  if (!message.reference?.messageId) return false;
  try {
    const ref = await message.channel.messages.fetch(message.reference.messageId);
    return ref.author?.id === message.client.user?.id;
  } catch {
    return false;
  }
}

async function buildConversationMessages(channel, newMessage, botId) {
  const messages = await channel.messages.fetch({ limit: RECENT_MESSAGES_LIMIT });
  const sorted = [...messages.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );
  const replyToBot = await isReplyToBot(newMessage);
  const turns = sorted.map((msg) => ({
    role: msg.author.id === botId ? 'assistant' : 'user',
    content: formatMessage(msg),
  }));
  return { turns, replyToBot };
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  const clearCommand = new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear recent messages in this channel')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(c.user.id), {
    body: [clearCommand.toJSON()],
  }).catch((err) => {
    console.error('Failed to register slash command:', err.message);
  });
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const { turns, replyToBot } = await buildConversationMessages(
    message.channel,
    message,
    message.client.user.id
  );
  const botName = message.client.user.username;

  const { reply } = await shouldRespondAndReply({
    messages: turns,
    botName,
    replyToBot,
  });

  if (!reply?.trim()) return;

  try {
    await message.reply(reply);
  } catch (err) {
    console.error('Failed to send reply:', err.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'clear') return;

  const channel = interaction.channel;
  if (typeof channel?.bulkDelete !== 'function') {
    await interaction.reply({
      content: "Can't clear messages in this channel.",
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const deleted = await channel.bulkDelete(100, true);
    await interaction.editReply(`Cleared ${deleted.size} message(s).`).catch(() => {});
  } catch (err) {
    console.error('Clear error:', err.message);
    await interaction.editReply(`Failed: ${err.message}`).catch(() => {});
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN is not set. Copy .env.example to .env and add your token.');
  process.exit(1);
}

client.login(token).catch((err) => {
  console.error('Login failed:', err.message);
  process.exit(1);
});
