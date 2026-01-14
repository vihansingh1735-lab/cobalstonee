// ================= KEEPALIVE (RENDER) =================
const express = require("express");
const app = express();
app.get("/", (_, res) => res.send("Bot alive"));
app.listen(process.env.PORT || 3000);

// ================= IMPORTS =================
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

// ================= CONFIG =================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const USERNAME_LOOKUP_ROLE_ID = "1460937724142813344";

const CHECK_INTERVAL = 30_000;
const OP_INTERVAL = 600; // 10 min
const DAILY_OP_CAP = 50;
const DB_FILE = "./data.json";

// ================= DATABASE =================
let data = { guilds: {} };
if (fs.existsSync(DB_FILE)) {
  data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

function getGuild(guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      tracked: {},
      resultsChannel: null
    };
  }
  return data.guilds[guildId];
}

const todayKey = () => new Date().toDateString();

// ================= ROBLOX API =================
async function getRobloxUser(username) {
  const r = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username] })
  });
  const j = await r.json();
  return j.data?.[0];
}

async function getRobloxInfo(id) {
  return fetch(`https://users.roblox.com/v1/users/${id}`).then(r => r.json());
}

async function getAvatar(id) {
  const r = await fetch(
    `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=420x420&format=Png`
  );
  const j = await r.json();
  return j.data?.[0]?.imageUrl;
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

// ================= CLIENT =================
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ================= TRACK LOOP =================
async function checkUsers() {
  for (const gid in data.guilds) {
    const guild = data.guilds[gid];

    for (const did in guild.tracked) {
      const u = guild.tracked[did];
      const presence = await getPresence(u.robloxId);
      const now = Date.now();

      if (u.day !== todayKey()) {
        u.day = todayKey();
        u.dailyOP = 0;
        u.playedToday = 0;
      }

      // JOIN
      if (presence?.userPresenceType === 2 && !u.joinedAt) {
        u.joinedAt = now;
      }

      // LEAVE
      if (u.joinedAt && presence?.userPresenceType !== 2) {
        const played = Math.floor((now - u.joinedAt) / 1000);
        u.playedToday += played;

        const earned = Math.min(
          Math.floor(played / OP_INTERVAL),
          DAILY_OP_CAP - u.dailyOP
        );

        if (earned > 0) u.dailyOP += earned;

        u.joinedAt = null;
        save();
      }
    }
  }
}

// ================= DAILY RESULTS =================
async function sendDailyResults() {
  for (const gid in data.guilds) {
    const guild = data.guilds[gid];
    if (!guild.resultsChannel) continue;

    const channel = await client.channels.fetch(guild.resultsChannel).catch(() => null);
    if (!channel) continue;

    const list = Object.entries(guild.tracked)
      .sort((a, b) => b[1].dailyOP - a[1].dailyOP)
      .filter(([, u]) => u.dailyOP > 0);

    if (!list.length) continue;

    const desc = list
      .map(([id, u], i) => `**${i + 1}.** <@${id}> — 🪙 ${u.dailyOP}`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle("📊 Daily Operations Report")
      .setDescription(desc)
      .setColor(0x2ecc71)
      .setTimestamp();

    channel.send({ embeds: [embed] });
  }
}

// ================= COMMANDS =================
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
    .setDescription("Show stats")
    .addUserOption(o => o.setName("user")),

  new SlashCommandBuilder()
    .setName("setresults")
    .setDescription("Set daily results channel")
    .addChannelOption(o => o.setName("channel").setRequired(true)),

  new SlashCommandBuilder()
    .setName("username")
    .setDescription("Lookup Roblox user")
    .addStringOption(o => o.setName("username").setRequired(true))
].map(c => c.toJSON());

// ================= REGISTER =================
const rest = new REST({ version: "10" }).setToken(TOKEN);
(async () => {
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
})();

// ================= READY =================
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("/add | OP Tracker", { type: ActivityType.Watching });
  setInterval(checkUsers, CHECK_INTERVAL);
  setInterval(sendDailyResults, 24 * 60 * 60 * 1000);
});

// ================= INTERACTIONS =================
client.on("interactionCreate", async i => {
  if (!i.isChatInputCommand()) return;
  const guild = getGuild(i.guildId);

  if (i.commandName === "add") {
    const target = i.options.getUser("user");
    const rbx = await getRobloxUser(i.options.getString("username"));
    if (!rbx) return i.reply({ content: "User not found", ephemeral: true });

    guild.tracked[target.id] = {
      robloxId: rbx.id,
      dailyOP: 0,
      playedToday: 0,
      joinedAt: null,
      day: todayKey()
    };
    save();
    return i.reply("✅ User added");
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

    return i.reply(
      `🕒 Played today: ${Math.floor(u.playedToday / 60)}m\n🪙 OP today: ${u.dailyOP}`
    );
  }

  if (i.commandName === "setresults") {
    guild.resultsChannel = i.options.getChannel("channel").id;
    save();
    return i.reply("📢 Results channel set");
  }

  if (i.commandName === "username") {
    if (!i.member.roles.cache.has(USERNAME_LOOKUP_ROLE_ID)) {
      return i.reply({ content: "No permission", ephemeral: true });
    }

    const rbx = await getRobloxUser(i.options.getString("username"));
    if (!rbx) return i.reply("User not found");

    const info = await getRobloxInfo(rbx.id);
    const avatar = await getAvatar(rbx.id);
    const created = new Date(info.created).toDateString();
    const age = Math.floor((Date.now() - new Date(info.created)) / 86400000);

    const embed = new EmbedBuilder()
      .setTitle(info.name)
      .setURL(`https://www.roblox.com/users/${info.id}/profile`)
      .setThumbnail(avatar)
      .setDescription(info.description || "No description")
      .addFields(
        { name: "User ID", value: info.id.toString(), inline: true },
        { name: "Created", value: created, inline: true },
        { name: "Account Age", value: `${age} days`, inline: true }
      )
      .setColor(0x3498db);

    return i.reply({ embeds: [embed] });
  }
});

// ================= LOGIN =================
client.login(TOKEN);
