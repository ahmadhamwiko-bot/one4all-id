
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const Database = require("better-sqlite3");

const token = process.env.DISCORD_TOKEN;
const LOG_CHANNEL_ID = "1571861990278824066";

if (!token) {
  console.error("Missing DISCORD_TOKEN secret!");
  process.exit(1);
}

const db = new Database("one4all.db");

db.exec(`
CREATE TABLE IF NOT EXISTS members (
  guild_id TEXT,
  user_id TEXT,
  member_id INTEGER,
  xp INTEGER DEFAULT 0,
  reputation INTEGER DEFAULT 0,
  last_daily INTEGER DEFAULT 0,
  PRIMARY KEY (guild_id, user_id),
  UNIQUE (guild_id, member_id)
);

CREATE TABLE IF NOT EXISTS counters (
  guild_id TEXT PRIMARY KEY,
  last_id INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ticket_staff_roles (
  guild_id TEXT,
  role_id TEXT,
  PRIMARY KEY (guild_id, role_id)
);

CREATE TABLE IF NOT EXISTS tickets (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT,
  owner_id TEXT,
  type TEXT,
  claimed_by TEXT,
  status TEXT DEFAULT 'open',
  created_at INTEGER
);
`);

function getMember(guildId, userId) {
  let member = db.prepare(
    "SELECT * FROM members WHERE guild_id = ? AND user_id = ?"
  ).get(guildId, userId);

  if (!member) {
    const next = db.prepare(
      "SELECT last_id FROM counters WHERE guild_id = ?"
    ).get(guildId);

    const id = (next?.last_id || 0) + 1;

    db.prepare(`
      INSERT INTO counters (guild_id, last_id)
      VALUES (?, ?)
      ON CONFLICT(guild_id)
      DO UPDATE SET last_id = excluded.last_id
    `).run(guildId, id);

    db.prepare(`
      INSERT INTO members (guild_id, user_id, member_id)
      VALUES (?, ?, ?)
    `).run(guildId, userId, id);

    member = db.prepare(
      "SELECT * FROM members WHERE guild_id = ? AND user_id = ?"
    ).get(guildId, userId);
  }

  return member;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

const ticketTypes = {
  middleman: {
    label: "Middleman Request",
    emoji: "🤝"
  },
  trading: {
    label: "Account Trading",
    emoji: "💰"
  },
  scammer: {
    label: "Scammer Report",
    emoji: "🚨"
  },
  support: {
    label: "General Support",
    emoji: "🎧"
  }
};

function isTicketStaff(interaction) {
  if (interaction.memberPermissions?.has(
    PermissionsBitField.Flags.ManageGuild
  )) return true;

  const roles = interaction.member?.roles?.cache;
  if (!roles) return false;

  const allowed = db.prepare(
    "SELECT role_id FROM ticket_staff_roles WHERE guild_id = ?"
  ).all(interaction.guildId);

  return allowed.some(item => roles.has(item.role_id));
}

async function sendTicketLog(guild, embed) {
  try {
    const channel = await guild.channels.fetch(LOG_CHANNEL_ID);

    if (channel?.isTextBased()) {
      await channel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.error("Ticket log error:", error);
  }
}

async function createTicket(interaction, type) {
  const guild = interaction.guild;
  const user = interaction.user;
  const info = ticketTypes[type];

  if (!info) return;

  const existing = db.prepare(`
    SELECT channel_id FROM tickets
    WHERE guild_id = ? AND owner_id = ? AND status = 'open'
  `).get(guild.id, user.id);

  if (existing) {
    return interaction.reply({
      content: `You already have an open ticket: <#${existing.channel_id}>`,
      ephemeral: true
    });
  }

  const staffRoles = db.prepare(
    "SELECT role_id FROM ticket_staff_roles WHERE guild_id = ?"
  ).all(guild.id);

  const permissionOverwrites = [
    {
      id: guild.id,
      deny: [PermissionsBitField.Flags.ViewChannel]
    },
    {
      id: user.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks
      ]
    },
    {
      id: client.user.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.ManageChannels,
        PermissionsBitField.Flags.ManageMessages
      ]
    }
  ];

  for (const role of staffRoles) {
    if (guild.roles.cache.has(role.role_id)) {
      permissionOverwrites.push({
        id: role.role_id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory
        ]
      });
    }
  }

  const channel = await guild.channels.create({
    name: `${type}-${user.username}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 90),
    type: ChannelType.GuildText,
    permissionOverwrites
  });

  db.prepare(`
    INSERT INTO tickets
    (channel_id, guild_id, owner_id, type, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(channel.id, guild.id, user.id, type, Date.now());

  const embed = new EmbedBuilder()
    .setColor("#D4AF37")
    .setTitle(`${info.emoji} ${info.label}`)
    .setDescription(
      `Welcome ${user}!\n\nPlease explain your request clearly. Our team will assist you soon.`
    )
    .addFields(
      { name: "Member", value: user.tag, inline: true },
      { name: "Status", value: "Open", inline: true }
    )
    .setFooter({ text: "One4All Support • 1FA" });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket:claim")
      .setLabel("Claim")
      .setEmoji("🙋")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ticket:close")
      .setLabel("Close")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger)
  );

  await channel.send({
    content: `${user} | Ticket Staff`,
    embeds: [embed],
    components: [buttons],
    allowedMentions: { users: [user.id] }
  });

  await sendTicketLog(guild,
    new EmbedBuilder()
      .setColor("#22C55E")
      .setTitle("🎫 Ticket Opened")
      .addFields(
        { name: "Member", value: `${user}`, inline: true },
        { name: "Type", value: info.label, inline: true },
        { name: "Channel", value: `${channel}`, inline: true }
      )
      .setTimestamp()
  );

  return interaction.reply({
    content: `Your ticket has been created: ${channel}`,
    ephemeral: true
  });
}

client.once("ready", () => {
  console.log(`${client.user.tag} is online!`);
});

client.on("guildMemberAdd", member => {
  getMember(member.guild.id, member.id);
});

client.on("messageCreate", message => {
  if (!message.guild || message.author.bot) return;

  getMember(message.guild.id, message.author.id);

  const gained = Math.floor(Math.random() * 6) + 5;

  db.prepare(`
    UPDATE members SET xp = xp + ?
    WHERE guild_id = ? AND user_id = ?
  `).run(gained, message.guild.id, message.author.id);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.guild) return;

  try {
    // Ticket buttons
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("ticket:create:")) {
        const type = interaction.customId.split(":")[2];
        return await createTicket(interaction, type);
      }

      if (interaction.customId === "ticket:claim") {
        if (!isTicketStaff(interaction)) {
          return interaction.reply({
            content: "You are not authorized to claim tickets.",
            ephemeral: true
          });
        }

        const ticket = db.prepare(`
          SELECT * FROM tickets
          WHERE channel_id = ? AND status = 'open'
        `).get(interaction.channelId);

        if (!ticket) {
          return interaction.reply({
            content: "This ticket is not open.",
            ephemeral: true
          });
        }

        if (ticket.claimed_by) {
          return interaction.reply({
            content: `This ticket is already claimed by <@${ticket.claimed_by}>.`,
            ephemeral: true
          });
        }

        db.prepare(`
          UPDATE tickets SET claimed_by = ?
          WHERE channel_id = ?
        `).run(interaction.user.id, interaction.channelId);

        await interaction.reply({
          content: `🙋 This ticket has been claimed by ${interaction.user}.`
        });

        await sendTicketLog(interaction.guild,
          new EmbedBuilder()
            .setColor("#3B82F6")
            .setTitle("🙋 Ticket Claimed")
            .addFields(
              { name: "Staff", value: `${interaction.user}`, inline: true },
              { name: "Channel", value: `${interaction.channel}`, inline: true }
            )
            .setTimestamp()
        );

        return;
      }

      if (interaction.customId === "ticket:close") {
        const ticket = db.prepare(`
          SELECT * FROM tickets
          WHERE channel_id = ? AND status = 'open'
        `).get(interaction.channelId);

        if (!ticket) {
          return interaction.reply({
            content: "This ticket is already closed or not registered.",
            ephemeral: true
          });
        }

        const isOwner = ticket.owner_id === interaction.user.id;

        if (!isOwner && !isTicketStaff(interaction)) {
          return interaction.reply({
            content: "You cannot close this ticket.",
            ephemeral: true
          });
        }

        db.prepare(`
          UPDATE tickets SET status = 'closed'
          WHERE channel_id = ?
        `).run(interaction.channelId);

        await interaction.channel.permissionOverwrites.edit(
          ticket.owner_id,
          {
            SendMessages: false
          }
        );

        await interaction.channel.setName(
          `closed-${interaction.channel.name}`.slice(0, 100)
        );

        await interaction.reply({
          content: `🔒 Ticket closed by ${interaction.user}.`
        });

        await interaction.message.edit({ components: [] });

        await sendTicketLog(interaction.guild,
          new EmbedBuilder()
            .setColor("#EF4444")
            .setTitle("🔒 Ticket Closed")
            .addFields(
              { name: "Owner", value: `<@${ticket.owner_id}>`, inline: true },
              { name: "Closed by", value: `${interaction.user}`, inline: true },
              { name: "Channel", value: `${interaction.channel}`, inline: true }
            )
            .setTimestamp()
        );

        return;
      }
    }

    if (!interaction.isChatInputCommand()) return;

    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    const command = interaction.commandName;

    // Ticket panel
    if (command === "ticket-panel") {
      const embed = new EmbedBuilder()
        .setColor("#D4AF37")
        .setTitle("🎫 ONE4ALL SUPPORT")
        .setDescription(
          "Welcome to One4All Support!\n\nChoose the type of ticket you want to open. Our team will help you as soon as possible."
        )
        .setFooter({ text: "One4All Community • 1FA" });

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket:create:middleman")
          .setLabel("Middleman")
          .setEmoji("🤝")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("ticket:create:trading")
          .setLabel("Account Trading")
          .setEmoji("💰")
          .setStyle(ButtonStyle.Primary)
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket:create:scammer")
          .setLabel("Scammer Report")
          .setEmoji("🚨")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("ticket:create:support")
          .setLabel("General Support")
          .setEmoji("🎧")
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.channel.send({
        embeds: [embed],
        components: [row1, row2]
      });

      return interaction.reply({
        content: "Ticket panel published successfully!",
        ephemeral: true
      });
    }

    // Ticket staff roles
    if (command === "ticket-role") {
      if (!interaction.memberPermissions.has(
        PermissionsBitField.Flags.ManageGuild
      )) {
        return interaction.reply({
          content: "You need Manage Server permission.",
          ephemeral: true
        });
      }

      const action = interaction.options.getSubcommand();

      if (action === "add") {
        const role = interaction.options.getRole("role");

        db.prepare(`
          INSERT OR IGNORE INTO ticket_staff_roles
          (guild_id, role_id)
          VALUES (?, ?)
        `).run(guildId, role.id);

        return interaction.reply({
          content: `✅ ${role} can now manage tickets.`,
          ephemeral: true
        });
      }

      if (action === "remove") {
        const role = interaction.options.getRole("role");

        db.prepare(`
          DELETE FROM ticket_staff_roles
          WHERE guild_id = ? AND role_id = ?
        `).run(guildId, role.id);

        return interaction.reply({
          content: `✅ ${role} has been removed from ticket staff.`,
          ephemeral: true
        });
      }

      if (action === "list") {
        const roles = db.prepare(`
          SELECT role_id FROM ticket_staff_roles
          WHERE guild_id = ?
        `).all(guildId);

        return interaction.reply({
          content: roles.length
            ? roles.map(r => `<@&${r.role_id}>`).join("\n")
            : "No ticket staff roles configured.",
          ephemeral: true
        });
      }
    }

    // Existing One4All commands
    const member = getMember(guildId, userId);

    if (command === "id") {
      const target = interaction.options.getUser("member") || interaction.user;
      const data = getMember(guildId, target.id);

      const embed = new EmbedBuilder()
        .setColor("#D4AF37")
        .setTitle("👑 One4All Digital ID")
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: "Member", value: target.username, inline: true },
          { name: "Member ID", value: `#${String(data.member_id).padStart(4, "0")}`, inline: true },
          { name: "Level", value: String(Math.floor(data.xp / 100) + 1), inline: true },
          { name: "XP", value: String(data.xp), inline: true },
          { name: "Reputation", value: String(data.reputation), inline: true }
        )
        .setFooter({ text: "One4All Community • 1FA" });

      return interaction.reply({ embeds: [embed] });
    }

    if (command === "rank") {
      const level = Math.floor(member.xp / 100) + 1;
      const progress = member.xp % 100;

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor("#8B5CF6")
            .setTitle("⭐ Your Rank")
            .setDescription(
              `Level: **${level}**\nXP: **${member.xp}**\nProgress: **${progress}/100 XP**`
            )
        ]
      });
    }

    if (command === "reputation") {
      const target = interaction.options.getUser("member") || interaction.user;
      const data = getMember(guildId, target.id);

      return interaction.reply({
        content: `🏆 **${target.username}** has **${data.reputation}** reputation points.`
      });
    }

    if (command === "achievements") {
      const achievements = [];

      if (member.xp >= 100) achievements.push("🥉 First Level");
      if (member.xp >= 1000) achievements.push("🥇 Active Member");
      if (member.reputation >= 10) achievements.push("⭐ Trusted Member");

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor("#D4AF37")
            .setTitle("🏅 Your Achievements")
            .setDescription(
              achievements.length
                ? achievements.join("\n")
                : "No achievements yet. Keep participating!"
            )
        ]
      });
    }

    if (command === "leaderboard") {
      const top = db.prepare(`
        SELECT user_id, xp, reputation
        FROM members
        WHERE guild_id = ?
        ORDER BY xp DESC
        LIMIT 10
      `).all(guildId);

      const lines = top.map((item, index) =>
        `**${index + 1}.** <@${item.user_id}> — ${item.xp} XP`
      );

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor("#D4AF37")
            .setTitle("🏆 One4All Leaderboard")
            .setDescription(lines.join("\n") || "No members yet.")
        ]
      });
    }

    if (command === "daily") {
      const now = Date.now();
      const cooldown = 24 * 60 * 60 * 1000;

      if (now - member.last_daily < cooldown) {
        const hours = Math.ceil(
          (cooldown - (now - member.last_daily)) / 3600000
        );

        return interaction.reply({
          content: `⏳ Your next daily reward is available in about ${hours} hours.`,
          ephemeral: true
        });
      }

      db.prepare(`
        UPDATE members
        SET xp = xp + 50, last_daily = ?
        WHERE guild_id = ? AND user_id = ?
      `).run(now, guildId, userId);

      return interaction.reply(
        "🎁 You received **50 XP** as your daily reward!"
      );
    }

    if (command === "admin") {
      if (!interaction.memberPermissions.has(
        PermissionsBitField.Flags.ManageGuild
      )) {
        return interaction.reply({
          content: "⛔ You need Manage Server permission to use this command.",
          ephemeral: true
        });
      }

      return interaction.reply({
        content: "⚙️ One4All ID admin tools are ready. More tools coming soon!",
        ephemeral: true
      });
    }

    if (command === "reputation-add") {
      if (!interaction.memberPermissions.has(
        PermissionsBitField.Flags.ManageGuild
      )) {
        return interaction.reply({
          content: "⛔ You need Manage Server permission.",
          ephemeral: true
        });
      }

      const target = interaction.options.getUser("member");
      const points = interaction.options.getInteger("points");

      if (points < 1 || points > 100) {
        return interaction.reply({
          content: "Choose between 1 and 100 points.",
          ephemeral: true
        });
      }

      getMember(guildId, target.id);

      db.prepare(`
        UPDATE members SET reputation = reputation + ?
        WHERE guild_id = ? AND user_id = ?
      `).run(points, guildId, target.id);

      return interaction.reply(
        `⭐ Added **${points}** reputation points to ${target}.`
      );
    }

  } catch (error) {
    console.error(error);

    if (interaction.replied || interaction.deferred) {
      return interaction.followUp({
        content: "Something went wrong. Please try again.",
        ephemeral: true
      }).catch(() => {});
    }

    return interaction.reply({
      content: "Something went wrong. Please try again.",
      ephemeral: true
    }).catch(() => {});
  }
});

client.once("ready", () => {
  const channelId = "1568597170779852810";

  setInterval(async () => {
    try {
      const channel = await client.channels.fetch(channelId);

      if (channel && channel.isTextBased()) {
        await channel.send({
          content: "@everyone 📢 The chat needs you! Come say hi and keep One4All alive! ❤️🔥",
          allowedMentions: { parse: ["everyone"] }
        });
      }
    } catch (error) {
      console.error("Chat revival error:", error);
    }
  }, 3 * 60 * 60 * 1000);
});

client.login(token);
