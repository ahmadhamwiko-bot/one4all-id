
const express = require("express");
const session = require("express-session");
const axios = require("axios");
const { EmbedBuilder, PermissionsBitField } = require("discord.js");

const GUILD_ID = "1568590852723449959";
const ANNOUNCEMENTS_CHANNEL_ID = "1572330796159864862";

module.exports = function startDashboard(client, db) {
  const app = express();

  const PORT = process.env.SERVER_PORT || 3000;
  const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
  const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
  const SESSION_SECRET =
    process.env.DASHBOARD_SESSION_SECRET || CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET || !SESSION_SECRET) {
    console.error("Dashboard: Missing Discord OAuth or session secrets.");
    return;
  }

  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    session({
      name: "one4all.sid",
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000
      }
    })
  );

  const BASE_URL = "https://cgypv1qwl5.apps.bot-hosting.cloud";
  const REDIRECT_URI = `${BASE_URL}/auth/callback`;

  // Create the dashboard table without touching existing tables.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_message_id TEXT UNIQUE,
      author_id TEXT,
      author_name TEXT,
      title TEXT,
      content TEXT,
      attachments TEXT DEFAULT '[]',
      source TEXT DEFAULT 'manual',
      created_at INTEGER
    )
  `);

  function getStaffRoleIds() {
    try {
      const columns = db.prepare(
        "PRAGMA table_info(ticket_staff_roles)"
      ).all();

      if (!columns.length) return [];

      const names = columns.map(c => c.name);
      const roleColumn = names.find(n =>
        ["role_id", "roleId", "staff_role_id", "role"].includes(n)
      );

      if (!roleColumn) {
        console.error(
          "Dashboard: Could not identify the role ID column in ticket_staff_roles."
        );
        return [];
      }

      const guildColumn = names.find(n =>
        ["guild_id", "guildId", "server_id"].includes(n)
      );

      let rows;

      if (guildColumn) {
        rows = db.prepare(
          `SELECT "${roleColumn}" AS role_id
           FROM ticket_staff_roles
           WHERE "${guildColumn}" = ?`
        ).all(GUILD_ID);
      } else {
        rows = db.prepare(
          `SELECT "${roleColumn}" AS role_id FROM ticket_staff_roles`
        ).all();
      }

      return rows.map(row => String(row.role_id));
    } catch (error) {
      console.error("Dashboard staff roles error:", error.message);
      return [];
    }
  }

  async function checkStaff(userId) {
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(userId);

      if (
        member.permissions.has(
          PermissionsBitField.Flags.ManageGuild
        )
      ) {
        return true;
      }

      const staffRoles = getStaffRoleIds();

      return member.roles.cache.some(role =>
        staffRoles.includes(role.id)
      );
    } catch {
      return false;
    }
  }

  function requireLogin(req, res, next) {
    if (!req.session.user) {
      return res.status(401).json({
        error: "Please log in with Discord first."
      });
    }

    next();
  }

  function requireStaff(req, res, next) {
    if (!req.session.user || !req.session.user.staff) {
      return res.status(403).json({
        error: "Staff access required."
      });
    }

    next();
  }

  function makeTitle(content) {
    const firstLine = String(content || "")
      .split("\n")
      .find(line => line.trim());

    return (firstLine || "Server Announcement").slice(0, 100);
  }

  function getAttachments(message) {
    return [...message.attachments.values()].map(file => ({
      url: file.url,
      name: file.name || "Attachment",
      contentType: file.contentType || ""
    }));
  }

  function saveDiscordAnnouncement(message) {
    if (!message || !message.guild) return;
    if (message.guild.id !== GUILD_ID) return;
    if (message.channel.id !== ANNOUNCEMENTS_CHANNEL_ID) return;
    if (message.author?.bot) return;

    const content = message.content || "";
    const attachments = getAttachments(message);

    if (!content.trim() && attachments.length === 0) return;

    db.prepare(`
      INSERT INTO dashboard_updates (
        source_message_id,
        author_id,
        author_name,
        title,
        content,
        attachments,
        source,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'discord', ?)
      ON CONFLICT(source_message_id) DO UPDATE SET
        author_name = excluded.author_name,
        title = excluded.title,
        content = excluded.content,
        attachments = excluded.attachments
    `).run(
      message.id,
      message.author.id,
      message.author.username,
      makeTitle(content),
      content,
      JSON.stringify(attachments),
      message.createdTimestamp
    );
  }

  // Automatically synchronize new announcements and edits.
  client.on("messageCreate", message => {
    try {
      saveDiscordAnnouncement(message);
    } catch (error) {
      console.error("Announcement sync error:", error.message);
    }
  });

  client.on("messageUpdate", async (oldMessage, newMessage) => {
    try {
      if (newMessage.partial) {
        newMessage = await newMessage.fetch();
      }
      saveDiscordAnnouncement(newMessage);
    } catch (error) {
      console.error("Announcement edit sync error:", error.message);
    }
  });

  // Import the latest 50 existing announcements on startup.
  async function backfillAnnouncements() {
    try {
      const channel = await client.channels.fetch(
        ANNOUNCEMENTS_CHANNEL_ID
      );

      if (!channel || !channel.isTextBased()) {
        console.error("Dashboard: Announcement channel not found.");
        return;
      }

      const messages = await channel.messages.fetch({ limit: 50 });

      for (const message of messages.values()) {
        saveDiscordAnnouncement(message);
      }

      console.log(
        `Dashboard: Synced ${messages.size} announcement messages.`
      );
    } catch (error) {
      console.error("Dashboard backfill error:", error.message);
    }
  }

  if (client.isReady()) {
    backfillAnnouncements();
  } else {
    client.once("ready", backfillAnnouncements);
  }

  // Discord OAuth login.
  app.get("/auth/login", (req, res) => {
    const url = new URL("https://discord.com/oauth2/authorize");

    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "identify");

    res.redirect(url.toString());
  });

  app.get("/auth/callback", async (req, res) => {
    try {
      const code = req.query.code;

      if (!code) {
        return res.status(400).send("Discord authorization code missing.");
      }

      const tokenResponse = await axios.post(
        "https://discord.com/api/oauth2/token",
        new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: "authorization_code",
          code: String(code),
          redirect_uri: REDIRECT_URI
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          }
        }
      );

      const accessToken = tokenResponse.data.access_token;

      const userResponse = await axios.get(
        "https://discord.com/api/users/@me",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        }
      );

      const user = userResponse.data;

      // Confirm the user is actually a member of the One4All server
      // and check their real Discord permissions and configured staff roles.
      const staff = await checkStaff(user.id);

      req.session.user = {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        staff
      };

      req.session.save(error => {
        if (error) {
          console.error("Session save error:", error.message);
          return res.status(500).send("Could not create your session.");
        }

        res.redirect("/");
      });
    } catch (error) {
      console.error(
        "Discord login error:",
        error.response?.data || error.message
      );

      res.status(500).send(
        "Discord login failed. Please try again."
      );
    }
  });

  app.get("/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.redirect("/");
    });
  });

  // Current user.
  app.get("/api/me", (req, res) => {
    res.json({
      loggedIn: !!req.session.user,
      user: req.session.user || null
    });
  });

  // Public updates feed.
  app.get("/api/updates", (req, res) => {
    try {
      const updates = db.prepare(`
        SELECT *
        FROM dashboard_updates
        ORDER BY created_at DESC
        LIMIT 100
      `).all();

      res.json(updates.map(update => ({
        ...update,
        attachments: (() => {
          try {
            return JSON.parse(update.attachments || "[]");
          } catch {
            return [];
          }
        })()
      })));
    } catch (error) {
      console.error("Updates fetch error:", error.message);
      res.status(500).json({ error: "Could not load updates." });
    }
  });

  // Staff-only manual publishing.
  app.post(
    "/api/updates",
    requireLogin,
    requireStaff,
    async (req, res) => {
      try {
        const title = String(req.body.title || "").trim().slice(0, 100);
        const content = String(req.body.content || "").trim();

        if (!content) {
          return res.status(400).json({
            error: "Announcement content is required."
          });
        }

        const channel = await client.channels.fetch(
          ANNOUNCEMENTS_CHANNEL_ID
        );

        if (!channel || !channel.isTextBased()) {
          return res.status(500).json({
            error: "Announcement channel is unavailable."
          });
        }

        const embed = new EmbedBuilder()
          .setColor(0xD4AF37)
          .setTitle(title || "One4All Server Update")
          .setDescription(content.slice(0, 4000))
          .setFooter({ text: "One4All • Official Server Update" })
          .setTimestamp();

        const sentMessage = await channel.send({
          embeds: [embed]
        });

        db.prepare(`
          INSERT INTO dashboard_updates (
            source_message_id,
            author_id,
            author_name,
            title,
            content,
            attachments,
            source,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, '[]', 'manual', ?)
        `).run(
          `manual-${sentMessage.id}`,
          req.session.user.id,
          req.session.user.username,
          title || "One4All Server Update",
          content,
          Date.now()
        );

        res.json({
          success: true,
          message: "Update published successfully."
        });
      } catch (error) {
        console.error("Manual publish error:", error.message);
        res.status(500).json({
          error: "Could not publish the update."
        });
      }
    }
  );

  // Dashboard page.
  app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>One4All Dashboard</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  background:#090909;
  color:#f5f5f5;
  font-family:Arial,sans-serif;
}
header{
  padding:22px 18px;
  border-bottom:1px solid #6e541e;
  display:flex;
  justify-content:space-between;
  align-items:center;
  flex-wrap:wrap;
  gap:12px;
}
.logo{
  color:#d4af37;
  font-size:25px;
  font-weight:900;
  letter-spacing:2px;
}
a,button{cursor:pointer}
a{color:#d4af37;text-decoration:none}
button{
  background:#d4af37;
  color:#111;
  border:0;
  padding:12px 18px;
  border-radius:7px;
  font-weight:bold;
}
main{
  max-width:950px;
  margin:30px auto;
  padding:0 16px;
}
h1{color:#d4af37}
.subtitle{color:#aaa}
.panel{
  background:#151515;
  border:1px solid #493b1d;
  border-radius:12px;
  padding:20px;
  margin:22px 0;
}
.update{
  background:#111;
  border:1px solid #37302a;
  border-left:3px solid #d4af37;
  border-radius:9px;
  padding:17px;
  margin:15px 0;
  overflow-wrap:anywhere;
}
.update h3{color:#e2c15d;margin-top:0}
.update p{white-space:pre-wrap;line-height:1.6}
.meta{color:#888;font-size:12px;margin-top:12px}
.update img{
  max-width:100%;
  max-height:350px;
  border-radius:8px;
  margin-top:12px;
}
input,textarea{
  width:100%;
  background:#090909;
  border:1px solid #55451f;
  color:white;
  border-radius:7px;
  padding:13px;
  margin:8px 0 14px;
  font:inherit;
}
textarea{min-height:130px;resize:vertical}
.hidden{display:none}
.gold{color:#d4af37}
footer{text-align:center;color:#666;padding:30px}
</style>
</head>
<body>
<header>
  <div class="logo">ONE4ALL <span style="font-size:13px">1FA</span></div>
  <div id="account">
    <a href="/auth/login"><button>Login with Discord</button></a>
  </div>
</header>

<main>
  <h1>Server Updates</h1>
  <p class="subtitle">Official announcements and news from the One4All community.</p>

  <section id="admin" class="panel hidden">
    <h2 class="gold">Staff Publishing</h2>
    <form id="publishForm">
      <label>Update title</label>
      <input id="title" maxlength="100" placeholder="Announcement title">
      <label>Announcement content</label>
      <textarea id="content" required placeholder="Write your update..."></textarea>
      <button type="submit">Publish Update</button>
      <p id="publishStatus"></p>
    </form>
  </section>

  <section class="panel">
    <div id="updates">Loading updates...</div>
  </section>
</main>

<footer>ONE4ALL • 1FA</footer>

<script>
const updatesBox = document.getElementById("updates");

function escapeText(value) {
  return String(value || "");
}

function renderUpdates(items) {
  updatesBox.replaceChildren();

  if (!items.length) {
    updatesBox.textContent = "No updates published yet.";
    return;
  }

  for (const item of items) {
    const article = document.createElement("article");
    article.className = "update";

    const heading = document.createElement("h3");
    heading.textContent = escapeText(item.title);

    const paragraph = document.createElement("p");
    paragraph.textContent = escapeText(item.content);

    const meta = document.createElement("div");
    meta.className = "meta";

    const date = new Date(Number(item.created_at));
    meta.textContent =
      "By " + escapeText(item.author_name || "One4All") +
      " • " + (isNaN(date.getTime()) ? "" : date.toLocaleString());

    article.append(heading, paragraph);

    for (const file of (item.attachments || [])) {
      const link = document.createElement("a");
      link.href = file.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "📎 " + escapeText(file.name);
      article.append(link);

      if (
        file.contentType &&
        file.contentType.startsWith("image/")
      ) {
        const image = document.createElement("img");
        image.src = file.url;
        image.alt = escapeText(file.name);
        image.loading = "lazy";
        article.append(image);
      }
    }

    article.append(meta);
    updatesBox.append(article);
  }
}

async function loadUpdates() {
  try {
    const response = await fetch("/api/updates");
    if (!response.ok) throw new Error("Failed to load updates");
    renderUpdates(await response.json());
  } catch {
    updatesBox.textContent = "Could not load updates. Please refresh.";
  }
}

async function loadAccount() {
  const response = await fetch("/api/me");
  const data = await response.json();
  const account = document.getElementById("account");

  if (!data.loggedIn) return;

  account.replaceChildren();

  const name = document.createElement("span");
  name.textContent = data.user.username + " ";

  const logout = document.createElement("a");
  logout.href = "/auth/logout";
  logout.textContent = "Logout";

  account.append(name, logout);

  if (data.user.staff) {
    document.getElementById("admin").classList.remove("hidden");
  }
}

document.getElementById("publishForm").addEventListener("submit", async event => {
  event.preventDefault();

  const status = document.getElementById("publishStatus");
  status.textContent = "Publishing...";

  try {
    const response = await fetch("/api/updates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: document.getElementById("title").value,
        content: document.getElementById("content").value
      })
    });

    const result = await response.json();

    if (!response.ok) throw new Error(result.error || "Publishing failed");

    status.textContent = "Published successfully!";
    document.getElementById("publishForm").reset();
    await loadUpdates();
  } catch (error) {
    status.textContent = error.message;
  }
});

loadAccount();
loadUpdates();
</script>
</body>
</html>`);
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`One4All Dashboard listening on port ${PORT}`);
  });
};
