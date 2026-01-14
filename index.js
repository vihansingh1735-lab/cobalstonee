// ===================== IMPORTS =====================
const { 
  Client, 
  GatewayIntentBits, 
  SlashCommandBuilder, 
  REST, 
  Routes, 
  EmbedBuilder, 
  ActivityType 
} = require("discord.js");

const mongoose = require("mongoose");
const express = require("express");
const fetch = require("node-fetch");

// ===================== CONFIG =====================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PORT = process.env.PORT || 3000;

// ROLE allowed to use /username
const USERNAME_ROLE_ID = "1460937724142813344";

// ===================== FAKE WEB SERVER =====================
const app = express();
app.get("/", (_, res) => res.send("Bot alive"));
app.listen(PORT, () => console.log(`🌐 Web running on ${PORT}`));

// ===================== MONGODB =====================
mongoose.connect(process.env.MONGO_URI, {
  dbName: "opsbot"
}).then(() => console.log("✅ MongoDB connected"))
.catch(err => {
  console.error("❌ MongoDB failed", err);
  process.exit(1);
});

// ===================== SCHEMAS =====================
const userSchema = new mongoose.Schema({
  guildId: String,
  discordId: String,
  robloxId: Number,
  robloxUsername: String,
  op: { type: Number, default: 0 },
  todayCount: { type: Number, default: 0 },
  lastDay: String,
  joinedAt: Date
});

const settingsSchema = new mongoose.Schema({
  guildId: String,
  resultsChannel: String
});

const User = mongoose.model("User", userSchema);
const Settings = mongoose.model("Settings", settingsSchema);

// ===================== DISCORD CLIENT =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

// ===================== ROBLOX API =====================
async function getRobloxUser(username) {
  const res = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      usernames: [username],
      excludeBannedUsers: false
    })
  });
  const data = await res.json();
  return data.data?.[0] || null;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ===================== POINT SYSTEM =====================
async function givePoints() {
  const today = todayKey();
  const users = await User.find();

  for (const u of users) {
    if (u.lastDay !== today) {
      u.todayCount = 0;
      u.lastDay = today;
    }

    if (u.todayCount < 50) {
      u.op += 1;
      u.todayCount += 1;
      await u.save();
    }
  }
}

setInterval(givePoints, 10 * 60 * 1000);

// ===================== DAILY REPORT =====================
async function sendDailyResults() {
  const today = todayKey();
  const guilds = await Settings.find();

  for (const g of guilds) {
    const users = await User.find({ guildId: g.guildId });
    if (!users.length) continue;

    const desc = users
      .map(u => `**${u.robloxUsername}** → ${u.todayCount} OP`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle("📊 Daily Operations Report")
      .setDescription(desc)
      .setColor(0x2ecc71)
      .setTimestamp();

    const channel = await client.channels.fetch(g.resultsChannel).catch(() => null);
    if (channel) channel.send({ embeds: [embed] });
  }
}

setInterval(sendDailyResults, 24 * 60 * 60 * 1000);

// ===================== COMMANDS =====================
const commands = [
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Track a Roblox user")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Discord user to track")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("username")
        .setDescription("Roblox username")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove tracked user")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Discord user to remove")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Show tracked stats")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Discord user (optional)")
    ),

  new SlashCommandBuilder()
    .setName("setresults")
    .setDescription("Set daily results channel")
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("Channel for daily report")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("username")
    .setDescription("Lookup Roblox user")
    .addStringOption(o =>
      o.setName("username")
        .setDescription("Roblox username to lookup")
        .setRequired(true)
    )
].map(c => c.toJSON());

// ===================== REGISTER =====================
const rest = new REST({ version: "10" }).setToken(TOKEN);
(async () => {
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("✅ Slash commands registered");
})();

// ===================== READY =====================
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  client.user.setActivity("OP Tracker", { type: ActivityType.Watching });
});

// ===================== INTERACTIONS =====================
client.on("interactionCreate", async i => {
  if (!i.isChatInputCommand()) return;

  const guildId = i.guildId;

  if (i.commandName === "add") {
    const user = i.options.getUser("user");
    const name = i.options.getString("username");
    const rbx = await getRobloxUser(name);
    if (!rbx) return i.reply({ content: "Roblox user not found", ephemeral: true });

    await User.findOneAndUpdate(
      { guildId, discordId: user.id },
      {
        guildId,
        discordId: user.id,
        robloxId: rbx.id,
        robloxUsername: rbx.name,
        joinedAt: new Date(),
        lastDay: todayKey()
      },
      { upsert: true }
    );

    i.reply(`✅ Tracking **${rbx.name}**`);
  }

  if (i.commandName === "remove") {
    const user = i.options.getUser("user");
    await User.deleteOne({ guildId, discordId: user.id });
    i.reply("❌ Removed");
  }

  if (i.commandName === "stats") {
    const user = i.options.getUser("user") || i.user;
    const data = await User.findOne({ guildId, discordId: user.id });
    if (!data) return i.reply("No data");

    const embed = new EmbedBuilder()
      .setTitle(data.robloxUsername)
      .setURL(`https://www.roblox.com/users/${data.robloxId}/profile`)
      .setDescription(`Total OP: **${data.op}**\nToday: **${data.todayCount}/50**`)
      .setColor(0x3498db);

    i.reply({ embeds: [embed] });
  }

  if (i.commandName === "setresults") {
    const channel = i.options.getChannel("channel");
    await Settings.findOneAndUpdate(
      { guildId },
      { guildId, resultsChannel: channel.id },
      { upsert: true }
    );
    i.reply("✅ Results channel set");
  }

  if (i.commandName === "username") {
    if (!i.member.roles.cache.has(USERNAME_ROLE_ID))
      return i.reply({ content: "No permission", ephemeral: true });

    const name = i.options.getString("username");
    const rbx = await getRobloxUser(name);
    if (!rbx) return i.reply("Not found");

    const embed = new EmbedBuilder()
      .setTitle(rbx.name)
      .setURL(`https://www.roblox.com/users/${rbx.id}/profile`)
      .setDescription(`User ID: ${rbx.id}`)
      .setColor(0xf1c40f);

    i.reply({ embeds: [embed] });
  }
});

// ===================== LOGIN =====================
client.login(TOKEN);
