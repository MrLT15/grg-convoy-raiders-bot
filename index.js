const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require("discord.js");

const fetch = require("node-fetch");
const { Pool } = require("pg");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const DATABASE_URL = process.env.DATABASE_URL;

const GENERAL_CHAT_CHANNEL_ID = "872930746451513436";
const VERIFIED_WALLET_ROLE_ID = "1498390601199255794";

const WAX_HISTORY_API = "https://api.waxsweden.org";
const CONVOY_CONTRACTS = ["niftykickgam"];
const CONVOY_ACTIONS = ["sendconvoy"];

const RAID_WINDOW_SECONDS = 20;
const RAID_SUCCESS_CHANCE = 0.35;

let activeConvoy = null;
let seenConvoyActionIds = new Set();
let convoyTrackerInitialized = false;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getActionId(action) {
  return (
    action.global_sequence ||
    action.account_action_seq ||
    action.trx_id ||
    `${action.block_num}-${action.action_ordinal}`
  );
}

function getActionDataValue(action, keys) {
  const data = action.act?.data || {};
  for (const key of keys) {
    if (data[key] !== undefined && data[key] !== null) return data[key];
  }
  return null;
}

function rollNkfeReward() {
  const roll = Math.random();

  if (roll < 0.60) return 1;
  if (roll < 0.85) return 2;
  if (roll < 0.95) return 3;
  if (roll < 0.99) return 4;
  return 5;
}

async function initDatabase() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is missing.");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS verified_wallets (
      discord_id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS raid_balances (
      discord_id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      nkfe_earned INTEGER NOT NULL DEFAULT 0,
      total_successes INTEGER NOT NULL DEFAULT 0,
      total_attempts INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS raid_logs (
      id SERIAL PRIMARY KEY,
      discord_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      convoy_id TEXT,
      route TEXT,
      success BOOLEAN NOT NULL,
      reward INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function getVerifiedWallet(discordId) {
  const result = await pool.query(
    "SELECT wallet FROM verified_wallets WHERE discord_id = $1",
    [discordId]
  );

  return result.rows[0]?.wallet || null;
}

async function recordRaid(discordId, wallet, convoyId, route, success, reward) {
  await pool.query(
    `
    INSERT INTO raid_logs (discord_id, wallet, convoy_id, route, success, reward)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [discordId, wallet, convoyId, route, success, reward]
  );

  await pool.query(
    `
    INSERT INTO raid_balances (discord_id, wallet, nkfe_earned, total_successes, total_attempts, updated_at)
    VALUES ($1, $2, $3, $4, 1, NOW())
    ON CONFLICT (discord_id)
    DO UPDATE SET
      wallet = EXCLUDED.wallet,
      nkfe_earned = raid_balances.nkfe_earned + EXCLUDED.nkfe_earned,
      total_successes = raid_balances.total_successes + EXCLUDED.total_successes,
      total_attempts = raid_balances.total_attempts + 1,
      updated_at = NOW()
    `,
    [discordId, wallet, reward, success ? 1 : 0]
  );
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("raid")
      .setDescription("Attempt to raid the active NiftyKicks convoy.")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("balance")
      .setDescription("Check your Convoy Raiders NKFE balance.")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("raidleaderboard")
      .setDescription("Show the top Convoy Raiders.")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("adminpayouts")
      .setDescription("Show NKFE payouts owed to raiders.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("resetpayouts")
      .setDescription("Reset all Convoy Raiders payout balances after manual payment.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON()
  ];

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("Convoy Raiders slash commands registered.");
}

async function fetchRecentConvoyActions() {
  const foundActions = [];

  for (const contract of CONVOY_CONTRACTS) {
    const url =
      `${WAX_HISTORY_API}/v2/history/get_actions` +
      `?account=${contract}` +
      `&sort=desc` +
      `&limit=10`;

    try {
      const response = await fetch(url);
      const json = await response.json();
      const actions = json.actions || [];

      for (const action of actions) {
        const actionName = action.act?.name || action.name || action.action;

        if (CONVOY_ACTIONS.includes(actionName)) {
          foundActions.push({ contract, actionName, action });
        }
      }
    } catch (error) {
      console.log(`Failed to fetch convoy actions for ${contract}:`, error.message);
    }
  }

  return foundActions;
}

async function openRaidWindow(action) {
  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = guild.channels.cache.get(GENERAL_CHAT_CHANNEL_ID);

  if (!channel) return;

  const route =
    getActionDataValue(action, ["route", "route_id", "routeid", "mission", "mission_id", "missionid"]) || "Unknown";

  const convoyId =
    getActionDataValue(action, ["convoy_id", "convoyid", "convoy", "id"]) || "Unknown";

  activeConvoy = {
    id: String(convoyId),
    route: String(route),
    startedAt: Date.now(),
    expiresAt: Date.now() + RAID_WINDOW_SECONDS * 1000,
    attemptedDiscordIds: new Set()
  };

  await channel.send(
    "⚠️ **Convoy Raiders Alert!** ⚠️\n\n" +
    `A convoy is vulnerable for **${RAID_WINDOW_SECONDS} seconds**.\n\n` +
    `Route / Mission: **${route}**\n` +
    `Convoy ID: **${convoyId}**\n\n` +
    "Verified wallets can run:\n" +
    "`/raid`\n\n" +
    "Successful raiders can earn **1–5 $NKFE**."
  );

  setTimeout(() => {
    if (activeConvoy && activeConvoy.id === String(convoyId)) {
      activeConvoy = null;
    }
  }, RAID_WINDOW_SECONDS * 1000);
}

async function checkConvoyActivity() {
  try {
    const recentActions = await fetchRecentConvoyActions();
    recentActions.reverse();

    for (const item of recentActions) {
      const actionId = getActionId(item.action);
      if (!actionId) continue;

      if (!convoyTrackerInitialized) {
        seenConvoyActionIds.add(actionId);
        continue;
      }

      if (seenConvoyActionIds.has(actionId)) continue;

      seenConvoyActionIds.add(actionId);

      await openRaidWindow(item.action);
      await sleep(1000);
    }

    convoyTrackerInitialized = true;

    if (seenConvoyActionIds.size > 500) {
      seenConvoyActionIds = new Set([...seenConvoyActionIds].slice(-250));
    }
  } catch (error) {
    console.error("Convoy tracker error:", error);
  }
}

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await initDatabase();
  console.log("Database initialized.");

  await registerCommands();

  setInterval(async () => {
    await checkConvoyActivity();
  }, 5000);

  console.log("Convoy Raiders tracker started. Checking every 5 seconds.");
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await interaction.deferReply({ flags: 64 });
  } catch {
    return;
  }

  try {
    if (interaction.commandName === "raid") {
      const member = await interaction.guild.members.fetch(interaction.user.id);

      if (!member.roles.cache.has(VERIFIED_WALLET_ROLE_ID)) {
        await interaction.editReply(
          "You must verify your wallet before raiding. Run `/verify wallet.wam` with the GetRight Games Verification Bot first."
        );
        return;
      }

      const wallet = await getVerifiedWallet(interaction.user.id);

      if (!wallet) {
        await interaction.editReply(
          "Your Discord has the verified role, but no wallet was found in the database. Please run `/verify wallet.wam` again once."
        );
        return;
      }

      if (!activeConvoy || Date.now() > activeConvoy.expiresAt) {
        await interaction.editReply(
          "No active convoy raid window right now. Watch for the next convoy dispatch."
        );
        return;
      }

      if (activeConvoy.attemptedDiscordIds.has(interaction.user.id)) {
        await interaction.editReply(
          "You already attempted to raid this convoy. Wait for the next one."
        );
        return;
      }

      activeConvoy.attemptedDiscordIds.add(interaction.user.id);

      const success = Math.random() < RAID_SUCCESS_CHANCE;
      const reward = success ? rollNkfeReward() : 0;

      await recordRaid(
        interaction.user.id,
        wallet,
        activeConvoy.id,
        activeConvoy.route,
        success,
        reward
      );

      if (success) {
        await interaction.editReply(
          "⚔️ **Raid Successful!**\n\n" +
          `Wallet: **${wallet}**\n` +
          `Convoy ID: **${activeConvoy.id}**\n\n` +
          `You intercepted the convoy and earned **${reward} $NKFE**.`
        );
      } else {
        await interaction.editReply(
          "🛡 **Raid Failed!**\n\n" +
          `Wallet: **${wallet}**\n` +
          `Convoy ID: **${activeConvoy.id}**\n\n` +
          "The convoy escort pushed you back. Better luck next time."
        );
      }

      return;
    }

    if (interaction.commandName === "balance") {
      const wallet = await getVerifiedWallet(interaction.user.id);

      if (!wallet) {
        await interaction.editReply(
          "No verified wallet found. Run `/verify wallet.wam` with the GetRight Games Verification Bot first."
        );
        return;
      }

      const result = await pool.query(
        "SELECT nkfe_earned, total_successes, total_attempts FROM raid_balances WHERE discord_id = $1",
        [interaction.user.id]
      );

      const row = result.rows[0];

      if (!row) {
        await interaction.editReply(
          `🚚 **Convoy Raiders Balance**\n\nWallet: **${wallet}**\nNKFE Earned: **0**\nRaid Attempts: **0**`
        );
        return;
      }

      await interaction.editReply(
        `🚚 **Convoy Raiders Balance**\n\n` +
        `Wallet: **${wallet}**\n` +
        `NKFE Earned: **${row.nkfe_earned}**\n` +
        `Successful Raids: **${row.total_successes}**\n` +
        `Total Attempts: **${row.total_attempts}**`
      );

      return;
    }

    if (interaction.commandName === "raidleaderboard") {
      const result = await pool.query(
        `
        SELECT discord_id, wallet, nkfe_earned, total_successes, total_attempts
        FROM raid_balances
        ORDER BY nkfe_earned DESC, total_successes DESC
        LIMIT 10
        `
      );

      if (!result.rows.length) {
        await interaction.editReply("No raid leaderboard data yet.");
        return;
      }

      const lines = result.rows.map((row, index) =>
        `${index + 1}. <@${row.discord_id}> — **${row.nkfe_earned} NKFE** | ${row.total_successes}/${row.total_attempts} successful`
      );

      await interaction.editReply(
        "🏆 **Convoy Raiders Leaderboard**\n\n" +
        lines.join("\n")
      );

      return;
    }

    if (interaction.commandName === "adminpayouts") {
      const result = await pool.query(
        `
        SELECT discord_id, wallet, nkfe_earned
        FROM raid_balances
        WHERE nkfe_earned > 0
        ORDER BY nkfe_earned DESC
        `
      );

      if (!result.rows.length) {
        await interaction.editReply("No NKFE payouts owed right now.");
        return;
      }

      const lines = result.rows.map(row =>
        `${row.wallet} — ${row.nkfe_earned} NKFE — <@${row.discord_id}>`
      );

      await interaction.editReply(
        "💰 **Convoy Raiders Manual Payout List**\n\n" +
        lines.join("\n") +
        "\n\nAfter paying from the treasury wallet, run `/resetpayouts`."
      );

      return;
    }

    if (interaction.commandName === "resetpayouts") {
      await pool.query(`
        UPDATE raid_balances
        SET nkfe_earned = 0,
            updated_at = NOW()
      `);

      await interaction.editReply("Convoy Raiders payout balances have been reset to 0.");

      return;
    }
  } catch (error) {
    console.error(error);

    try {
      await interaction.editReply("Something went wrong while processing this command.");
    } catch {
      console.log("Could not send error reply.");
    }
  }
});

client.login(TOKEN);
