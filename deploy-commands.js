
const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
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
    .setDescription("Open One4All ID admin tools"),

  new SlashCommandBuilder()
    .setName("command-center")
    .setDescription("Open the One4All Command Center")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("ticket-panel")
    .setDescription("Publish the One4All ticket panel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("ticket-role")
    .setDescription("Manage ticket staff roles")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName("add")
        .setDescription("Allow a role to manage tickets")
        .addRoleOption(option =>
          option.setName("role")
            .setDescription("Role to add")
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("remove")
        .setDescription("Remove a ticket staff role")
        .addRoleOption(option =>
          option.setName("role")
            .setDescription("Role to remove")
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("list")
        .setDescription("Show all ticket staff roles")
    )
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
    console.log("Registering One4All commands...");

    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands }
    );

    console.log("Commands registered successfully!");
  } catch (error) {
    console.error(error);
  }
})();
