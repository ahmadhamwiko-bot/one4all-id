
const express = require("express");
const session = require("express-session");
const axios = require("axios");
const crypto = require("crypto");
const {
  EmbedBuilder,
  PermissionsBitField
} = require("discord.js");

module.exports = function startDashboard(client, db) {
  const app = express();

  const PORT = process.env.SERVER_PORT || 3000;
  const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
  const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
  const SESSION_SECRET =
    process.env.DASHBOARD_SESSION_SECRET || CLIENT_SECRET;

  const BASE_URL = "https://cgypv1qwl5.apps.bot-hosting.cloud";
  const REDIRECT_URI = `${BASE_URL}/auth/callback`;

  const GUILD_ID = "1568590852723449959";
  const ANNOUNCEMENT_CHANNEL_ID = "1568642186579415130";

  if (!CLIENT_ID || !CLIENT_SECRET || !SESSION_SECRET) {
    console.error("[Dashboard] Missing Discord OAuth environment variables.");
  }

  app.set("trust proxy", 1);
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use(session({
    name: "one4all.sid",
    secret: SESSION_SECRET || "temporary-dashboard-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000
    }
  }));

  // ================= DATABASE =================

  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      content TEXT,
      source_message_id TEXT UNIQUE,
      discord_message_id TEXT,
      attachments TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  function tableColumns(table) {
    try {
      return db.prepare(`PRAGMA table_info("${table}")`).all()
        .map(column => column.name);
    } catch {
      return [];
    }
  }

  function safeCount(table) {
    try {
      if (!tableColumns(table).length) return 0;
      return Number(
        db.prepare(`SELECT COUNT(*) AS total FROM "${table}"`).get().total
      ) || 0;
    } catch {
      return 0;
    }
  }

  function recentRows(table, limit = 8) {
    try {
      const columns = tableColumns(table);
      if (!columns.length) return [];

      const orderColumn = ["created_at", "timestamp", "id"]
        .find(column => columns.includes(column));

      const order = orderColumn
        ? `ORDER BY "${orderColumn}" DESC`
        : "";

      return db.prepare(
        `SELECT * FROM "${table}" ${order} LIMIT ?`
      ).all(limit);
    } catch {
      return [];
    }
  }

  function getStaffRoleIds() {
    try {
      const columns = tableColumns("ticket_staff_roles");
      if (!columns.includes("role_id")) return [];

      const guildFilter = columns.includes("guild_id")
        ? "WHERE guild_id = ?"
        : "";

      const rows = columns.includes("guild_id")
        ? db.prepare(
            `SELECT role_id FROM ticket_staff_roles ${guildFilter}`
          ).all(GUILD_ID)
        : db.prepare(
            "SELECT role_id FROM ticket_staff_roles"
          ).all();

      return rows.map(row => String(row.role_id));
    } catch {
      return [];
    }
  }

  async function checkStaff(userId) {
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(userId);

      if (member.permissions.has(
        PermissionsBitField.Flags.ManageGuild
      )) {
        return true;
      }

      const allowedRoles = getStaffRoleIds();

      return member.roles.cache.some(role =>
        allowedRoles.includes(role.id)
      );
    } catch {
      return false;
    }
  }

  // ================= ANNOUNCEMENT SYNC =================

  function saveAnnouncement(message) {
    try {
      if (!message || message.guildId !== GUILD_ID) return;
      if (message.channelId !== ANNOUNCEMENT_CHANNEL_ID) return;
      if (message.author?.bot) return;

      const attachments = [...message.attachments.values()].map(file => ({
        name: file.name,
        url: file.url,
        contentType: file.contentType
      }));

      const title =
        message.embeds?.[0]?.title ||
        message.content?.split("\n")[0]?.slice(0, 100) ||
        "Server Announcement";

      const content =
        message.content ||
        message.embeds?.map(embed => embed.description || "").join("\n") ||
        "";

      const columns = tableColumns("dashboard_updates");

      const values = {
        title,
        content,
        source_message_id: message.id,
        discord_message_id: message.id,
        attachments: JSON.stringify(attachments),
        created_at: new Date(message.createdTimestamp).toISOString()
      };

      const selected = Object.keys(values)
        .filter(key => columns.includes(key));

      const columnNames = selected.map(key => `"${key}"`).join(",");
      const placeholders = selected.map(() => "?").join(",");
      const params = selected.map(key => values[key]);

      db.prepare(
        `INSERT OR IGNORE INTO dashboard_updates (${columnNames})
         VALUES (${placeholders})`
      ).run(...params);

      const updateFields = selected
        .filter(key => key !== "source_message_id")
        .map(key => `"${key}" = ?`);

      const updateParams = selected
        .filter(key => key !== "source_message_id")
        .map(key => values[key]);

      if (updateFields.length) {
        db.prepare(
          `UPDATE dashboard_updates
           SET ${updateFields.join(",")}
           WHERE source_message_id = ?`
        ).run(...updateParams, message.id);
      }
    } catch (error) {
      console.error("[Dashboard] Announcement sync error:", error);
    }
  }

  client.on("messageCreate", saveAnnouncement);

  client.on("messageUpdate", (oldMessage, newMessage) => {
    saveAnnouncement(newMessage);
  });

  async function backfillAnnouncements() {
    try {
      const channel = await client.channels.fetch(
        ANNOUNCEMENT_CHANNEL_ID
      );

      if (!channel || !channel.isTextBased()) return;

      const messages = await channel.messages.fetch({ limit: 50 });

      for (const message of messages.values()) {
        saveAnnouncement(message);
      }

      console.log(
        `[Dashboard] Synced ${messages.size} announcement messages.`
      );
    } catch (error) {
      console.error("[Dashboard] Backfill error:", error.message);
    }
  }

  if (client.isReady()) {
    backfillAnnouncements();
  } else {
    client.once("clientReady", backfillAnnouncements);
  }

  // ================= OAUTH =================

  app.get("/auth/login", (req, res) => {
    if (!CLIENT_ID) {
      return res.status(500).send("Discord Client ID missing.");
    }

    const state = crypto.randomBytes(24).toString("hex");
    req.session.oauthState = state;

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "identify",
      state
    });

    res.redirect(
      `https://discord.com/oauth2/authorize?${params.toString()}`
    );
  });

  app.get("/auth/callback", async (req, res) => {
    try {
      const { code, state } = req.query;

      if (!code || !state || state !== req.session.oauthState) {
        return res.status(400).send("Invalid login session.");
      }

      delete req.session.oauthState;

      const tokenResponse = await axios.post(
        "https://discord.com/api/oauth2/token",
        new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          }
        }
      );

      const userResponse = await axios.get(
        "https://discord.com/api/users/@me",
        {
          headers: {
            Authorization:
              `Bearer ${tokenResponse.data.access_token}`
          }
        }
      );

      req.session.user = userResponse.data;
      req.session.isStaff = await checkStaff(userResponse.data.id);

      res.redirect("/");
    } catch (error) {
      console.error(
        "[Dashboard] OAuth error:",
        error.response?.data || error.message
      );
      res.status(500).send("Discord login failed. Please try again.");
    }
  });

  app.get("/auth/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/"));
  });

  function requireLogin(req, res, next) {
    if (!req.session.user) {
      return res.status(401).json({ error: "Login required." });
    }
    next();
  }

  async function requireStaff(req, res, next) {
    if (!req.session.user) {
      return res.status(401).json({ error: "Login required." });
    }

    const allowed = await checkStaff(req.session.user.id);
    req.session.isStaff = allowed;

    if (!allowed) {
      return res.status(403).json({ error: "Staff access required." });
    }

    next();
  }

  // ================= API =================

  app.get("/api/me", (req, res) => {
    res.json({
      loggedIn: !!req.session.user,
      user: req.session.user || null,
      isStaff: !!req.session.isStaff
    });
  });

  app.get("/api/dashboard", requireLogin, async (req, res) => {
    try {
      const guild = await client.guilds.fetch(GUILD_ID);

      await guild.members.fetch({ withPresences: true }).catch(() => null);

      const online = guild.members.cache.filter(member =>
        member.presence &&
        member.presence.status !== "offline"
      ).size;

      let openTickets = 0;
      let closedTickets = 0;

      try {
        const ticketColumns = tableColumns("tickets");

        if (ticketColumns.length) {
          const statusColumn = ["status", "state"]
            .find(column => ticketColumns.includes(column));

          if (statusColumn) {
            const rows = db.prepare(
              `SELECT "${statusColumn}" AS status, COUNT(*) AS total
               FROM tickets GROUP BY "${statusColumn}"`
            ).all();

            for (const row of rows) {
              const status = String(row.status || "").toLowerCase();

              if (
                status.includes("closed") ||
                status.includes("close")
              ) {
                closedTickets += row.total;
              } else {
                openTickets += row.total;
              }
            }
          } else {
            openTickets = safeCount("tickets");
          }
        }
      } catch {}

      const updates = db.prepare(`
        SELECT * FROM dashboard_updates
        ORDER BY id DESC LIMIT 8
      `).all();

      res.json({
        server: {
          name: guild.name,
          icon: guild.iconURL({ size: 128 }),
          members: guild.memberCount,
          online,
          roles: guild.roles.cache.size,
          channels: guild.channels.cache.size
        },
        tickets: {
          open: openTickets,
          closed: closedTickets,
          total: openTickets + closedTickets
        },
        database: {
          members: safeCount("members"),
          activity: safeCount("activity")
        },
        updates,
        activity: recentRows("activity", 8),
        staffRoles: getStaffRoleIds().length,
        bot: {
          username: client.user?.tag || "One4All Bot",
          ping: Math.round(client.ws.ping)
        }
      });
    } catch (error) {
      console.error("[Dashboard] Stats error:", error);
      res.status(500).json({
        error: "Could not load dashboard statistics."
      });
    }
  });

  app.get("/api/updates", (req, res) => {
    try {
      const updates = db.prepare(`
        SELECT * FROM dashboard_updates
        ORDER BY id DESC LIMIT 50
      `).all();

      res.json(updates);
    } catch {
      res.json([]);
    }
  });

  // ================= PUBLISH UPDATE =================

  app.post("/api/updates", requireStaff, async (req, res) => {
    try {
      const title = String(req.body.title || "").trim();
      const content = String(req.body.content || "").trim();

      if (!title || !content) {
        return res.status(400).json({
          error: "Title and announcement content are required."
        });
      }

      const channel = await client.channels.fetch(
        ANNOUNCEMENT_CHANNEL_ID
      );

      if (!channel || !channel.isTextBased()) {
        return res.status(500).json({
          error: "Announcement channel not found."
        });
      }

      const embed = new EmbedBuilder()
        .setColor(0xD4AF37)
        .setTitle(title)
        .setDescription(content)
        .setFooter({
          text: "One4All • Official Server Updates"
        })
        .setTimestamp();

      // Allow @everyone mention only when explicitly included in content.
      const shouldMentionEveryone = /@everyone\b/.test(content);

      const message = await channel.send({
        content: shouldMentionEveryone ? "@everyone" : undefined,
        embeds: [embed],
        allowedMentions: {
          parse: shouldMentionEveryone ? ["everyone"] : []
        }
      });

      const columns = tableColumns("dashboard_updates");

      const values = {
        title,
        content,
        source_message_id: null,
        discord_message_id: message.id,
        attachments: "[]",
        created_at: new Date().toISOString()
      };

      const selected = Object.keys(values)
        .filter(key => columns.includes(key));

      db.prepare(
        `INSERT INTO dashboard_updates
         (${selected.map(key => `"${key}"`).join(",")})
         VALUES (${selected.map(() => "?").join(",")})`
      ).run(...selected.map(key => values[key]));

      res.json({ success: true });
    } catch (error) {
      console.error("[Dashboard] Publish error:", error);
      res.status(500).json({
        error: "Could not publish update."
      });
    }
  });

  // ================= DASHBOARD PAGE =================

  app.get("/", (req, res) => {
    const loggedIn = !!req.session.user;
    const isStaff = !!req.session.isStaff;

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>One4All Command Center</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#090909;color:#eee;font-family:Arial,sans-serif}
header{padding:22px 5%;border-bottom:1px solid #302710;background:#101010;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:15px}
.brand{font-size:23px;font-weight:900;color:#e3bd50;letter-spacing:2px}
.brand span{color:#fff}
button,a{cursor:pointer}
.login,.gold{background:#d4af37;color:#111;border:0;padding:12px 18px;border-radius:8px;font-weight:bold;text-decoration:none}
.logout{color:#d4af37;text-decoration:none}
main{max-width:1200px;margin:auto;padding:28px 18px}
h1{font-size:27px;margin:5px 0;color:#e2bd56}
.sub{color:#888;margin-bottom:25px}
.nav{display:flex;gap:9px;flex-wrap:wrap;margin:22px 0}
.nav button{background:#171717;color:#bbb;border:1px solid #333;padding:12px 15px;border-radius:8px}
.nav button.active,.nav button:hover{border-color:#d4af37;color:#e5c45f}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}
.card{background:linear-gradient(145deg,#191919,#101010);border:1px solid #332b17;border-radius:13px;padding:19px;min-height:125px}
.card small{color:#999}
.number{font-size:31px;color:#e1bd54;font-weight:bold;margin-top:13px}
.section{display:none}
.section.active{display:block}
.panel{background:#141414;border:1px solid #302817;border-radius:12px;padding:20px;margin-top:17px}
input,textarea{width:100%;background:#090909;color:white;border:1px solid #383838;border-radius:8px;padding:13px;margin:8px 0 15px}
textarea{min-height:130px;resize:vertical}
.update{padding:14px 0;border-bottom:1px solid #292929}
.update:last-child{border:0}
.update h3{color:#e0bb50;margin:0 0 8px}
.muted{color:#999;font-size:13px}
.status{color:#d4af37}
#notice{margin:12px 0;color:#d4af37}
footer{text-align:center;color:#666;padding:30px}
</style>
</head>
<body>
<header>
<div class="brand">ONE<span>4</span>ALL <span>COMMAND CENTER</span></div>
<div>
${loggedIn
  ? `<span class="muted">${escapeHtml(req.session.user.username)}</span> &nbsp; <a class="logout" href="/auth/logout">Logout</a>`
  : `<a class="login" href="/auth/login">Login with Discord</a>`}
</div>
</header>
<main>
<h1>Live Command Center</h1>
<div class="sub">Official One4All server control panel</div>

${loggedIn ? `
<div class="nav">
<button class="active" onclick="showSection('overview',this)">Overview</button>
<button onclick="showSection('updates',this)">Server Updates</button>
<button onclick="showSection('activity',this)">Activity Logs</button>
<button onclick="showSection('staff',this)">Staff & System</button>
</div>

<section id="overview" class="section active">
<div class="grid">
<div class="card"><small>Total Members</small><div class="number" id="members">—</div></div>
<div class="card"><small>Online Members</small><div class="number" id="online">—</div></div>
<div class="card"><small>Open Tickets</small><div class="number" id="openTickets">—</div></div>
<div class="card"><small>Closed Tickets</small><div class="number" id="closedTickets">—</div></div>
<div class="card"><small>Total Channels</small><div class="number" id="channels">—</div></div>
<div class="card"><small>Server Roles</small><div class="number" id="roles">—</div></div>
<div class="card"><small>Bot Ping</small><div class="number" id="ping">—</div></div>
<div class="card"><small>Database Members</small><div class="number" id="dbMembers">—</div></div>
</div>
<div class="panel">
<h3>Server Status</h3>
<div id="serverName" class="status">Loading...</div>
<p class="muted">Dashboard refreshes automatically every 60 seconds.</p>
</div>
</section>

<section id="updates" class="section">
<div class="panel">
<h2>Server Updates</h2>
<div id="updatesList">Loading updates...</div>
</div>
${isStaff ? `
<div class="panel">
<h2>Publish New Update</h2>
<label>Update title</label>
<input id="updateTitle" placeholder="Enter update title">
<label>Announcement content</label>
<textarea id="updateContent" placeholder="Write your announcement..."></textarea>
<button class="gold" onclick="publishUpdate()">Publish Update</button>
<div id="notice"></div>
</div>` : ""}
</section>

<section id="activity" class="section">
<div class="panel">
<h2>Recent Activity</h2>
<div id="activityList" class="muted">Loading activity...</div>
</div>
</section>

<section id="staff" class="section">
<div class="panel">
<h2>Staff & System</h2>
<p>Staff roles configured: <strong id="staffRoles">—</strong></p>
<p>Bot: <strong id="botName">—</strong></p>
<p>Connection: <strong class="status">Online</strong></p>
<p class="muted">Staff access is controlled by Discord Manage Server permission or configured ticket staff roles.</p>
</div>
</section>
` : `
<div class="panel">
<h2>Welcome to One4All</h2>
<p class="muted">Sign in with Discord to access the Live Command Center.</p>
<a class="login" href="/auth/login">Login with Discord</a>
</div>
`}
</main>
<footer>ONE4ALL • OFFICIAL COMMAND CENTER</footer>

<script>
function escapeText(value){
  const div=document.createElement("div");
  div.textContent=String(value??"");
  return div.innerHTML;
}

function showSection(id,button){
  document.querySelectorAll(".section").forEach(s=>s.classList.remove("active"));
  document.querySelectorAll(".nav button").forEach(b=>b.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  button.classList.add("active");
  if(id==="updates") loadUpdates();
  if(id==="activity") loadDashboard();
}

async function loadDashboard(){
  try{
    const response=await fetch("/api/dashboard");
    if(!response.ok) return;
    const data=await response.json();

    document.getElementById("members").textContent=data.server.members;
    document.getElementById("online").textContent=data.server.online;
    document.getElementById("openTickets").textContent=data.tickets.open;
    document.getElementById("closedTickets").textContent=data.tickets.closed;
    document.getElementById("channels").textContent=data.server.channels;
    document.getElementById("roles").textContent=data.server.roles;
    document.getElementById("ping").textContent=data.bot.ping+" ms";
    document.getElementById("dbMembers").textContent=data.database.members;
    document.getElementById("serverName").textContent=data.server.name;
    document.getElementById("staffRoles").textContent=data.staffRoles;
    document.getElementById("botName").textContent=data.bot.username;

    const activity=document.getElementById("activityList");
    activity.innerHTML=data.activity.length
      ? data.activity.map(item=>'<div class="update">'+
        escapeText(JSON.stringify(item))+'</div>').join("")
      : "No recent activity available.";

    renderUpdates(data.updates);
  }catch(error){
    console.error(error);
  }
}

function renderUpdates(items){
  const target=document.getElementById("updatesList");
  if(!items||!items.length){
    target.textContent="No updates published yet.";
    return;
  }

  target.innerHTML=items.map(item=>
    '<div class="update"><h3>'+escapeText(item.title)+'</h3>'+
    '<p>'+escapeText(item.content)+'</p>'+
    '<div class="muted">'+escapeText(item.created_at||"")+'</div></div>'
  ).join("");
}

async function loadUpdates(){
  try{
    const response=await fetch("/api/updates");
    const data=await response.json();
    renderUpdates(data);
  }catch(error){}
}

async function publishUpdate(){
  const title=document.getElementById("updateTitle").value.trim();
  const content=document.getElementById("updateContent").value.trim();
  const notice=document.getElementById("notice");

  if(!title||!content){
    notice.textContent="Please fill in both fields.";
    return;
  }

  notice.textContent="Publishing...";

  try{
    const response=await fetch("/api/updates",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({title,content})
    });

    const result=await response.json();

    if(!response.ok){
      notice.textContent=result.error||"Publishing failed.";
      return;
    }

    notice.textContent="Update published successfully!";
    document.getElementById("updateTitle").value="";
    document.getElementById("updateContent").value="";
    await loadUpdates();
    await loadDashboard();
  }catch(error){
    notice.textContent="Connection error.";
  }
}

${loggedIn ? `
loadDashboard();
loadUpdates();
setInterval(loadDashboard,60000);
setInterval(loadUpdates,60000);
` : ""}
</script>
</body>
</html>`);
  });

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[character]);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`One4All Dashboard listening on port ${PORT}`);
  });
};
