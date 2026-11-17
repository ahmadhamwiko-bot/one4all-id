const express = require("express");
const session = require("express-session");
const axios = require("axios");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const db = new Database("one4all.db");

const PORT = process.env.SERVER_PORT || 3000;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const GUILD_ID = "1568590852723449959";
const ANNOUNCEMENTS_CHANNEL_ID = "1572330796159864862";

const REDIRECT_URI =
  "https://cgypv1qwl5.apps.bot-hosting.cloud/auth/callback";

const GOLD = "#D4AF37";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.DASHBOARD_SESSION_SECRET || CLIENT_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000
  }
}));

db.exec(`
CREATE TABLE IF NOT EXISTS dashboard_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  source_message_id TEXT UNIQUE,
  author_id TEXT,
  author_name TEXT,
  title TEXT,
  content TEXT,
  attachments TEXT DEFAULT '[]',
  source TEXT DEFAULT 'manual',
  created_at INTEGER NOT NULL
);
`);

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Login required" });
  }
  next();
}

function requireStaff(req, res, next) {
  if (!req.session.user?.staff) {
    return res.status(403).json({ error: "Staff access only" });
  }
  next();
}

app.get("/auth/login", (req, res) => {
  const url = new URL("https://discord.com/oauth2/authorize");

  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify guilds.members.read");

  res.redirect(url.toString());
});

app.get("/auth/callback", async (req, res) => {
  try {
    const tokenResponse = await axios.post(
      "https://discord.com/api/oauth2/token",
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code: req.query.code,
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

    const memberResponse = await axios.get(
      `https://discord.com/api/users/@me/guilds/${GUILD_ID}/member`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const user = userResponse.data;
    const roles = memberResponse.data.roles || [];

    req.session.user = {
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      staff: roles.length > 0
    };

    res.redirect("/");
  } catch (error) {
    console.error("Discord login error:", error.response?.data || error.message);
    res.status(401).send("Discord login failed. Please try again.");
  }
});

app.get("/api/me", (req, res) => {
  res.json({
    user: req.session.user || null
  });
});

app.get("/api/updates", (req, res) => {
  const updates = db.prepare(`
    SELECT * FROM dashboard_updates
    WHERE guild_id=?
    ORDER BY created_at DESC
    LIMIT 100
  `).all(GUILD_ID);

  res.json(updates.map(update => ({
    ...update,
    attachments: JSON.parse(update.attachments || "[]")
  })));
});

app.post("/api/updates", requireLogin, requireStaff, (req, res) => {
  const title = String(req.body.title || "").trim().slice(0, 150);
  const content = String(req.body.content || "").trim().slice(0, 4000);

  if (!title || !content) {
    return res.status(400).json({
      error: "Title and content are required"
    });
  }

  db.prepare(`
    INSERT INTO dashboard_updates
    (guild_id, author_id, author_name, title, content, source, created_at)
    VALUES (?, ?, ?, ?, ?, 'manual', ?)
  `).run(
    GUILD_ID,
    req.session.user.id,
    req.session.user.username,
    title,
    content,
    Date.now()
  );

  res.json({ success: true });
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>One4All Dashboard</title>
<style>
*{box-sizing:border-box}
body{
margin:0;
background:#090909;
color:#f5f5f5;
font-family:Arial,sans-serif
}
header{
padding:24px;
border-bottom:1px solid #3b3014;
background:#111;
display:flex;
justify-content:space-between;
align-items:center;
flex-wrap:wrap;
gap:15px
}
.logo{
color:${GOLD};
font-size:25px;
font-weight:bold;
letter-spacing:3px
}
nav{
display:flex;
gap:10px;
flex-wrap:wrap
}
button{
background:#171717;
border:1px solid ${GOLD};
color:${GOLD};
padding:11px 17px;
border-radius:8px;
cursor:pointer;
font-weight:bold
}
button:hover{background:${GOLD};color:#000}
main{
max-width:1100px;
margin:auto;
padding:25px 16px
}
.hero{
padding:35px 25px;
border:1px solid #57451b;
border-radius:15px;
background:linear-gradient(135deg,#191919,#090909);
margin-bottom:25px
}
h1{color:${GOLD};margin-top:0}
h2{color:${GOLD}}
.muted{color:#aaa;line-height:1.6}
.section{
background:#111;
border:1px solid #302817;
border-radius:12px;
padding:22px;
margin-bottom:20px
}
.update{
padding:18px 0;
border-bottom:1px solid #302817
}
.update:last-child{border:0}
.update h3{color:${GOLD};margin:0 0 10px}
.update p{white-space:pre-wrap;line-height:1.6;color:#ddd}
.meta{color:#888;font-size:12px}
input,textarea{
width:100%;
background:#080808;
color:white;
border:1px solid #57451b;
border-radius:8px;
padding:13px;
margin:8px 0 15px
}
textarea{min-height:130px;resize:vertical}
.hidden{display:none}
a{color:${GOLD}}
footer{text-align:center;padding:25px;color:#777}
img.attachment{max-width:100%;max-height:400px;border-radius:10px;margin-top:10px}
</style>
</head>
<body>
<header>
<div class="logo">ONE4ALL • 1FA</div>
<nav>
<button onclick="showSection('home')">Home</button>
<button onclick="showSection('updates')">Server Updates</button>
<button id="loginButton" onclick="location.href='/auth/login'">Discord Login</button>
<button id="logoutButton" class="hidden" onclick="logout()">Logout</button>
</nav>
</header>
<main>
<section id="home">
<div class="hero">
<h1>ONE4ALL COMMUNITY</h1>
<p class="muted">Stronger Together. One community, one destination.</p>
<button onclick="showSection('updates')">View Server Updates</button>
</div>
<div class="section">
<h2>Welcome to One4All</h2>
<p class="muted">Your central place for community news, announcements and updates.</p>
</div>
</section>

<section id="updates" class="hidden">
<div class="section">
<h1>📢 Server Updates</h1>
<p class="muted">All official One4All announcements in one place.</p>
<div id="updatesList">Loading updates...</div>
</div>
</section>

<section id="admin" class="hidden">
<div class="section">
<h1>Publish Update</h1>
<form id="publishForm">
<label>Title</label>
<input id="title" maxlength="150" required placeholder="Update title">
<label>Announcement</label>
<textarea id="content" maxlength="4000" required placeholder="Write your announcement..."></textarea>
<button type="submit">Publish Update</button>
</form>
<p id="publishStatus" class="muted"></p>
</div>
</section>
</main>
<footer>ONE4ALL • 1FA COMMUNITY</footer>

<script>
let currentUser=null;

function showSection(section){
document.querySelectorAll("main section").forEach(s=>s.classList.add("hidden"));
document.getElementById(section).classList.remove("hidden");
if(section==="updates")loadUpdates();
}

async function loadMe(){
try{
const response=await fetch("/api/me");
const data=await response.json();
currentUser=data.user;
if(currentUser){
document.getElementById("loginButton").classList.add("hidden");
document.getElementById("logoutButton").classList.remove("hidden");
if(currentUser.staff){
const button=document.createElement("button");
button.textContent="Admin";
button.onclick=()=>showSection("admin");
document.querySelector("nav").appendChild(button);
}
}
}catch(e){console.error(e)}
}

async function loadUpdates(){
const list=document.getElementById("updatesList");
list.textContent="Loading...";
try{
const response=await fetch("/api/updates");
const updates=await response.json();
list.innerHTML="";
if(!updates.length){
list.textContent="No updates published yet.";
return;
}
updates.forEach(update=>{
const article=document.createElement("article");
article.className="update";
const title=document.createElement("h3");
title.textContent=update.title||"One4All Update";
const content=document.createElement("p");
content.textContent=update.content||"";
const meta=document.createElement("div");
meta.className="meta";
meta.textContent=(update.source==="discord"?"Discord Announcement":"Published by "+update.author_name)+" • "+new Date(update.created_at).toLocaleString();
article.append(title,content,meta);
(update.attachments||[]).forEach(file=>{
if(file.contentType?.startsWith("image/")){
const img=document.createElement("img");
img.className="attachment";
img.src=file.url;
img.alt=file.name||"Announcement image";
article.appendChild(img);
}else{
const link=document.createElement("a");
link.href=file.url;
link.target="_blank";
link.rel="noopener";
link.textContent="📎 "+(file.name||"Attachment");
article.appendChild(link);
}
});
list.appendChild(article);
});
}catch(e){list.textContent="Could not load updates."}
}

document.getElementById("publishForm").addEventListener("submit",async event=>{
event.preventDefault();
const status=document.getElementById("publishStatus");
status.textContent="Publishing...";
try{
const response=await fetch("/api/updates",{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify({
title:document.getElementById("title").value,
content:document.getElementById("content").value
})
});
const result=await response.json();
if(!response.ok)throw new Error(result.error||"Publish failed");
status.textContent="Update published successfully.";
event.target.reset();
}catch(error){status.textContent=error.message}
});

async function logout(){
await fetch("/auth/logout",{method:"POST"});
location.reload();
}

loadMe();
</script>
</body>
</html>
  `);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("One4All Dashboard running on port " + PORT);
});
