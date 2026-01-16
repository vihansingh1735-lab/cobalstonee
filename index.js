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

// ================== DATABASE ==================
let db = { guilds: {} };
if (fs.existsSync(DB_FILE)) {
  db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

function getGuild(gid) {
  if (!db.guilds[gid]) {
    db.guilds[gid] = {
      tracked: {},
      daily: { channel: null, time: "21:00", lastSent: "" }
    };
    save();
  }
  return db.guilds[gid];
}

// ================== HELPERS ==================
const todayKey = () => new Date().toISOString().slice(0, 10);
const fmt = s => `${Math.floor(s / 60)}m ${s % 60}s`;

// ================== ROBLOX ==================
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
  return j.userPresences?.[0];
}

// ================== CLIENT ==================
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ================== TRACK LOOP ==================
async function loop() {
  for (const gid in db.guilds) {
    const g = getGuild(gid);

    for (const uid in g.tracked) {
      const u = g.tracked[uid];
      const presence = await getPresence(u.robloxId);
      const now = Date.now();

      // Daily reset
      if (u.op.day !== todayKey()) {
        u.op.day = todayKey();
        u.op.today = 0;
      }

      // Join
      if (presence?.userPresenceType === 2 && u.state !== "ingame") {
        u.state = "ingame";
        u.join = now;
        save();
      }

      // Leave
      if (u.state === "ingame" && presence?.userPresenceType !== 2) {
        const played = Math.floor((now - u.join) / 1000);

        u.stats.daily += played;
        u.stats.total += played;

        // OP SYSTEM (SAFE)
        u.op.unused += played;
        const earned = Math.floor(u.op.unused / 600);
        const allowed = Math.min(earned, 50 - u.op.today);

        if (allowed > 0) {
          u.op.total += allowed;
          u.op.today += allowed;
          u.op.unused -= allowed * 600;
        }

        u.state = "offline";
        u.join = null;
        save();
      }
    }
  }
}

// ================== DAILY REPORT ==================
async function dailyReport() {
  const now = new Date();
  const hm = `${now.getHours()}:${now.getMinutes().toString().padStart(2, "0")}`;
  const today = todayKey();

  for (const gid in db.guilds) {
    const g = getGuild(gid);
    if (!g.daily.channel || g.daily.lastSent === today) continue;
    if (hm !== g.daily.time) continue;

    const lines = Object.values(g.tracked)
      .map(u => `**${u.name}** → ${u.op.today} OP`)
      .join("\n");

    const ch = await client.channels.fetch(g.daily.channel).catch(() => null);
    if (!ch) continue;

    await ch.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("📊 Daily OP Report")
          .setDescription(lines || "No activity")
          .setColor(0x2ecc71)
          .setTimestamp()
      ]
    });

    g.daily.lastSent = today;
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
    .addUserOption(o => o.setName("user").setRequired(true)),

  new SlashCommandBuilder()
    .setName("setdaily")
    .setDescription("Set daily OP report")
    .addChannelOption(o => o.setName("channel").setRequired(true))
    .addStringOption(o =>
      o.setName("time").setDescription("HH:MM 24h").setRequired(true)
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
    const user = i.options.getUser("user");
    const rbx = await getRobloxUser(i.options.getString("username"));
    if (!rbx) return i.reply("Roblox user not found");

    g.tracked[user.id] = {
      name: rbx.name,
      robloxId: rbx.id,
      state: "offline",
      join: null,
      stats: { daily: 0, total: 0 },
      op: { total: 0, today: 0, unused: 0, day: todayKey() }
    };
    save();
    return i.reply("✅ User tracked");
  }

  if (i.commandName === "remove") {
    delete g.tracked[i.options.getUser("user").id];
    save();
    return i.reply("❌ Removed");
  }

  if (i.commandName === "stats") {
    const u = g.tracked[i.options.getUser("user").id];
    if (!u) return i.reply("Not tracked");

    return i.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(u.name)
          .setDescription(
            `🪙 Total OP: **${u.op.total}**\n` +
            `📅 Today: **${u.op.today}/50**\n\n` +
            `⏱ Daily: ${fmt(u.stats.daily)}\n` +
            `🏆 Total: ${fmt(u.stats.total)}`
          )
          .setColor(0x3498db)
      ]
    });
  }

  if (i.commandName === "setdaily") {
    g.daily.channel = i.options.getChannel("channel").id;
    g.daily.time = i.options.getString("time");
    g.daily.lastSent = "";
    save();
    return i.reply("✅ Daily report configured");
  }
});

// ================== LOGIN ==================
client.login(TOKEN);
