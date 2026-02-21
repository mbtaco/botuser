/**
 * Registry of admin commands. Each command has an id (adminCommand value from LLM),
 * button label, short description for the LLM, and a handler that receives (interaction, originalMessage).
 * Handlers get the original user message via interaction.message.reference to read mentions/content.
 */

const TIMEOUT_MS_DEFAULT = 5 * 60 * 1000; // 5 minutes

async function getOriginalMessage(interaction) {
  const ref = interaction.message?.reference?.messageId;
  if (!ref || !interaction.channel) return null;
  try {
    return await interaction.channel.messages.fetch(ref);
  } catch {
    return null;
  }
}

function getFirstMentionedUser(message) {
  const user = message.mentions?.users?.first();
  return user?.id ?? null;
}

function getFirstMentionedMember(guild, message) {
  const id = getFirstMentionedUser(message);
  if (!id || !guild) return null;
  return guild.members.resolve(id) ?? null;
}

function findVoiceChannelByName(guild, name) {
  if (!guild || !name) return null;
  const normalized = name.trim().toLowerCase();
  return guild.channels.cache.find(
    (c) => c.isVoiceBased?.() && (c.name.toLowerCase().includes(normalized) || normalized.includes(c.name.toLowerCase()))
  ) ?? null;
}

function findRoleByName(guild, name) {
  if (!guild || !name) return null;
  const normalized = name.trim().toLowerCase();
  return guild.roles.cache.find((r) => r.name.toLowerCase() === normalized)
    ?? guild.roles.cache.find((r) => r.name.toLowerCase().includes(normalized));
}

function getFirstMentionedRole(message) {
  return message.mentions?.roles?.first() ?? null;
}

function getMentionedMembers(guild, message) {
  if (!guild || !message?.mentions?.users?.size) return [];
  return message.mentions.users
    .map((u) => guild.members.resolve(u.id))
    .filter(Boolean);
}

const ADMIN_COMMANDS = {
  clearMessages: {
    buttonLabel: 'Confirm clear messages',
    description: 'User explicitly asks the bot to clear or delete messages in the channel (e.g. "clear the messages", "delete the chat"). Not when they are only discussing or mentioning message history.',
    async handler(interaction) {
      const channel = interaction.channel;
      if (typeof channel?.bulkDelete !== 'function') {
        await interaction.followUp({ content: "Can't clear messages in this channel.", ephemeral: true }).catch(() => {});
        return;
      }
      const deleted = await channel.bulkDelete(100, true);
      await interaction.followUp({ content: `Cleared ${deleted.size} message(s).` }).catch(() => {});
    },
  },

  kickUser: {
    buttonLabel: 'Confirm kick',
    description: 'User asks to kick someone from the server. They must @mention the user.',
    async handler(interaction, originalMessage) {
      const guild = interaction.guild;
      const member = getFirstMentionedMember(guild, originalMessage);
      if (!member) {
        await interaction.followUp({ content: 'Mention a user to kick (e.g. kick @user).', ephemeral: true }).catch(() => {});
        return;
      }
      if (!member.kickable) {
        await interaction.followUp({ content: "I can't kick that user (role hierarchy or permissions).", ephemeral: true }).catch(() => {});
        return;
      }
      await member.kick(`Kicked by ${interaction.user.tag} via bot`);
      await interaction.followUp({ content: `Kicked ${member.user.tag}.` }).catch(() => {});
    },
  },

  banUser: {
    buttonLabel: 'Confirm ban',
    description: 'User asks to ban someone from the server. They must @mention the user.',
    async handler(interaction, originalMessage) {
      const guild = interaction.guild;
      const member = getFirstMentionedMember(guild, originalMessage);
      const userId = getFirstMentionedUser(originalMessage);
      const target = member ?? userId;
      if (!target) {
        await interaction.followUp({ content: 'Mention a user to ban (e.g. ban @user).', ephemeral: true }).catch(() => {});
        return;
      }
      if (member && !member.bannable) {
        await interaction.followUp({ content: "I can't ban that user (role hierarchy or permissions).", ephemeral: true }).catch(() => {});
        return;
      }
      await guild.members.ban(target, { reason: `Banned by ${interaction.user.tag} via bot` });
      await interaction.followUp({ content: `Banned ${member?.user?.tag ?? userId}.` }).catch(() => {});
    },
  },

  muteUser: {
    buttonLabel: 'Confirm timeout',
    description: 'User asks to mute or timeout someone. They must @mention the user. Use timeout (e.g. 5 min).',
    async handler(interaction, originalMessage) {
      const guild = interaction.guild;
      const member = getFirstMentionedMember(guild, originalMessage);
      if (!member) {
        await interaction.followUp({ content: 'Mention a user to mute/timeout (e.g. mute @user).', ephemeral: true }).catch(() => {});
        return;
      }
      if (!member.moderatable) {
        await interaction.followUp({ content: "I can't timeout that user (role hierarchy or permissions).", ephemeral: true }).catch(() => {});
        return;
      }
      await member.timeout(TIMEOUT_MS_DEFAULT, `Timeout by ${interaction.user.tag} via bot`);
      await interaction.followUp({ content: `Timed out ${member.user.tag} for 5 minutes.` }).catch(() => {});
    },
  },

  createRole: {
    buttonLabel: 'Confirm create role',
    description: 'User asks to create a new role (e.g. "create role called Moderator"). You must set "roleName" in the JSON to the exact name they want.',
    async handler(interaction, originalMessage, options = {}) {
      const guild = interaction.guild;
      const name = options.roleName?.trim()?.slice(0, 100);
      if (!name) {
        await interaction.followUp({
          content: "No role name was provided. Try again and say e.g. 'create role called Moderator'.",
          ephemeral: true,
        }).catch(() => {});
        return;
      }
      const role = await guild.roles.create({ name, reason: `Created by ${interaction.user.tag} via bot` });
      await interaction.followUp({ content: `Created role **${role.name}**.` }).catch(() => {});
    },
  },

  deleteRole: {
    buttonLabel: 'Confirm delete role',
    description: 'User asks to delete a role. They must mention the role (@Role) or give the role name. Set "roleName" to the exact role name if they say it.',
    async handler(interaction, originalMessage, options = {}) {
      const guild = interaction.guild;
      const role =
        getFirstMentionedRole(originalMessage) ??
        (options.roleName ? findRoleByName(guild, options.roleName) : null);
      if (!role) {
        await interaction.followUp({
          content: 'Mention a role (@Role) or give the role name (e.g. delete role Moderator).',
          ephemeral: true,
        }).catch(() => {});
        return;
      }
      if (role.managed) {
        await interaction.followUp({
          content: "Can't delete that role (it's managed by an integration).",
          ephemeral: true,
        }).catch(() => {});
        return;
      }
      const name = role.name;
      await role.delete(`Deleted by ${interaction.user.tag} via bot`);
      await interaction.followUp({ content: `Deleted role **${name}**.` }).catch(() => {});
    },
  },

  renameRole: {
    buttonLabel: 'Confirm rename role',
    description: 'User asks to rename a role. They must mention the role or give current name, and the new name. Set "roleName" to current name and "newRoleName" to the new name.',
    async handler(interaction, originalMessage, options = {}) {
      const guild = interaction.guild;
      const role =
        getFirstMentionedRole(originalMessage) ??
        (options.roleName ? findRoleByName(guild, options.roleName) : null);
      const newName = options.newRoleName?.trim()?.slice(0, 100);
      if (!role) {
        await interaction.followUp({
          content: 'Mention the role or give its name (e.g. rename Moderator to Helper).',
          ephemeral: true,
        }).catch(() => {});
        return;
      }
      if (!newName) {
        await interaction.followUp({
          content: "No new name provided. Say e.g. 'rename Moderator to Helper'.",
          ephemeral: true,
        }).catch(() => {});
        return;
      }
      if (role.managed) {
        await interaction.followUp({
          content: "Can't rename that role (it's managed by an integration).",
          ephemeral: true,
        }).catch(() => {});
        return;
      }
      const oldName = role.name;
      await role.edit({ name: newName, reason: `Renamed by ${interaction.user.tag} via bot` });
      await interaction.followUp({ content: `Renamed **${oldName}** to **${newName}**.` }).catch(() => {});
    },
  },

  addToRole: {
    buttonLabel: 'Confirm add to role',
    description: 'User asks to add someone to a role (assign role). They must @mention the user(s) and mention the role (@Role) or give role name. Set "roleName" if they give the role by name.',
    async handler(interaction, originalMessage, options = {}) {
      const guild = interaction.guild;
      const role =
        getFirstMentionedRole(originalMessage) ??
        (options.roleName ? findRoleByName(guild, options.roleName) : null);
      const members = getMentionedMembers(guild, originalMessage);
      if (!role) {
        await interaction.followUp({
          content: 'Mention the role (@Role) or give its name (e.g. add @user to Moderator).',
          ephemeral: true,
        }).catch(() => {});
        return;
      }
      if (!members.length) {
        await interaction.followUp({
          content: 'Mention at least one user (e.g. add @user to Moderator).',
          ephemeral: true,
        }).catch(() => {});
        return;
      }
      let added = 0;
      for (const member of members) {
        try {
          if (!member.roles.cache.has(role.id)) {
            await member.roles.add(role, `Added by ${interaction.user.tag} via bot`);
            added++;
          }
        } catch {
          // skip if can't add
        }
      }
      await interaction.followUp({
        content: `Added ${added} user(s) to **${role.name}**.`,
      }).catch(() => {});
    },
  },

  removeFromRole: {
    buttonLabel: 'Confirm remove from role',
    description: 'User asks to remove someone from a role. They must @mention the user(s) and mention the role (@Role) or give role name. Set "roleName" if they give the role by name.',
    async handler(interaction, originalMessage, options = {}) {
      const guild = interaction.guild;
      const role =
        getFirstMentionedRole(originalMessage) ??
        (options.roleName ? findRoleByName(guild, options.roleName) : null);
      const members = getMentionedMembers(guild, originalMessage);
      if (!role) {
        await interaction.followUp({
          content: 'Mention the role (@Role) or give its name (e.g. remove @user from Moderator).',
          ephemeral: true,
        }).catch(() => {});
        return;
      }
      if (!members.length) {
        await interaction.followUp({
          content: 'Mention at least one user (e.g. remove @user from Moderator).',
          ephemeral: true,
        }).catch(() => {});
        return;
      }
      let removed = 0;
      for (const member of members) {
        try {
          if (member.roles.cache.has(role.id)) {
            await member.roles.remove(role, `Removed by ${interaction.user.tag} via bot`);
            removed++;
          }
        } catch {
          // skip
        }
      }
      await interaction.followUp({
        content: `Removed ${removed} user(s) from **${role.name}**.`,
      }).catch(() => {});
    },
  },

  disconnectUser: {
    buttonLabel: 'Confirm disconnect',
    description: 'User asks to disconnect someone from voice. They must @mention the user (who must be in a voice channel).',
    async handler(interaction, originalMessage) {
      const guild = interaction.guild;
      const member = getFirstMentionedMember(guild, originalMessage);
      if (!member) {
        await interaction.followUp({ content: 'Mention a user to disconnect from voice.', ephemeral: true }).catch(() => {});
        return;
      }
      if (!member.voice?.channel) {
        await interaction.followUp({ content: 'That user is not in a voice channel.', ephemeral: true }).catch(() => {});
        return;
      }
      await member.voice.disconnect(`Disconnected by ${interaction.user.tag} via bot`);
      await interaction.followUp({ content: `Disconnected ${member.user.tag} from voice.` }).catch(() => {});
    },
  },

  moveUser: {
    buttonLabel: 'Confirm move user',
    description: 'User asks to move someone to another voice channel. They must @mention the user and name or mention the target channel (e.g. move @user to General).',
    async handler(interaction, originalMessage) {
      const guild = interaction.guild;
      const member = getFirstMentionedMember(guild, originalMessage);
      if (!member) {
        await interaction.followUp({ content: 'Mention a user to move (e.g. move @user to General).', ephemeral: true }).catch(() => {});
        return;
      }
      const content = originalMessage?.content ?? '';
      const channelMention = originalMessage?.mentions?.channels?.first();
      let targetChannel = channelMention ?? null;
      if (!targetChannel && content) {
        const toMatch = content.match(/\bto\s+([#\w\s-]+)/i);
        if (toMatch) targetChannel = findVoiceChannelByName(guild, toMatch[1].trim());
      }
      if (!targetChannel?.isVoiceBased?.()) {
        await interaction.followUp({
          content: 'Specify a voice channel (e.g. move @user to #General).',
          ephemeral: true,
        }).catch(() => {});
        return;
      }
      await member.voice.setChannel(targetChannel, `Moved by ${interaction.user.tag} via bot`);
      await interaction.followUp({ content: `Moved ${member.user.tag} to **${targetChannel.name}**.` }).catch(() => {});
    },
  },

  moveAllUsers: {
    buttonLabel: 'Confirm move everyone',
    description: 'User asks to move all users from one voice channel to another (e.g. move everyone from General to Music). They must name or mention both channels.',
    async handler(interaction, originalMessage) {
      const guild = interaction.guild;
      const content = originalMessage?.content ?? '';
      const channels = originalMessage?.mentions?.channels;
      let sourceChannel = null;
      let targetChannel = null;
      if (channels?.size >= 2) {
        const arr = [...channels.values()].filter((c) => c.isVoiceBased());
        sourceChannel = arr[0] ?? null;
        targetChannel = arr[1] ?? null;
      }
      if ((!sourceChannel || !targetChannel) && content) {
        const fromMatch = content.match(/(?:from|in)\s+([#\w\s-]+)/i);
        const toMatch = content.match(/\bto\s+([#\w\s-]+)/i);
        if (fromMatch) sourceChannel = sourceChannel ?? findVoiceChannelByName(guild, fromMatch[1].trim());
        if (toMatch) targetChannel = targetChannel ?? findVoiceChannelByName(guild, toMatch[1].trim());
      }
      if (!sourceChannel?.isVoiceBased?.() || !targetChannel?.isVoiceBased?.()) {
        await interaction.followUp({
          content: 'Specify source and target voice channels (e.g. move everyone from General to Music).',
          ephemeral: true,
        }).catch(() => {});
        return;
      }
      const members = sourceChannel.members;
      let moved = 0;
      for (const [, m] of members) {
        try {
          await m.voice.setChannel(targetChannel, `Moved by ${interaction.user.tag} via bot`);
          moved++;
        } catch {
          // skip if can't move
        }
      }
      await interaction.followUp({
        content: `Moved ${moved} user(s) from **${sourceChannel.name}** to **${targetChannel.name}**.`,
      }).catch(() => {});
    },
  },

  disconnectAllUsers: {
    buttonLabel: 'Confirm disconnect everyone',
    description: 'User asks to disconnect all users from a voice channel (e.g. disconnect everyone in General). They must name or mention the voice channel.',
    async handler(interaction, originalMessage) {
      const guild = interaction.guild;
      const channelMention = originalMessage?.mentions?.channels?.first();
      let voiceChannel = channelMention?.isVoiceBased?.() ? channelMention : null;
      if (!voiceChannel && originalMessage?.content) {
        const match = originalMessage.content.match(/(?:in|from)\s+([#\w\s-]+)/i);
        if (match) voiceChannel = findVoiceChannelByName(guild, match[1].trim());
      }
      if (!voiceChannel?.isVoiceBased?.()) {
        await interaction.followUp({
          content: 'Specify a voice channel (e.g. disconnect everyone in General).',
          ephemeral: true,
        }).catch(() => {});
        return;
      }
      const members = voiceChannel.members;
      let disconnected = 0;
      for (const [, m] of members) {
        try {
          await m.voice.disconnect(`Disconnected by ${interaction.user.tag} via bot`);
          disconnected++;
        } catch {
          // skip
        }
      }
      await interaction.followUp({
        content: `Disconnected ${disconnected} user(s) from **${voiceChannel.name}**.`,
      }).catch(() => {});
    },
  },
};

function getAdminCommand(id) {
  return ADMIN_COMMANDS[id] ?? null;
}

function getAllCommandIds() {
  return Object.keys(ADMIN_COMMANDS);
}

function getPromptDescription() {
  return Object.entries(ADMIN_COMMANDS)
    .map(([id, c]) => `- "${id}": ${c.description}`)
    .join('\n');
}

module.exports = {
  ADMIN_COMMANDS,
  getAdminCommand,
  getAllCommandIds,
  getPromptDescription,
  getOriginalMessage,
};
