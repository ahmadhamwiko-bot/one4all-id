
const {
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("id")
    .setDescription("View a member's One4All digital ID")
    .addUserOption(option =>
      option.setName("member")
        .setDescription("Choose a member")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("View your level and XP"),

  new SlashCommandBuilder()
    .setName("reputation")
    .setDescription("View reputation points")
    .addUserOption(option =>
      option.setName("member")
        .setDescription("Choose a member")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("reputation-add")
    .setDescription("Add reputation points to a member")
    .addUserOption(option =>
      option.setName("member")
        .setDescription("Choose a member")
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName("points")
        .setDescription("Number of points")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    ),

  new SlashCommandBuilder()
    .setName("achievements")
    .setDescription("View your achievements"),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("View the top members"),

  new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Claim your daily XP reward"),

  new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Open One4All ID admin tools")
].map(command => command.toJSON());

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token || !clientId) {
  console.error("Missing DISCORD_TOKEN or DISCORD_CLIENT_ID");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    console.log("Registering One4All ID commands...");

    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands }
    );

    console.log("Commands registered successfully!");
  } catch (error) {
    console.error(error);
  }
})();
