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
const PANEL_REFRESH_MS = 60 * 1000;
const GOLD = 0xD4AF37;
// ==========================================

if (!token) {
  console.error("Missing DISCORD_TOKEN secret!");
  process.exit(1);
}

const db = new Database("one4all.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS members (
  guild_id TEXT, user_id TEXT, member_id INTEGER,
  xp INTEGER DEFAULT 0, reputation INTEGER DEFAULT 0,
  last_daily INTEGER DEFAULT 0,
  PRIMARY KEY (guild_id, user_id),
  UNIQUE (guild_id, member_id)
);
CREATE TABLE IF NOT EXISTS counters (
  guild_id TEXT PRIMARY KEY, last_id INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ticket_staff_roles (
  guild_id TEXT, role_id TEXT,
  PRIMARY KEY (guild_id, role_id)
);
CREATE TABLE IF NOT EXISTS tickets (
  channel_id TEXT PRIMARY KEY, guild_id TEXT,
  owner_id TEXT, type TEXT, claimed_by TEXT,
  status TEXT DEFAULT 'open', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS command_center (
  guild_id TEXT PRIMARY KEY, goals TEXT DEFAULT '[]',
  news TEXT DEFAULT 'No announcements yet.',
  awards TEXT DEFAULT '[]', spotlight_user TEXT
);
CREATE TABLE IF NOT EXISTS activity (
  guild_id TEXT, user_id TEXT,
  messages INTEGER DEFAULT 0, last_message INTEGER DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS server_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT, event TEXT, details TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS live_panels (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL
);
`);

// ================= DATABASE HELPERS =================

function getMember(guildId, userId) {
  let member = db.prepare(
    "SELECT * FROM members WHERE guild_id = ? AND user_id = ?"
  ).get(guildId, userId);

  if (!member) {
    const last = db.prepare(
      "SELECT last_id FROM counters WHERE guild_id = ?"
    ).get(guildId);

    const id = (last?.last_id || 0) + 1;

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

function logEvent(guildId, event, details = "") {
  db.prepare(`
    INSERT INTO server_events
    (guild_id, event, details, created_at)
    VALUES (?, ?, ?, ?)
  `).run(guildId, event, String(details).slice(0, 900), Date.now());
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(
    PermissionsBitField.Flags.ManageGuild
  ) || false;
}

function isTicketStaff(interaction) {
  if (isAdmin(interaction)) return true;

  const roles = interaction.member?.roles?.cache;
  if (!roles) return false;

  const allowed = db.prepare(
    "SELECT role_id FROM ticket_staff_roles WHERE guild_id = ?"
  ).all(interaction.guildId);

  return allowed.some(row => roles.has(row.role_id));
}

function isStaff(interaction) {
  return isTicketStaff(interaction);
}

// ================= DISCORD CLIENT =================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ]
});

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

// ================= LIVE COMMAND CENTER =================

function getServerStats(guild) {
  const tracked = db.prepare(
    "SELECT COUNT(*) AS n FROM members WHERE guild_id = ?"
  ).get(guild.id).n;

  const openTickets = db.prepare(
    "SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND status = 'open'"
  ).get(guild.id).n;

  const closedTickets = db.prepare(
    "SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND status = 'closed'"
  ).get(guild.id).n;

  const totalMessages = db.prepare(
    "SELECT COALESCE(SUM(messages), 0) AS n FROM activity WHERE guild_id = ?"
  ).get(guild.id).n;

  const totalXP = db.prepare(
    "SELECT COALESCE(SUM(xp), 0) AS n FROM members WHERE guild_id = ?"
  ).get(guild.id).n;

  const online = guild.presences?.cache?.filter(
    p => ["online", "idle", "dnd"].includes(p.status)
  ).size;

  return {
    tracked,
    openTickets,
    closedTickets,
    totalMessages,
    totalXP,
    online
  };
}

function commandCenterEmbed(guild) {
  const s = getServerStats(guild);

  const news = db.prepare(
    "SELECT news FROM command_center WHERE guild_id = ?"
  ).get(guild.id)?.news || "No announcements yet.";

  const onlineText = Number.isInteger(s.online)
    ? s.online.toLocaleString()
    : "Enable Presence Intent";

  return new EmbedBuilder()
    .setColor(GOLD)
    .setAuthor({
      name: "ONE4ALL • 1FA COMMUNITY",
      iconURL: client.user.displayAvatarURL()
    })
    .setTitle("👑 ONE4ALL LIVE COMMAND CENTER")
    .setDescription(
      "**Stronger Together.**\nYour community at a glance — live server information and quick access to every section."
    )
    .addFields(
      { name: "👥 TOTAL MEMBERS", value: `**${guild.memberCount.toLocaleString()}**`, inline: true },
      { name: "🟢 ONLINE NOW", value: `**${onlineText}**`, inline: true },
      { name: "🎫 OPEN TICKETS", value: `**${s.openTickets}**`, inline: true },
      { name: "📨 TRACKED MEMBERS", value: `**${s.tracked}**`, inline: true },
      { name: "💬 MESSAGES TRACKED", value: `**${s.totalMessages.toLocaleString()}**`, inline: true },
      { name: "⭐ TOTAL XP", value: `**${s.totalXP.toLocaleString()}**`, inline: true },
      { name: "📢 SERVER NEWS", value: String(news).slice(0, 1024), inline: false }
    )
    .setFooter({
      text: "ONE4ALL • Live refresh every 60 seconds"
    })
    .setTimestamp();
}
function commandCenterRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("cc:stats").setLabel("Server Stats").setEmoji("📊").setStyle(ButtonStyle.Primary),
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

async function refreshLivePanels() {
  const panels = db.prepare(
    "SELECT guild_id, channel_id, message_id FROM live_panels"
  ).all();

  for (const panel of panels) {
    try {
      const guild = await client.guilds.fetch(panel.guild_id);
      const channel = await guild.channels.fetch(panel.channel_id);

      if (!channel?.isTextBased()) continue;

      const message = await channel.messages.fetch(panel.message_id);

      await message.edit({
        embeds: [commandCenterEmbed(guild)],
        components: commandCenterRows()
      });
    } catch (error) {
      if ([10008, 10003, 10004].includes(error.code)) {
        db.prepare(
          "DELETE FROM live_panels WHERE guild_id = ?"
        ).run(panel.guild_id);
      } else {
        console.error(
          `Live panel refresh failed for guild ${panel.guild_id}:`,
          error.message
        );
      }
    }
  }
}

async function publishCommandCenter(interaction) {
  const message = await interaction.reply({
    embeds: [commandCenterEmbed(interaction.guild)],
    components: commandCenterRows(),
    fetchReply: true
  });

  db.prepare(`
    INSERT INTO live_panels (guild_id, channel_id, message_id)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id)
    DO UPDATE SET
      channel_id = excluded.channel_id,
      message_id = excluded.message_id
  `).run(
    interaction.guildId,
    message.channelId,
    message.id
  );

  return message;
}

async function handleCommandCenter(interaction) {
  const id = interaction.customId;
  const guild = interaction.guild;
  const guildId = interaction.guildId;

  if (id === "cc:home") {
    return interaction.update({
      embeds: [commandCenterEmbed(guild)],
      components: commandCenterRows()
    });
  }

  let embed;

  if (id === "cc:stats") {
    const s = getServerStats(guild);

    embed = new EmbedBuilder()
      .setColor(GOLD)
      .setTitle("📊 One4All Server Statistics")
      .addFields(
        { name: "Total Discord Members", value: String(guild.memberCount), inline: true },
        { name: "Online Members", value: Number.isInteger(s.online) ? String(s.online) : "Presence Intent unavailable", inline: true },
        { name: "Tracked Members", value: String(s.tracked), inline: true },
        { name: "Open Tickets", value: String(s.openTickets), inline: true },
        { name: "Closed Tickets", value: String(s.closedTickets), inline: true },
        { name: "Tracked Messages", value: s.totalMessages.toLocaleString(), inline: true },
        { name: "Total XP", value: s.totalXP.toLocaleString(), inline: true }
      )
      .setTimestamp();

  } else if (id === "cc:leaderboard" || id === "cc:trending") {
    const query = id === "cc:trending"
      ? `SELECT m.user_id, m.xp,
          COALESCE(a.messages, 0) AS score
         FROM members m
         LEFT JOIN activity a
         ON a.guild_id=m.guild_id AND a.user_id=m.user_id
         WHERE m.guild_id=?
         ORDER BY score DESC LIMIT 10`
      : `SELECT user_id, xp, xp AS score
         FROM members
         WHERE guild_id=?
         ORDER BY xp DESC LIMIT 10`;

    const rows = db.prepare(query).all(guildId);

    embed = new EmbedBuilder()
      .setColor(GOLD)
      .setTitle(
        id === "cc:trending"
          ? "🔥 Most Active Members"
          : "🏆 One4All Leaderboard"
      )
      .setDescription(
        rows.map((r, i) =>
          `**${i + 1}.** <@${r.user_id}> — ${r.score} ${id === "cc:trending" ? "messages" : "XP"}`
        ).join("\n") || "No member data yet."
      );

  } else if (id === "cc:directory") {
    const rows = db.prepare(`
      SELECT user_id, member_id
      FROM members
      WHERE guild_id=?
      ORDER BY member_id
      LIMIT 15
    `).all(guildId);

    embed = new EmbedBuilder()
      .setColor(GOLD)
      .setTitle("👥 Member Directory")
      .setDescription(
        rows.map(r =>
          `**#${String(r.member_id).padStart(4, "0")}** — <@${r.user_id}>`
        ).join("\n") || "No tracked members yet."
      );

  } else if (id === "cc:activity") {
    const rows = db.prepare(`
      SELECT user_id, messages
      FROM activity
      WHERE guild_id=?
      ORDER BY messages DESC
      LIMIT 10
    `).all(guildId);

    embed = new EmbedBuilder()
      .setColor(GOLD)
      .setTitle("📈 Community Activity")
      .setDescription(
        rows.map((r, i) =>
          `**${i + 1}.** <@${r.user_id}> — ${r.messages} messages`
        ).join("\n") || "No activity data yet."
      )
      .setFooter({
        text: "Message activity is tracked from the moment this feature is enabled."
      });

  } else if (id === "cc:achievements") {
    embed = new EmbedBuilder()
      .setColor(GOLD)
      .setTitle("🏅 Achievements")
      .setDescription(
        "🥉 **First Level** — 100 XP\n🥇 **Active Member** — 1,000 XP\n⭐ **Trusted Member** — 10 reputation points"
      );

  } else if (id === "cc:reputation") {
    const rows = db.prepare(`
      SELECT user_id, reputation
      FROM members
      WHERE guild_id=?
      ORDER BY reputation DESC
      LIMIT 10
    `).all(guildId);

    embed = new EmbedBuilder()
      .setColor(GOLD)
      .setTitle("⭐ Reputation Ranking")
      .setDescription(
        rows.map((r, i) =>
          `**${i + 1}.** <@${r.user_id}> — ${r.reputation} points`
        ).join("\n") || "No reputation data yet."
      );
      } else if (id === "cc:livefeed") {
    if (!isStaff(interaction)) {
      return interaction.reply({
        content: "⛔ Staff access only.",
        ephemeral: true
      });
    }

    const rows = db.prepare(`
      SELECT event, details, created_at
      FROM server_events
      WHERE guild_id=?
      ORDER BY id DESC
      LIMIT 10
    `).all(guildId);

    embed = new EmbedBuilder()
      .setColor(GOLD)
      .setTitle("📰 One4All Live Feed")
      .setDescription(
        rows.map(r =>
          `**${r.event}** — ${r.details || "No details"}\n<t:${Math.floor(r.created_at / 1000)}:R>`
        ).join("\n\n") || "No events recorded yet."
      );

  } else if (id === "cc:staff") {
    if (!isStaff(interaction)) {
      return interaction.reply({
        content: "⛔ Staff access only.",
        ephemeral: true
      });
    }

    const claimed = db.prepare(
      "SELECT COUNT(*) AS n FROM tickets WHERE guild_id=? AND claimed_by IS NOT NULL"
    ).get(guildId).n;

    const closed = db.prepare(
      "SELECT COUNT(*) AS n FROM tickets WHERE guild_id=? AND status='closed'"
    ).get(guildId).n;

    const open = db.prepare(
      "SELECT COUNT(*) AS n FROM tickets WHERE guild_id=? AND status='open'"
    ).get(guildId).n;

    embed = new EmbedBuilder()
      .setColor(GOLD)
      .setTitle("🛡️ Staff Center")
      .addFields(
        { name: "Open Tickets", value: String(open), inline: true },
        { name: "Claimed Tickets", value: String(claimed), inline: true },
        { name: "Closed Tickets", value: String(closed), inline: true }
      );

  } else if (id === "cc:events") {
    const rows = db.prepare(`
      SELECT event, details, created_at
      FROM server_events
      WHERE guild_id=? AND event LIKE '%Event%'
      ORDER BY id DESC LIMIT 8
    `).all(guildId);

    embed = new EmbedBuilder()
      .setColor(GOLD)
      .setTitle("🎉 Events Center")
      .setDescription(
        rows.map(r =>
          `**${r.event}** — ${r.details}\n<t:${Math.floor(r.created_at / 1000)}:R>`
        ).join("\n\n") || "No events have been published yet."
      );

  } else if (id === "cc:goals") {
    const data = db.prepare(
      "SELECT goals FROM command_center WHERE guild_id=?"
    ).get(guildId);

    let goals = [];
    try {
      goals = JSON.parse(data?.goals || "[]");
    } catch {}

    embed = new EmbedBuilder()
      .setColor(GOLD)
      .setTitle("🎯 Community Goals")
      .setDescription(
        goals.length
          ? goals.map((g, i) => `**${i + 1}.** ${g}`).join("\n")
          : "No community goals configured yet."
      );

  } else if (id === "cc:spotlight") {
    const data = db.prepare(
      "SELECT spotlight_user FROM command_center WHERE guild_id=?"
    ).get(guildId);

    embed = new EmbedBuilder()
      .setColor(GOLD)
      .setTitle("🌟 Member Spotlight")
      .setDescription(
        data?.spotlight_user
          ? `This week's spotlight: <@${data.spotlight_user}>`
          : "No spotlight member selected yet."
      );

  } else if (id === "cc:awards") {
    const data = db.prepare(
      "SELECT awards FROM command_center WHERE guild_id=?"
    ).get(guildId);

    let awards = [];
    try {
      awards = JSON.parse(data?.awards || "[]");
    } catch {}

    embed = new EmbedBuilder()
      .setColor(GOLD)
      .setTitle("🎖️ Exclusive Awards")
      .setDescription(
        awards.length
          ? awards.join("\n")
          : "No exclusive awards configured yet."
      );

  } else if (id === "cc:news") {
    const data = db.prepare(
      "SELECT news FROM command_center WHERE guild_id=?"
    ).get(guildId);

    embed = new EmbedBuilder()
      .setColor(GOLD)
      .setTitle("📢 Breaking News")
      .setDescription(data?.news || "No announcements yet.");
  }

  if (!embed) return;

  return interaction.reply({
    embeds: [embed],
    ephemeral: true
  });
}

// ================= CREATE TICKET =================

async function createTicket(interaction, type) {
  const guild = interaction.guild;
  const user = interaction.user;
  const info = ticketTypes[type];

  if (!info) return;

  const existing = db.prepare(`
    SELECT channel_id FROM tickets
    WHERE guild_id=? AND owner_id=? AND status='open'
  `).get(guild.id, user.id);

  if (existing) {
    return interaction.reply({
      content: `You already have an open ticket: <#${existing.channel_id}>`,
      ephemeral: true
    });
  }

  const staffRoles = db.prepare(
    "SELECT role_id FROM ticket_staff_roles WHERE guild_id=?"
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
    (channel_id,guild_id,owner_id,type,created_at)
    VALUES (?,?,?,?,?)
  `).run(channel.id, guild.id, user.id, type, Date.now());

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`${info.emoji} ${info.label}`)
    .setFooter({ text: "One4All Community • 1FA" });

  if (type === "staff") {
    embed
      .setDescription(`Welcome ${user}!\n\nThank you for your interest in joining the One4All Staff Team.`)
      .addFields(staffApplicationQuestions);
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
      .setColor(0x22C55E)
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

// ================= BOT READY + LIVE REFRESH =================

client.once("ready", async () => {
  console.log(`${client.user.tag} is online!`);
  await refreshLivePanels();
  setInterval(refreshLivePanels, PANEL_REFRESH_MS);
});

// ================= MEMBER EVENTS =================

client.on("guildMemberAdd", member => {
  getMember(member.guild.id, member.id);
  logEvent(member.guild.id, "Member Joined", member.user.tag);
});

client.on("guildMemberRemove", member => {
  logEvent(member.guild.id, "Member Left", member.user.tag || member.id);
});

// ================= XP + ACTIVITY =================

client.on("messageCreate", message => {
  if (!message.guild || message.author.bot) return;

  getMember(message.guild.id, message.author.id);

  const gained = Math.floor(Math.random() * 6) + 5;

  db.prepare(`
    UPDATE members SET xp=xp+?
    WHERE guild_id=? AND user_id=?
  `).run(gained, message.guild.id, message.author.id);

  db.prepare(`
    INSERT INTO activity
    (guild_id,user_id,messages,last_message)
    VALUES (?,?,1,?)
    ON CONFLICT(guild_id,user_id)
    DO UPDATE SET
      messages=messages+1,
      last_message=excluded.last_message
  `).run(message.guild.id, message.author.id, Date.now());
});

// ================= INTERACTIONS =================

client.on("interactionCreate", async interaction => {
  if (!interaction.guild) return;

  try {
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
          WHERE channel_id=? AND status='open'
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
          UPDATE tickets SET claimed_by=?
          WHERE channel_id=?
        `).run(interaction.user.id, interaction.channelId);

        logEvent(interaction.guildId, "Ticket Claimed", interaction.user.tag);

        await interaction.reply({
          content: `🙋 This ticket has been claimed by ${interaction.user}.`
        });

        await sendTicketLog(
          interaction.guild,
          new EmbedBuilder()
            .setColor(0x3B82F6)
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
          WHERE channel_id=? AND status='open'
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

        await interaction.channel.permissionOverwrites
          .delete(ticket.owner_id)
          .catch(error => console.error("Ticket owner permission removal error:", error));

        await interaction.channel.setName(
          `closed-${oldName}`.slice(0, 100)
        );

        db.prepare(`
          UPDATE tickets SET status='closed'
          WHERE channel_id=?
        `).run(interaction.channelId);

        logEvent(interaction.guildId, "Ticket Closed", interaction.user.tag);

        await interaction.message.edit({ components: [] }).catch(() => {});

        await interaction.channel.send({
          content: `🔒 Ticket closed by ${interaction.user}.\nThis ticket is now hidden from its owner and regular members. Staff can still access it.`
        }).catch(() => {});

        await sendTicketLog(
          interaction.guild,
          new EmbedBuilder()
            .setColor(0xEF4444)
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

      return publishCommandCenter(interaction);
    }

    if (command === "ticket-panel") {
      const embed = new EmbedBuilder()
        .setColor(GOLD)
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

    if (command === "ticket-role") {
      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: "You need Manage Server permission.",
          ephemeral: true
        });
      }

      const action = interaction.options.getSubcommand();
      const role = action === "list"
        ? null
        : interaction.options.getRole("role");

      if (action === "add") {
        db.prepare(`
          INSERT OR IGNORE INTO ticket_staff_roles
          (guild_id,role_id) VALUES (?,?)
        `).run(guildId, role.id);

        return interaction.reply({
          content: `✅ ${role} can now manage tickets.`,
          ephemeral: true
        });
      }

      if (action === "remove") {
        db.prepare(`
          DELETE FROM ticket_staff_roles
          WHERE guild_id=? AND role_id=?
        `).run(guildId, role.id);

        return interaction.reply({
          content: `✅ ${role} has been removed from ticket staff.`,
          ephemeral: true
        });
      }

      if (action === "list") {
        const roles = db.prepare(`
          SELECT role_id FROM ticket_staff_roles
          WHERE guild_id=?
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

    if (command === "id") {
      const target = interaction.options.getUser("member") || interaction.user;
      const data = getMember(guildId, target.id);

      const embed = new EmbedBuilder()
        .setColor(GOLD)
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
            .setColor(0x8B5CF6)
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
            .setColor(GOLD)
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
        SELECT user_id,xp FROM members
        WHERE guild_id=?
        ORDER BY xp DESC LIMIT 10
      `).all(guildId);

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(GOLD)
            .setTitle("🏆 One4All Leaderboard")
            .setDescription(
              top.map((r, i) =>
                `**${i + 1}.** <@${r.user_id}> — ${r.xp} XP`
              ).join("\n") || "No members yet."
            )
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
        UPDATE members SET xp=xp+50,last_daily=?
        WHERE guild_id=? AND user_id=?
      `).run(now, guildId, userId);

      return interaction.reply({
        content: "🎁 You received **50 XP** as your daily reward!"
      });
    }

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
        UPDATE members SET reputation=reputation+?
        WHERE guild_id=? AND user_id=?
      `).run(points, guildId, target.id);

      return interaction.reply({
        content: `⭐ Added **${points}** reputation points to ${target}.`
      });
    }

  } catch (error) {
    console.error("Interaction error:", error);

    const payload = {
      content: "Something went wrong. Please try again.",
      ephemeral: true
    };

    if (interaction.replied || interaction.deferred) {
      return interaction.followUp(payload).catch(() => {});
    }

    return interaction.reply(payload).catch(() => {});
  }
});

// ================= LOGIN =================

client.login(token);
