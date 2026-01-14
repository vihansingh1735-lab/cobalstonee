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
// ================== FAKE WEB SERVER (RENDER) ==================
const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Bot is alive ✅");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});
// ================== CONFIG ==================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;

const CHECK_INTERVAL = 30_000;
const DB_FILE = "./data.json";

// ================== CLIENT ==================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

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
    data.guilds[guildId] = {
      tracked: {},
      opReportChannel: null
    };
    save();
  }
  return data.guilds[guildId];
}

// ================== HELPERS ==================
const isOwner = id => id === OWNER_ID;
const fmt = s => `${Math.floor(s / 60)}m ${s % 60}s`;
const dayKey = () => new Date().toDateString();

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

// ================== OPS RESET ==================
function resetDailyOps(u) {
  if (u.operations.lastReset !== dayKey()) {
    u.operations.today = 0;
    u.operations.lastReset = dayKey();
  }
}

// ================== PRESENCE LOOP ==================
async function checkUsers() {
  for (const guildId in data.guilds) {
    const guild = getGuild(guildId);

    for (const did in guild.tracked) {
      const u = guild.tracked[did];
      const presence = await getPresence(u.robloxId);
      const channel = await client.channels
        .fetch(u.channelId)
        .catch(() => null);
      if (!channel) continue;

      // ===== JOIN =====
      if (presence?.userPresenceType === 2 && u.state !== "ingame") {
        u.state = "ingame";
        u.join = Date.now();
        u.game = presence.lastLocation || "Roblox";
        save();

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

      // ===== LEAVE =====
      if (u.state === "ingame" && presence?.userPresenceType !== 2) {
        const played = Math.floor((Date.now() - u.join) / 1000);

        // playtime
        u.stats.total += played;

        // operations points
        resetDailyOps(u);
        const earned = Math.floor(played / 600); // 10 min
        const allowed = Math.min(earned, 50 - u.operations.today);

        if (allowed > 0) {
          u.operations.today += allowed;
          u.operations.total += allowed;
        }

        u.state = "offline";
        u.join = null;
        u.game = null;
        save();

        channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle(u.displayName)
              .setURL(`https://www.roblox.com/users/${u.robloxId}/profile`)
              .setThumbnail(await getAvatar(u.robloxId))
              .setDescription(
                `🔴 **Left Game**\n⏱ ${fmt(played)}\n🎖 +${allowed} OP`
              )
              .setTimestamp()
          ]
        });
      }
    }
  }
}

// ================== SLASH COMMANDS ==================
const commands = [
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Track a Roblox user")
    .addUserOption(o =>
      o.setName("user").setDescription("Discord user").setRequired(true)
    )
    .addStringOption(o =>
      o.setName("username").setDescription("Roblox username").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Show operations stats")
    .addUserOption(o =>
      o.setName("user").setDescription("User").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("setopchannel")
    .setDescription("Set daily OP report channel")
].map(c => c.toJSON());

// ================== REGISTER ==================
const rest = new REST({ version: "10" }).setToken(TOKEN);
(async () => {
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
})();

// ================== READY ==================
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("/add | OP System", {
    type: ActivityType.Watching
  });
  setInterval(checkUsers, CHECK_INTERVAL);
});

// ================== INTERACTIONS ==================
client.on("interactionCreate", async i => {
  if (!i.isChatInputCommand() || !i.guildId) return;

  const guild = getGuild(i.guildId);

  if (i.commandName === "add") {
    const target = i.options.getUser("user");
    const rbx = await getRobloxUser(i.options.getString("username"));
    if (!rbx) return i.reply({ content: "Roblox user not found", ephemeral: true });

    guild.tracked[target.id] = {
      robloxId: rbx.id,
      displayName: rbx.displayName || rbx.name,
      channelId: i.channelId,
      state: "offline",
      join: null,
      game: null,
      stats: { total: 0 },
      operations: {
        total: 0,
        today: 0,
        lastReset: dayKey()
      }
    };
    save();
    return i.reply({ content: "User added", ephemeral: true });
  }

  if (i.commandName === "stats") {
    const user = i.options.getUser("user") || i.user;
    const u = guild.tracked[user.id];
    if (!u) return i.reply({ content: "Not tracked", ephemeral: true });

    return i.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle(u.displayName)
          .setDescription(
            `🎖 **Operations Points**\nToday: ${u.operations.today}/50\nTotal: ${u.operations.total}`
          )
      ]
    });
  }

  if (i.commandName === "setopchannel") {
    if (
      !isOwner(i.user.id) &&
      !i.member.permissions.has(PermissionsBitField.Flags.Administrator)
    )
      return i.reply({ content: "No permission", ephemeral: true });

    guild.opReportChannel = i.channelId;
    save();
    return i.reply({ content: "OP report channel set", ephemeral: true });
  }
});

// ================== LOGIN ==================
client.login(TOKEN);
