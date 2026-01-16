// ================== KEEPALIVE ==================
const express = require("express");
const app = express();
app.get("/", (_, res) => res.send("Bot alive"));
app.listen(process.env.PORT || 3000);

// ================== IMPORTS ==================
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionsBitField,
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
const OWNER_ID = process.env.OWNER_ID;

const CHECK_INTERVAL = 30_000;
const DB_FILE = "./data.json";

// ================== HELPERS ==================
const fmt = s => `${Math.floor(s / 60)}m ${s % 60}s`;
const dayKey = () => new Date().toDateString();
const weekKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-W${Math.ceil(
    ((d - new Date(d.getFullYear(), 0, 1)) / 86400000 +
      new Date(d.getFullYear(), 0, 1).getDay() + 1) / 7
  )}`;
};
const isOwner = id => id === OWNER_ID;

// ================== DATABASE ==================
let data = { guilds: {} };
if (fs.existsSync(DB_FILE)) {
  try {
    data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    data = { guilds: {} };
  }
}
const save = () =>
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

function getGuild(guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = { tracked: {} };
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

async function getAvatar(id) {
  const r = await fetch(
    `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=420x420&format=Png`
  );
  const j = await r.json();
  return j.data?.[0]?.imageUrl;
}

// ================== CLIENT ==================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

// ================== PRESENCE LOOP ==================
async function checkUsers() {
  for (const guildId in data.guilds) {
    const guild = getGuild(guildId);

    for (const did in guild.tracked) {
      const u = guild.tracked[did];
      const presence = await getPresence(u.robloxId);
      const channel = await client.channels.fetch(u.channelId).catch(() => null);
      if (!channel) continue;

      const now = Date.now();

      // DAILY RESET
      if (u.op.day !== dayKey()) {
        u.op.day = dayKey();
        u.op.today = 0;
      }

      // ================= JOIN =================
      if (presence?.userPresenceType === 2 && u.state !== "ingame") {
  u.state = "ingame";
  u.join = Date.now();
  u.game = presence.lastLocation || "Roblox";
  save();
      }

        channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle(u.displayName)
              .setURL(`https://www.roblox.com/users/${u.robloxId}/profile`)
              .setThumbnail(await getAvatar(u.robloxId))
              .setDescription(`🟢 **Joined Game**\n🎮 ${u.game}`)
              .setTimestamp()
          ]
        });
      }

      // ================= LEAVE =================
      if (u.state === "ingame" && (!presence || presence.userPresenceType !== 2)) {
  const playedSeconds = Math.floor((Date.now() - u.join) / 1000);

  // time stats
  u.stats.daily += playedSeconds;
  u.stats.weekly += playedSeconds;
  u.stats.total += playedSeconds;

  // OP SYSTEM (CORRECT & SAFE)
  u.op.unusedSeconds += playedSeconds;
  const earned = Math.floor(u.op.unusedSeconds / 600); // 10 min = 1 OP
  const allowed = Math.min(earned, 50 - u.op.today);

  if (allowed > 0) {
    u.op.total += allowed;
    u.op.today += allowed;
    u.op.unusedSeconds -= allowed * 600;
  }

  u.state = "offline";
  u.join = null;
  u.game = null;
  save();
      }
    }
  }
}

// ================== COMMANDS ==================
const commands = [
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Track a Roblox user")
    .addUserOption(o =>
      o
        .setName("user")
        .setDescription("Discord user to track")
        .setRequired(true)
    )
    .addStringOption(o =>
      o
        .setName("username")
        .setDescription("Roblox username")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove tracked user")
    .addUserOption(o =>
      o
        .setName("user")
        .setDescription("Discord user to remove")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Show OP stats")
    .addUserOption(o =>
      o
        .setName("user")
        .setDescription("User to view stats (optional)")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("OP leaderboard"),

].map(cmd => cmd.toJSON());

// ================== REGISTER ==================
const rest = new REST({ version: "10" }).setToken(TOKEN);
(async () => {
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
})();

// ================== READY ==================
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("OP Tracker", { type: ActivityType.Watching });
  setInterval(checkUsers, CHECK_INTERVAL);
});

// ================== INTERACTIONS ==================
client.on("interactionCreate", async i => {
  if (!i.isChatInputCommand()) return;
  const guild = getGuild(i.guildId);

  if (i.commandName === "add") {
    const target = i.options.getUser("user");
    const rbx = await getRobloxUser(i.options.getString("username"));
    if (!rbx) return i.reply("User not found");

    guild.tracked[target.id] = {
      robloxId: rbx.id,
      displayName: rbx.name,
      channelId: i.channelId,
      state: "offline",
      join: null,
      game: null,
      stats: { daily: 0, weekly: 0, total: 0 },
      op: { total: 0, today: 0, day: dayKey(), unusedSeconds: 0 }
    };
    save();
    i.reply("✅ User tracked");
  }

  if (i.commandName === "stats") {
    const user = i.options.getUser("user") || i.user;
    const u = guild.tracked[user.id];
    if (!u) return i.reply("Not tracked");

    i.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(u.displayName)
          .setDescription(
            `🪙 Total OP: **${u.op.total}**\n📅 Today: **${u.op.today}/50**`
          )
      ]
    });
  }
});

// ================== LOGIN ==================
client.login(TOKEN);
