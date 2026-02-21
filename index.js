require('dotenv').config();
const {
  Client,
  Events,
  IntentsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  PermissionsBitField,
} = require('discord.js');
const { ButtonStyle } = require('discord-api-types/v10');
const { shouldRespondAndReply } = require('./lib/groq');
const { getAdminCommand, getOriginalMessage } = require('./lib/adminCommands');

const RECENT_MESSAGES_LIMIT = 15;
const ADMIN_CONFIRM_PREFIX = 'admin_confirm:';
const ADMIN_PAYLOAD_SEP = '||';
const RENAME_PAYLOAD_SEP = '\x01';
const CUSTOM_ID_MAX = 100;
const COMMANDS_WITH_ROLE_NAME = ['createRole', 'deleteRole', 'addToRole', 'removeFromRole'];
const COMMAND_RENAME_ROLE = 'renameRole';
const BUTTON_LABEL_MAX = 80;

function getConfirmButtonLabel(adminCommand, message, { roleName, newRoleName }) {
  const users = message.mentions?.users ? [...message.mentions.users.values()] : [];
  const userNames = users.map((u) => u.username).slice(0, 2).join(', ');
  const roleMention = message.mentions?.roles?.first();
  const roleDisplay = roleMention?.name ?? roleName ?? 'role';

  switch (adminCommand) {
    case 'clearMessages':
      return 'Clear messages in this channel';
    case 'kickUser':
      return userNames ? `Kick ${userNames}` : null;
    case 'banUser':
      return userNames ? `Ban ${userNames}` : null;
    case 'muteUser':
      return userNames ? `Timeout ${userNames}` : null;
    case 'createRole':
      return roleName ? `Create role "${roleName}"` : null;
    case 'deleteRole':
      return roleDisplay ? `Delete role "${roleDisplay}"` : null;
    case 'renameRole':
      return newRoleName ? `Rename to "${newRoleName}"` : null;
    case 'addToRole':
      return userNames && roleDisplay ? `Add ${userNames} to ${roleDisplay}` : (roleDisplay ? `Add to ${roleDisplay}` : null);
    case 'removeFromRole':
      return userNames && roleDisplay ? `Remove ${userNames} from ${roleDisplay}` : (roleDisplay ? `Remove from ${roleDisplay}` : null);
    case 'disconnectUser':
      return userNames ? `Disconnect ${userNames}` : null;
    case 'moveUser':
      return userNames ? `Move ${userNames}` : null;
    case 'moveAllUsers':
      return 'Move everyone';
    case 'disconnectAllUsers':
      return 'Disconnect everyone';
    default:
      return null;
  }
}

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

function isServerAdmin(message) {
  if (!message.member || !message.guild) return false;
  return (
    message.guild.ownerId === message.author.id ||
    message.member.permissions.has(PermissionsBitField.Flags.Administrator)
  );
}

async function buildConversationContext(channel, newMessage) {
  const messages = await channel.messages.fetch({ limit: RECENT_MESSAGES_LIMIT });
  const sorted = [...messages.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );
  const lines = sorted.map(formatMessage);
  let conversation = lines.join('\n');
  const replyToBot = await isReplyToBot(newMessage);
  if (replyToBot) {
    conversation =
      'Note: The last message is a direct reply to the bot. The bot should respond.\n\n' +
      conversation;
  }
  return conversation;
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const conversation = await buildConversationContext(message.channel, message);
  const botName = message.client.user.username;
  const isAdmin = isServerAdmin(message);

  const { reply, adminCommand, roleName, newRoleName } = await shouldRespondAndReply({
    conversation,
    botName,
    isAdmin,
  });

  if (!reply?.trim()) return;

  try {
    const cmd = adminCommand ? getAdminCommand(adminCommand) : null;
    if (cmd) {
      let customId = `${ADMIN_CONFIRM_PREFIX}${adminCommand}`;
      const maxPayload = CUSTOM_ID_MAX - customId.length - ADMIN_PAYLOAD_SEP.length - 2;
      if (COMMANDS_WITH_ROLE_NAME.includes(adminCommand) && roleName) {
        const payload = encodeURIComponent(roleName).slice(0, maxPayload);
        customId = `${customId}${ADMIN_PAYLOAD_SEP}${payload}`;
      } else if (adminCommand === COMMAND_RENAME_ROLE && roleName && newRoleName) {
        const p1 = encodeURIComponent(roleName).slice(0, 35);
        const p2 = encodeURIComponent(newRoleName).slice(0, 35);
        const payload = (p1 + RENAME_PAYLOAD_SEP + p2).slice(0, maxPayload);
        customId = `${customId}${ADMIN_PAYLOAD_SEP}${payload}`;
      }
      const specificLabel = getConfirmButtonLabel(adminCommand, message, { roleName, newRoleName });
      const label = (specificLabel && specificLabel.length <= BUTTON_LABEL_MAX ? specificLabel : cmd.buttonLabel).slice(0, BUTTON_LABEL_MAX);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(customId)
          .setLabel(label)
          .setStyle(ButtonStyle.Danger)
      );
      await message.reply({ content: reply, components: [row] });
    } else {
      await message.reply(reply);
    }
  } catch (err) {
    console.error('Failed to send reply:', err.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton() || !interaction.customId?.startsWith(ADMIN_CONFIRM_PREFIX)) return;

  const afterPrefix = interaction.customId.slice(ADMIN_CONFIRM_PREFIX.length);
  const sepIdx = afterPrefix.indexOf(ADMIN_PAYLOAD_SEP);
  const commandId = sepIdx >= 0 ? afterPrefix.slice(0, sepIdx) : afterPrefix;
  const payloadEnc = sepIdx >= 0 ? afterPrefix.slice(sepIdx + ADMIN_PAYLOAD_SEP.length) : '';
  const cmd = getAdminCommand(commandId);
  if (!cmd) return;

  const options = {};
  if (payloadEnc) {
    try {
      if (commandId === COMMAND_RENAME_ROLE && payloadEnc.includes(RENAME_PAYLOAD_SEP)) {
        const [a, b] = payloadEnc.split(RENAME_PAYLOAD_SEP);
        if (a) options.roleName = decodeURIComponent(a);
        if (b) options.newRoleName = decodeURIComponent(b);
      } else if (COMMANDS_WITH_ROLE_NAME.includes(commandId)) {
        options.roleName = decodeURIComponent(payloadEnc);
      }
    } catch {
      // ignore bad payload
    }
  }

  const member = interaction.guild?.members.resolve(interaction.user.id);
  const isAdmin =
    member &&
    (interaction.guild.ownerId === interaction.user.id ||
      member.permissions.has(PermissionsBitField.Flags.Administrator));
  if (!isAdmin) {
    await interaction.reply({
      content: "You don't have permission to run this.",
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  await interaction.deferUpdate();

  const originalMessage = await getOriginalMessage(interaction);

  try {
    await cmd.handler(interaction, originalMessage, options);
  } catch (err) {
    console.error(`Admin command ${commandId} error:`, err.message);
    await interaction.followUp({
      content: `Failed: ${err.message}`,
    }).catch(() => {});
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
