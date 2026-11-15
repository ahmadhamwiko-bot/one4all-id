
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField
} = require("discord.js");

const Database = require("better-sqlite3");

const token = process.env.DISCORD_TOKEN;

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

client.once("ready", () => {
  console.log(`${client.user.tag} is online!`);
});

client.on("guildMemberAdd", member => {
  getMember(member.guild.id, member.id);
});

client.on("messageCreate", message => {
  if (!message.guild || message.author.bot) return;

  const member = getMember(message.guild.id, message.author.id);
  const gained = Math.floor(Math.random() * 6) + 5;

  db.prepare(`
    UPDATE members SET xp = xp + ?
    WHERE guild_id = ? AND user_id = ?
  `).run(gained, message.guild.id, message.author.id);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const command = interaction.commandName;

  try {
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
            .setDescription(achievements.length
              ? achievements.join("\n")
              : "No achievements yet. Keep participating!")
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

      return interaction.reply("🎁 You received **50 XP** as your daily reward!");
    }

    if (command === "admin") {
      if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
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
      if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
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
      });
    }

    return interaction.reply({
      content: "Something went wrong. Please try again.",
      ephemeral: true
    });
  }
});

client.login(token);
