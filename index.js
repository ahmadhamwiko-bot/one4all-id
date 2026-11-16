
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

// ================= CONFIG =================

const token = process.env.DISCORD_TOKEN;

const LOG_CHANNEL_ID = "1571861990278824066";
const REVIVAL_CHANNEL_ID = "1568597170779852810";
const REVIVAL_INTERVAL = 90 * 60 * 1000;

// ===========================================

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

CREATE TABLE IF NOT EXISTS command_center (
  guild_id TEXT PRIMARY KEY,
  goals TEXT DEFAULT '[]',
  news TEXT DEFAULT 'No announcements yet.',
  awards TEXT DEFAULT '[]',
  spotlight_user TEXT
);

CREATE TABLE IF NOT EXISTS activity (
  guild_id TEXT,
  user_id TEXT,
  messages INTEGER DEFAULT 0,
  last_message INTEGER DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS server_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  event TEXT,
  details TEXT,
  created_at INTEGER
);
`);

// ================= MEMBER SYSTEM =================

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

// ================= EVENT LOG =================

function logEvent(guildId, event, details = "") {
  db.prepare(`
    INSERT INTO server_events (guild_id, event, details, created_at)
    VALUES (?, ?, ?, ?)
  `).run(guildId, event, details, Date.now());
}

// ================= DISCORD CLIENT =================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

let revivalTimer = null;

// ================= TICKET TYPES =================

const ticketTypes = {
  staff: { label: "Staff Applications", emoji: "👮" },
  suggestions: { label: "Suggestions", emoji: "💡" },
  scammer: { label: "Scammer Report", emoji: "🚨" },
  support: { label: "General Support", emoji: "🎧" }
};

const staffApplicationQuestions = [
  { name: "1. Discord Username", value: "Please provide your Discord username." },
  { name: "2. Blockman Go ID", value: "Please provide your Blockman Go account ID." },
  { name: "3. Previous Staff Experience", value: "Have you ever been a staff member in another server? Explain your experience." },
  { name: "4. Why do you want to be staff in One4All?", value: "Tell us why you want to join our staff team." },
  { name: "5. How active are you?", value: "How many hours per day can you dedicate to One4All?" }
];

// ================= PERMISSIONS =================

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(
    PermissionsBitField.Flags.ManageGuild
  );
}

function isTicketStaff(interaction) {
  if (isAdmin(interaction)) return true;

  const roles = interaction.member?.roles?.cache;
  if (!roles) return false;

  const allowed = db.prepare(
    "SELECT role_id FROM ticket_staff_roles WHERE guild_id = ?"
  ).all(interaction.guildId);

  return allowed.some(item => roles.has(item.role_id));
}

function isStaff(interaction) {
  return isTicketStaff(interaction);
}

// ================= TICKET LOGS =================

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

// ================= CREATE TICKET =================

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
    .setFooter({ text: "One4All Community • 1FA" });

  if (type === "staff") {
    embed.setDescription(
      `Welcome ${user}!\n\nThank you for your interest in joining the One4All Staff Team.`
    );
    embed.addFields(staffApplicationQuestions);
  } else {
    embed.setDescription(
      `Welcome ${user}!\n\nPlease explain your request clearly. Our team will assist you soon.`
    );
  }

  embed.addFields(
    { name: "Member", value: user.tag, inline: true },
    { name: "Status", value: "Open", inline: true }
  );

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

  logEvent(guild.id, "Ticket Opened", `${user.tag} • ${info.label}`);

  await sendTicketLog(
    guild,
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

// ================= COMMAND CENTER =================

function commandCenterEmbed(guild) {
  const total = db.prepare(
    "SELECT COUNT(*) AS count FROM members WHERE guild_id = ?"
  ).get(guild.id).count;

  const tickets = db.prepare(
    "SELECT COUNT(*) AS count FROM tickets WHERE guild_id = ? AND status = 'open'"
  ).get(guild.id).count;

  const messages = db.prepare(
    "SELECT COALESCE(SUM(messages), 0) AS count FROM activity WHERE guild_id = ?"
  ).get(guild.id).count;

  const goals = db.prepare(
    "SELECT goals FROM command_center WHERE guild_id = ?"
  ).get(guild.id);

  const news = db.prepare(
    "SELECT news FROM command_center WHERE guild_id = ?"
  ).get(guild.id);

  const goalList = JSON.parse(goals?.goals || "[]");

  return new EmbedBuilder()
    .setColor("#D4AF37")
    .setTitle("👑 ONE4ALL COMMAND CENTER")
    .setDescription(
      "Welcome to the One4All central control panel.\n\nChoose a section below to explore the community."
    )
    .addFields(
      { name: "👥 Tracked Members", value: String(total), inline: true },
      { name: "🎫 Open Tickets", value: String(tickets), inline: true },
      { name: "💬 Tracked Messages", value: String(messages), inline: true },
      { name: "🎯 Community Goals", value: String(goalList.length), inline: true },
      { name: "📢 Latest News", value: (news?.news || "No announcements yet.").slice(0, 1024), inline: false }
    )
    .setFooter({ text: "One4All Community • 1FA" })
    .setTimestamp();
}

function commandCenterRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("cc:stats").setLabel("Statistics").setEmoji("📊").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("cc:leaderboard").setLabel("Leaderboard").setEmoji("🏆").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("cc:directory").setLabel("Members").setEmoji("👥").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("cc:activity").setLabel("Activity").setEmoji("📈").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("cc:achievements").setLabel("Achievements").setEmoji("🏅").setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("cc:events").setLabel("Events").setEmoji("🎉").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("cc:goals").setLabel("Goals").setEmoji("🎯").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("cc:spotlight").setLabel("Spotlight").setEmoji("🌟").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("cc:awards").setLabel("Awards").setEmoji("🎖️").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("cc:news").setLabel("News").setEmoji("📢").setStyle(ButtonStyle.Success)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("cc:livefeed").setLabel("Live Feed").setEmoji("📰").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("cc:staff").setLabel("Staff Center").setEmoji("🛡️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("cc:trending").setLabel("Trending").setEmoji("🔥").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("cc:reputation").setLabel("Reputation").setEmoji("⭐").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("cc:home").setLabel("Home").setEmoji("🏠").setStyle(ButtonStyle.Danger)
  );

  return [row1, row2, row3];
}

async function handleCommandCenter(interaction) {
  const id = interaction.customId;
  const guildId = interaction.guildId;

  if (id === "cc:home") {
    return interaction.update({
      embeds: [commandCenterEmbed(interaction.guild)],
      components: commandCenterRows()
    });
  }

  if (id === "cc:stats") {
    const members = db.prepare(
      "SELECT COUNT(*) AS count FROM members WHERE guild_id = ?"
    ).get(guildId).count;

    const xp = db.prepare(
      "SELECT COALESCE(SUM(xp), 0) AS total FROM members WHERE guild_id = ?"
    ).get(guildId).total;

    const tickets = db.prepare(
      "SELECT COUNT(*) AS count FROM tickets WHERE guild_id = ? AND status = 'open'"
    ).get(guildId).count;

    const messages = db.prepare(
      "SELECT COALESCE(SUM(messages), 0) AS count FROM activity WHERE guild_id = ?"
    ).get(guildId).count;

    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor("#3B82F6")
          .setTitle("📊 Server Statistics")
          .addFields(
            { name: "Tracked Members", value: String(members), inline: true },
            { name: "Total XP", value: String(xp), inline: true },
            { name: "Open Tickets", value: String(tickets), inline: true },
            { name: "Tracked Messages", value: String(messages), inline: true },
            { name: "Discord Members", value: String(interaction.guild.memberCount), inline: true }
          )
      ],
      components: commandCenterRows()
    });
  }

  if (id === "cc:leaderboard" || id === "cc:trending") {
    const top = db.prepare(`
      SELECT user_id, xp, reputation
      FROM members
      WHERE guild_id = ?
      ORDER BY ${id === "cc:trending" ? "xp" : "xp"} DESC
      LIMIT 10
    `).all(guildId);

    const lines = top.map((item, index) =>
      `**${index + 1}.** <@${item.user_id}> — ${item.xp} XP`
    );

    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor("#D4AF37")
          .setTitle(id === "cc:trending" ? "🔥 Trending Members" : "🏆 Leaderboard")
          .setDescription(lines.join("\n") || "No members yet.")
      ],
      components: commandCenterRows()
    });
  }

  if (id === "cc:directory") {
    const list = db.prepare(`
      SELECT user_id, member_id, xp
      FROM members WHERE guild_id = ?
      ORDER BY member_id ASC LIMIT 15
    `).all(guildId);

    const lines = list.map(item =>
      `#${String(item.member_id).padStart(4, "0")} — <@${item.user_id}>`
    );

    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor("#0EA5E9")
          .setTitle("👥 Member Directory")
          .setDescription(lines.join("\n") || "No members tracked yet.")
      ],
      components: commandCenterRows()
    });
  }

  if (id === "cc:activity") {
    const top = db.prepare(`
      SELECT user_id, messages
      FROM activity WHERE guild_id = ?
      ORDER BY messages DESC LIMIT 10
    `).all(guildId);

    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor("#8B5CF6")
          .setTitle("📈 Activity Report")
          .setDescription(
            top.map((item, i) =>
              `**${i + 1}.** <@${item.user_id}> — ${item.messages} messages`
            ).join("\n") || "No activity data yet."
          )
      ],
      components: commandCenterRows()
    });
  }

  if (id === "cc:achievements") {
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor("#D4AF37")
          .setTitle("🏅 Achievements")
          .setDescription(
            "🥉 First Level — 100 XP\n🥇 Active Member — 1000 XP\n⭐ Trusted Member — 10 Reputation"
          )
      ],
      components: commandCenterRows()
    });
  }

  if (id === "cc:reputation") {
    const top = db.prepare(`
      SELECT user_id, reputation
      FROM members WHERE guild_id = ?
      ORDER BY reputation DESC LIMIT 10
    `).all(guildId);

    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor("#F59E0B")
          .setTitle("⭐ Reputation Ranking")
          .setDescription(
            top.map((item, i) =>
              `**${i + 1}.** <@${item.user_id}> — ${item.reputation} points`
            ).join("\n") || "No reputation data yet."
          )
      ],
      components: commandCenterRows()
    });
  }

  if (id === "cc:livefeed") {
    if (!isStaff(interaction)) {
      return interaction.reply({
        content: "⛔ Staff access only.",
        ephemeral: true
      });
    }

    const events = db.prepare(`
      SELECT event, details, created_at
      FROM server_events WHERE guild_id = ?
      ORDER BY id DESC LIMIT 10
    `).all(guildId);

    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor("#64748B")
          .setTitle("📰 Live Feed")
          .setDescription(
            events.map(item =>
              `**${item.event}** — ${item.details || "No details"}\n<t:${Math.floor(item.created_at / 1000)}:R>`
            ).join("\n\n") || "No events recorded yet."
          )
      ],
      components: commandCenterRows()
    });
  }

  if (id === "cc:staff") {
    if (!isStaff(interaction)) {
      return interaction.reply({
        content: "⛔ Staff access only.",
        ephemeral: true
      });
    }

    const claimed = db.prepare(`
      SELECT COUNT(*) AS count FROM tickets
      WHERE guild_id = ? AND claimed_by IS NOT NULL
    `).get(guildId).count;

    const closed = db.prepare(`
      SELECT COUNT(*) AS count FROM tickets
      WHERE guild_id = ? AND status = 'closed'
    `).get(guildId).count;

    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor("#2563EB")
          .setTitle("🛡️ Staff Center")
          .addFields(
            { name: "Claimed Tickets", value: String(claimed), inline: true },
            { name: "Closed Tickets", value: String(closed), inline: true }
          )
      ],
      components: commandCenterRows()
    });
  }

  if (id === "cc:events") {
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor("#22C55E")
          .setTitle("🎉 Events Center")
          .setDescription("Community events and competitions will be announced here.")
      ],
      components: commandCenterRows()
    });
  }

  if (id === "cc:goals") {
    const data = db.prepare(
      "SELECT goals FROM command_center WHERE guild_id = ?"
    ).get(guildId);

    const goals = JSON.parse(data?.goals || "[]");

    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor("#16A34A")
          .setTitle("🎯 Community Goals")
          .setDescription(
            goals.length ? goals.map((goal, i) => `${i + 1}. ${goal}`).join("\n") : "No community goals configured yet."
          )
      ],
      components: commandCenterRows()
    });
  }

  if (id === "cc:spotlight") {
    const data = db.prepare(
      "SELECT spotlight_user FROM command_center WHERE guild_id = ?"
    ).get(guildId);

    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor("#EAB308")
          .setTitle("🌟 Member Spotlight")
          .setDescription(
            data?.spotlight_user
              ? `This week's spotlight: <@${data.spotlight_user}>`
              : "No spotlight member selected yet."
          )
      ],
      components: commandCenterRows()
    });
  }

  if (id === "cc:awards") {
    const data = db.prepare(
      "SELECT awards FROM command_center WHERE guild_id = ?"
    ).get(guildId);

    const awards = JSON.parse(data?.awards || "[]");

    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor("#D4AF37")
          .setTitle("🎖️ Exclusive Awards")
          .setDescription(
            awards.length ? awards.join("\n") : "No exclusive awards configured yet."
          )
      ],
      components: commandCenterRows()
    });
  }

  if (id === "cc:news") {
    const data = db.prepare(
      "SELECT news FROM command_center WHERE guild_id = ?"
    ).get(guildId);

    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor("#D4AF37")
          .setTitle("📢 Breaking News")
          .setDescription(data?.news || "No announcements yet.")
      ],
      components: commandCenterRows()
    });
  }
}

// ================= DEAD CHAT REVIVAL =================

async function sendChatRevival() {
  try {
    const channel = await client.channels.fetch(REVIVAL_CHANNEL_ID);

    if (!channel || !channel.isTextBased() || !channel.send) {
      console.error("Chat Revival: Invalid text channel!");
      return;
    }

    await channel.send({
      content: "@everyone 📢 The chat needs you! Come say hi and keep One4All alive! ❤️🔥",
      allowedMentions: { parse: ["everyone"] }
    });

    console.log(
      `[CHAT REVIVAL] Message sent successfully at ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Beirut" })}`
    );
  } catch (error) {
    console.error("Chat revival error:", error);
  }
}

function startChatRevival() {
  if (revivalTimer) clearInterval(revivalTimer);

  console.log("Chat Revival system started.");
  console.log("Interval: Every 90 minutes.");

  revivalTimer = setInterval(sendChatRevival, REVIVAL_INTERVAL);
}

// ================= BOT READY =================

client.once("ready", () => {
  console.log(`${client.user.tag} is online!`);
  startChatRevival();
});

// ================= NEW MEMBERS =================

client.on("guildMemberAdd", member => {
  getMember(member.guild.id, member.id);
  logEvent(member.guild.id, "Member Joined", member.user.tag);
});

// ================= XP AND ACTIVITY =================

client.on("messageCreate", message => {
  if (!message.guild || message.author.bot) return;

  getMember(message.guild.id, message.author.id);

  const gained = Math.floor(Math.random() * 6) + 5;

  db.prepare(`
    UPDATE members SET xp = xp + ?
    WHERE guild_id = ? AND user_id = ?
  `).run(gained, message.guild.id, message.author.id);

  db.prepare(`
    INSERT INTO activity (guild_id, user_id, messages, last_message)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(guild_id, user_id)
    DO UPDATE SET messages = messages + 1, last_message = excluded.last_message
  `).run(message.guild.id, message.author.id, Date.now());
});

// ================= INTERACTIONS =================

client.on("interactionCreate", async interaction => {
  if (!interaction.guild) return;

  try {
    // ================= BUTTONS =================

    if (interaction.isButton()) {
      if (interaction.customId.startsWith("ticket:create:")) {
        return await createTicket(
          interaction,
          interaction.customId.split(":")[2]
        );
      }

      if (interaction.customId.startsWith("cc:")) {
        return await handleCommandCenter(interaction);
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

        logEvent(interaction.guildId, "Ticket Claimed", interaction.user.tag);

        await interaction.reply({
          content: `🙋 This ticket has been claimed by ${interaction.user}.`
        });

        await sendTicketLog(
          interaction.guild,
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

        await interaction.deferUpdate();

        const oldName = interaction.channel.name;

        await interaction.channel.permissionOverwrites.edit(
          ticket.owner_id,
          { SendMessages: false }
        );

        await interaction.channel.setName(`closed-${oldName}`.slice(0, 100));

        db.prepare(`
          UPDATE tickets SET status = 'closed'
          WHERE channel_id = ?
        `).run(interaction.channelId);

        logEvent(interaction.guildId, "Ticket Closed", interaction.user.tag);

        await interaction.message.edit({ components: [] }).catch(() => {});

        await interaction.channel.send({
          content: `🔒 Ticket closed by ${interaction.user}.`
        }).catch(() => {});

        await sendTicketLog(
          interaction.guild,
          new EmbedBuilder()
            .setColor("#EF4444")
            .setTitle("🔒 Ticket Closed")
            .addFields(
              { name: "Owner", value: `<@${ticket.owner_id}>`, inline: true },
              { name: "Closed by", value: `${interaction.user}`, inline: true },
              { name: "Channel", value: `<#${interaction.channelId}>`, inline: true }
            )
            .setTimestamp()
        );

        return;
      }
    }

    // ================= SLASH COMMANDS =================

    if (!interaction.isChatInputCommand()) return;

    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    const command = interaction.commandName;

    if (command === "command-center") {
      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: "⛔ You need Manage Server permission.",
          ephemeral: true
        });
      }

      return interaction.reply({
        embeds: [commandCenterEmbed(interaction.guild)],
        components: commandCenterRows()
      });
    }

    // ================= TICKET PANEL =================

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
          .setCustomId("ticket:create:staff")
          .setLabel("Staff Applications")
          .setEmoji("👮")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("ticket:create:suggestions")
          .setLabel("Suggestions")
          .setEmoji("💡")
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

    // ================= TICKET ROLE =================

    if (command === "ticket-role") {
      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: "You need Manage Server permission.",
          ephemeral: true
        });
      }

      const action = interaction.options.getSubcommand();

      if (action === "add") {
        const role = interaction.options.getRole("role");

        db.prepare(`
          INSERT OR IGNORE INTO ticket_staff_roles (guild_id, role_id)
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

    const member = getMember(guildId, userId);

    // ================= ID =================

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

    // ================= RANK =================

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

    // ================= REPUTATION =================

    if (command === "reputation") {
      const target = interaction.options.getUser("member") || interaction.user;
      const data = getMember(guildId, target.id);

      return interaction.reply({
        content: `🏆 **${target.username}** has **${data.reputation}** reputation points.`
      });
    }

    // ================= ACHIEVEMENTS =================

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

    // ================= LEADERBOARD =================

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

    // ================= DAILY =================

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

    // ================= ADMIN =================

    if (command === "admin") {
      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: "⛔ You need Manage Server permission to use this command.",
          ephemeral: true
        });
      }

      return interaction.reply({
        content: "⚙️ One4All ID admin tools are ready.",
        ephemeral: true
      });
    }

    // ================= ADD REPUTATION =================

    if (command === "reputation-add") {
      if (!isAdmin(interaction)) {
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
    console.error("Interaction error:", error);

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

// ================= LOGIN =================

client.login(token);
