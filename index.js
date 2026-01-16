// ================== KEEP ALIVE ==================
const express = require("express");
const app = express();
app.get("/", (_, res) => res.send("Bot alive"));
app.listen(process.env.PORT || 3000);

// ================== IMPORTS ==================
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActivityType
} = require("discord.js");

const fs = require("fs");
const fetch = require("node-fetch");

// ================== CONFIG ==================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const CHECK_INTERVAL = 30_000;
const DB_FILE = "./data.json";

// ================== TIME (IST) ==================
const istNow = () =>
  new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

const dayKey = () => istNow().toISOString().slice(0, 10);

// ================== DATABASE ==================
let db = { guilds: {} };
if (fs.existsSync(DB_FILE)) {
  db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

const getGuild = gid => {
  if (!db.guilds[gid])
    db.guilds[gid] = {
      users: {},
      daily: { channel: null, time: null, lastSent: null }
    };
  return db.guilds[gid];
};

// ================== ROBLOX API ==================
async function getRobloxUser(username) {
  const r = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username] })
  });
  const j = await r.json();
  return j.data?.[0] || null;
}

async function getPresence(id) {
  const r = await fetch("https://presence.roblox.com/v1/presence/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userIds: [id] })
  });
  const j = await r.json();
  return j.userPresences?.[0] || null;
}

// ================== CLIENT ==================
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ================== TRACK LOOP ==================
async function loop() {
  for (const gid in db.guilds) {
    const g = getGuild(gid);

    for (const uid in g.users) {
      const u = g.users[uid];
      const presence = await getPresence(u.robloxId);
      const now = Date.now();

      // Daily reset (IST)
      if (u.op.day !== dayKey()) {
        u.op.day = dayKey();
        u.op.today = 0;
      }

      // JOIN (silent)
      if (presence?.userPresenceType === 2 && !u.join) {
        u.join = now;
      }

      // LEAVE (silent)
      if (u.join && (!presence || presence.userPresenceType !== 2)) {
        const played = Math.floor((now - u.join) / 1000);
        u.join = null;

        // OP SYSTEM (SAFE)
        u.op.unused += played;
        const earned = Math.floor(u.op.unused / 600);
        const allowed = Math.min(earned, 50 - u.op.today);

        if (allowed > 0) {
          u.op.total += allowed;
          u.op.today += allowed;
          u.op.unused -= allowed * 600;
        }

        save();
      }
    }
  }
}

// ================== DAILY REPORT ==================
async function dailyReport() {
  const now = istNow();
  const hhmm = now.toTimeString().slice(0, 5);

  for (const gid in db.guilds) {
    const g = getGuild(gid);
    if (!g.daily.channel || g.daily.time !== hhmm) continue;
    if (g.daily.lastSent === dayKey()) continue;

    const list = Object.values(g.users)
      .sort((a, b) => b.op.today - a.op.today)
      .map(u => `**${u.username}** → ${u.op.today} OP`)
      .join("\n") || "No data";

    const ch = await client.channels.fetch(g.daily.channel).catch(() => null);
    if (!ch) continue;

    ch.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("📊 Daily OP Report")
          .setDescription(list)
          .setColor(0x2ecc71)
          .setFooter({ text: "Timezone: IST" })
          .setTimestamp()
      ]
    });

    g.daily.lastSent = dayKey();
    save();
  }
}

// ================== COMMANDS ==================
const commands = [
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Track a Roblox user")
    .addUserOption(o => o.setName("user").setRequired(true))
    .addStringOption(o => o.setName("username").setRequired(true)),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove tracked user")
    .addUserOption(o => o.setName("user").setRequired(true)),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Show OP stats")
    .addUserOption(o => o.setName("user")),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("OP leaderboard"),

  new SlashCommandBuilder()
    .setName("setdaily")
    .setDescription("Set daily OP report")
    .addChannelOption(o => o.setName("channel").setRequired(true))
    .addStringOption(o =>
      o.setName("time").setDescription("HH:MM (24h IST)").setRequired(true)
    )
].map(c => c.toJSON());

// ================== REGISTER ==================
const rest = new REST({ version: "10" }).setToken(TOKEN);
(async () => {
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
})();

// ================== READY ==================
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  client.user.setActivity("OP Tracker", { type: ActivityType.Watching });

  setInterval(loop, CHECK_INTERVAL);
  setInterval(dailyReport, 60_000);
});

// ================== INTERACTIONS ==================
client.on("interactionCreate", async i => {
  if (!i.isChatInputCommand()) return;
  const g = getGuild(i.guildId);

  if (i.commandName === "add") {
    const u = i.options.getUser("user");
    const rbx = await getRobloxUser(i.options.getString("username"));
    if (!rbx) return i.reply({ content: "Roblox user not found", ephemeral: true });

    g.users[u.id] = {
      robloxId: rbx.id,
      username: rbx.name,
      join: null,
      op: { total: 0, today: 0, unused: 0, day: dayKey() }
    };
    save();
    return i.reply("✅ User tracked");
  }

  if (i.commandName === "remove") {
    delete g.users[i.options.getUser("user").id];
    save();
    return i.reply("❌ Removed");
  }

  if (i.commandName === "stats") {
    const u = i.options.getUser("user") || i.user;
    const d = g.users[u.id];
    if (!d) return i.reply("Not tracked");

    return i.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(d.username)
          .setDescription(
            `Total OP: **${d.op.total}**\nToday: **${d.op.today}/50**`
          )
          .setColor(0x3498db)
      ]
    });
  }

  if (i.commandName === "leaderboard") {
    const lb = Object.values(g.users)
      .sort((a, b) => b.op.total - a.op.total)
      .slice(0, 10)
      .map((u, i) => `**${i + 1}.** ${u.username} — ${u.op.total}`)
      .join("\n") || "No data";

    return i.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🏆 OP Leaderboard")
          .setDescription(lb)
          .setColor(0xf1c40f)
      ]
    });
  }

  if (i.commandName === "setdaily") {
    g.daily.channel = i.options.getChannel("channel").id;
    g.daily.time = i.options.getString("time");
    save();
    return i.reply("✅ Daily report configured (IST)");
  }
});

// ================== LOGIN ==================
client.login(TOKEN);
