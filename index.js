// ================== KEEPALIVE (RENDER SAFE) ==================
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
  ActivityType,
  PermissionsBitField
} = require("discord.js");
const fs = require("fs");
const fetch = require("node-fetch");

// ================== CONFIG ==================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;

const CHECK_INTERVAL = 30_000; // 30 sec
const DB_FILE = "./data.json";

// ================== TIME (IST) ==================
function istNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
}

function dayKeyIST() {
  return istNow().toISOString().slice(0, 10);
}

// ================== DATABASE ==================
let data = { guilds: {} };

if (fs.existsSync(DB_FILE)) {
  try {
    data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    data = { guilds: {} };
  }
}

function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function getGuild(guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      tracked: {},
      dailyReport: {
        channelId: null,
        time: "13:10" // default 1:10 PM IST
      }
    };
    save();
  }
  return data.guilds[guildId];
}

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

// ================== OP LOGIC ==================
function rewardOP(u) {
  const today = dayKeyIST();

  if (u.lastDay !== today) {
    u.todayOP = 0;
    u.opGivenMinutes = 0;
    u.lastDay = today;
  }

  const totalMinutes = Math.floor(u.playSeconds / 60);
  const shouldHave = Math.floor(totalMinutes / 10);
  const alreadyGiven = Math.floor(u.opGivenMinutes / 10);

  let toGive = shouldHave - alreadyGiven;
  if (toGive <= 0) return;

  const allowed = Math.min(toGive, 50 - u.todayOP);
  if (allowed <= 0) return;

  u.op += allowed;
  u.todayOP += allowed;
  u.opGivenMinutes += allowed * 10;
}

// ================== PRESENCE LOOP ==================
async function checkUsers() {
  for (const guildId in data.guilds) {
    const guild = getGuild(guildId);

    for (const did in guild.tracked) {
      const u = guild.tracked[did];
      const presence = await getPresence(u.robloxId);

      // SILENT playtime tracking
      if (presence?.userPresenceType === 2) {
        if (!u.lastSeen) u.lastSeen = Date.now();
        const diff = Math.floor((Date.now() - u.lastSeen) / 1000);
        u.playSeconds += diff;
        u.lastSeen = Date.now();
      } else {
        u.lastSeen = null;
      }

      rewardOP(u);
    }
  }
  save();
}

// ================== DAILY REPORT ==================
async function sendDailyReports() {
  const now = istNow();
  const time = now.toTimeString().slice(0, 5);

  for (const guildId in data.guilds) {
    const g = getGuild(guildId);
    if (!g.dailyReport.channelId) continue;
    if (g.dailyReport.time !== time) continue;

    const channel = await client.channels
      .fetch(g.dailyReport.channelId)
      .catch(() => null);
    if (!channel) continue;

    const list = Object.values(g.tracked)
      .sort((a, b) => b.todayOP - a.todayOP)
      .map(u => `**${u.displayName}** → ${u.todayOP} OP`)
      .join("\n") || "No activity today.";

    const embed = new EmbedBuilder()
      .setTitle("📊 Daily Operations Report (IST)")
      .setDescription(list)
      .setColor(0x2ecc71)
      .setTimestamp();

    channel.send({ embeds: [embed] });
  }
}

// ================== SLASH COMMANDS ==================
const commands = [
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Track a Roblox user")
    .addUserOption(o =>
      o.setName("user").setDescription("Discord user").setRequired(true))
    .addStringOption(o =>
      o.setName("username").setDescription("Roblox username").setRequired(true)),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove tracked user")
    .addUserOption(o =>
      o.setName("user").setDescription("Discord user").setRequired(true)),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Show OP stats")
    .addUserOption(o =>
      o.setName("user").setDescription("Target user")),

  new SlashCommandBuilder()
    .setName("opleaderboard")
    .setDescription("Daily OP leaderboard"),

  new SlashCommandBuilder()
    .setName("setdaily")
    .setDescription("Set daily OP report")
    .addChannelOption(o =>
      o.setName("channel").setDescription("Report channel").setRequired(true))
    .addStringOption(o =>
      o.setName("time")
        .setDescription("Time in IST (HH:MM, 24h)")
        .setRequired(true))
].map(c => c.toJSON());

// ================== REGISTER ==================
const rest = new REST({ version: "10" }).setToken(TOKEN);
(async () => {
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
})();

// ================== READY ==================
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  const updateStatus = () => {
    client.user.setActivity(`/add | ${client.guilds.cache.size} Servers`, {
      type: ActivityType.Watching
    });
  };

  updateStatus();
  setInterval(updateStatus, 60_000);

  setInterval(checkUsers, CHECK_INTERVAL);
  setInterval(sendDailyReports, 60_000);
});

// ================== INTERACTIONS ==================
client.on("interactionCreate", async i => {
  if (!i.isChatInputCommand()) return;
  if (!i.guildId) return;

  const guild = getGuild(i.guildId);

  if (i.commandName === "add") {
    const user = i.options.getUser("user");
    const name = i.options.getString("username");
    const rbx = await getRobloxUser(name);
    if (!rbx) return i.reply({ content: "Roblox user not found", ephemeral: true });

    guild.tracked[user.id] = {
      robloxId: rbx.id,
      displayName: rbx.name,
      playSeconds: 0,
      lastSeen: null,
      op: 0,
      todayOP: 0,
      opGivenMinutes: 0,
      lastDay: dayKeyIST()
    };
    save();
    return i.reply("✅ User tracked");
  }

  if (i.commandName === "remove") {
    delete guild.tracked[i.options.getUser("user").id];
    save();
    return i.reply("❌ User removed");
  }

  if (i.commandName === "stats") {
    const user = i.options.getUser("user") || i.user;
    const u = guild.tracked[user.id];
    if (!u) return i.reply("Not tracked");

    return i.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(u.displayName)
          .setDescription(
            `Total OP: **${u.op}**\nToday: **${u.todayOP}/50**`
          )
          .setColor(0x3498db)
      ]
    });
  }

  if (i.commandName === "opleaderboard") {
    const list = Object.values(guild.tracked)
      .sort((a, b) => b.todayOP - a.todayOP)
      .slice(0, 10)
      .map((u, i) => `**${i + 1}.** ${u.displayName} — ${u.todayOP} OP`)
      .join("\n") || "No data";

    return i.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🏆 OP Leaderboard (Today)")
          .setDescription(list)
          .setColor(0xf1c40f)
      ]
    });
  }

  if (i.commandName === "setdaily") {
    if (!i.member.permissions.has(PermissionsBitField.Flags.Administrator))
      return i.reply({ content: "Admin only", ephemeral: true });

    guild.dailyReport.channelId = i.options.getChannel("channel").id;
    guild.dailyReport.time = i.options.getString("time");
    save();

    return i.reply(`✅ Daily report set at **${guild.dailyReport.time} IST**`);
  }
});

// ================== LOGIN ==================
client.login(TOKEN);
