// Dependencies: npm install node-fetch axios p-limit lru-cache dotenv discord-webhook-node
import 'dotenv/config';
import fetch from 'node-fetch';
import axios from 'axios';
import fs from 'fs';
import { LRUCache } from 'lru-cache';
import pLimit from 'p-limit';
import { Webhook, MessageBuilder } from 'discord-webhook-node';

// CONFIGS
const MORALIS_KEYS = JSON.parse(process.env.MORALIS_KEYS);
const MID_TIER_WEBHOOK = process.env.MID_TIER_WEBHOOK;
const HIGH_TIER_WEBHOOK = process.env.HIGH_TIER_WEBHOOK;

const MID_TIER_WEBHOOK_CLIENT = new Webhook(MID_TIER_WEBHOOK);
const HIGH_TIER_WEBHOOK_CLIENT = new Webhook(HIGH_TIER_WEBHOOK);

const hoursPerBlock = 6;
const keysPerDay = MORALIS_KEYS.slice();
const dailyKeyOrder = shuffleArray(keysPerDay);
const startOfDay = new Date().setHours(0, 0, 0, 0);

function getCurrentMoralisKey() {
  const now = Date.now();
  const hoursSinceMidnight = Math.floor((now - startOfDay) / 3600000);
  const index = Math.floor(hoursSinceMidnight / hoursPerBlock) % dailyKeyOrder.length;
  return dailyKeyOrder[index];
}

function shuffleArray(arr) {
  return arr
    .map((val) => ({ val, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ val }) => val);
}

const LOG_FILE = 'tokens.log';
const trackedMidTier = new LRUCache({ max: 1000, ttl: 1000 * 60 * 120 }); // 2 hr tracking for mid
const trackedHighTier = new LRUCache({ max: 1000, ttl: 1000 * 60 * 120 }); // 2 hr tracking for high
const limit = pLimit(5);
let pollInterval = 30000;

function log(message) {
  const logMsg = `[${new Date().toISOString()}] ${message}`;
  console.log(logMsg);
  fs.appendFileSync(LOG_FILE, logMsg + '\n');
}

async function fetchNewMoralisTokens() {
  try {
    const res = await fetch(
      'https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/new?limit=100',
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'X-API-Key': getCurrentMoralisKey(),
        },
      }
    );
    const data = await res.json();
    return data?.result || [];
  } catch (err) {
    log(`❌ Moralis Fetch Error: ${err.message}`);
    return [];
  }
}

async function fetchDexscreenerDetails(tokenAddress) {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/solana/${tokenAddress}`);
    return data?.[0] || null;
  } catch (err) {
    log(`❌ Dexscreener Error for ${tokenAddress}: ${err.message}`);
    return null;
  }
}

async function sendToDiscord(token, webhookClient, icon = '') {
  const {
    baseToken, marketCap, priceUsd, volume, txns, priceChange, url, pairAddress
  } = token;

  const embed = new MessageBuilder()
    .setTitle(`🚀 ${baseToken.name} ($${baseToken.symbol})`)
    .setURL(url)
    .setThumbnail(icon)
    .addField('💰 Market Cap', `$${(marketCap ?? 0).toLocaleString()}`, true)
    .addField('💸 Price', `$${priceUsd}`, true)
    .addField('📊 Volume (1h)', `${volume?.h1 ?? 0} SOL`, true)
    .addField('🛒 Buys (5m)', `${txns?.m5?.buys ?? 0}`, true)
    .addField('📈 Change (5m)', `${priceChange?.m5 ?? 0}%`, true)
    .addField('🔗 Photon', `[View on Photon](https://photon-sol.tinyastro.io/en/lp/${pairAddress})`, true)
    .addField('📜 Contract', `\`${baseToken.address}\``, false)
    .setColor('#00ffcc')
    .setFooter(`🚨 PumpFun Alert • ${new Date().toLocaleTimeString()}`)
    .setTimestamp();

  try {
    await webhookClient.send(embed);
    log(`✅ Sent ${baseToken.symbol} to Discord (${webhookClient.url.includes('mid') ? 'Mid' : 'High'})`);
  } catch (err) {
    log(`❌ Discord Error: ${err.message}`);
  }
}

function getTokenAgeMinutes(createdAt) {
  return (Date.now() - new Date(createdAt).getTime()) / 60000;
}

async function checkTokens() {
  log(`🚀 [ROUND STARTED]`);

  const tokens = await fetchNewMoralisTokens();
  let goodCount = 0;

  await Promise.all(
    tokens.map((token) =>
      limit(async () => {
        const ca = token.tokenAddress;
        const fdv = Number(token.fullyDilutedValuation);
        const age = getTokenAgeMinutes(token.createdAt);

        if (fdv < 16900) return log(`⏩ Skipping ${ca} — FDV: $${fdv} < 16900`);
        if (age > 20) return log(`⏩ Skipping ${ca} — Age: ${age.toFixed(2)} mins > 20`);

        const details = await fetchDexscreenerDetails(ca);
        if (!details) return log(`❌ Skipped ${ca} — No DexScreener details`);

        const mcap = details.marketCap ?? 0;
        const tokenCreatedAt = details.pairCreatedAt ?? token.createdAt;
        const ageMinutes = getTokenAgeMinutes(tokenCreatedAt);

        log(`🔍 Evaluating ${ca} — mcap: $${mcap}, age: ${ageMinutes.toFixed(1)} mins`);

        const shouldSendMid = mcap >= 16900 && mcap < 80000 && ageMinutes <= 20;
        const shouldSendHigh = mcap >= 80000 && ageMinutes <= 120;

        if (shouldSendMid && !trackedMidTier.has(ca)) {
          await sendToDiscord(details, MID_TIER_WEBHOOK_CLIENT);
          trackedMidTier.set(ca, Date.now());
          goodCount++;
        }

        if (shouldSendHigh && !trackedHighTier.has(ca)) {
          await sendToDiscord(details, HIGH_TIER_WEBHOOK_CLIENT);
          trackedHighTier.set(ca, Date.now());
          goodCount++;
        }
      })
    )
  );

  pollInterval = goodCount >= 2 ? 15000 : 30000;

  log(`✅ [ROUND ENDED] Checked ${tokens.length} tokens | Sent ${goodCount} tokens | Next poll: ${pollInterval / 1000}s`);
}

function scheduleNextPoll() {
  setTimeout(async () => {
    await checkTokens();
    await checkOtherDexTokens();
    await recheckForHighTier();
    scheduleNextPoll();
  }, pollInterval);
}

// ========== NON-PUMP TOKENS CHECKER ==========

const PUMP_DEXES = new Set(["pumpfun", "pumpswap"]);

async function fetchLatestTokenProfiles() {
  try {
    const response = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
    return response.data || [];
  } catch (error) {
    log("❌ Token profile fetch error: " + error.message);
    return [];
  }
}

async function fetchTokenPairs(tokenAddress) {
  try {
    const response = await axios.get(`https://api.dexscreener.com/token-pairs/v1/solana/${tokenAddress}`);
    return response.data || [];
  } catch (error) {
    log(`❌ Pair fetch error for ${tokenAddress}: ` + error.message);
    return [];
  }
}

async function sendToDiscordAlt(pair) {
  const {
    baseToken, dexId, priceUsd, txns, url, volume, priceChange, pairAddress
  } = pair;

  const embed = new MessageBuilder()
    .setTitle(`${baseToken.symbol} listed on ${dexId.toUpperCase()}`)
    .setURL(url)
    .setDescription(`**${baseToken.name}** (${baseToken.symbol})\n\n💵 Price: **$${parseFloat(priceUsd).toFixed(6)}**`)
    .addField('🛒 Buys (5m)', `${txns?.m5?.buys || 0}`, true)
    .addField('🧯 Sells (5m)', `${txns?.m5?.sells || 0}`, true)
    .addField('📊 Volume (5m)', `$${Math.round(volume?.m5 || 0)}`, true)
    .addField('📉 Price Change (5m)', `${priceChange?.m5 || 0}%`, true)
    .addField('🔗 Photon', `[View on Photon](https://photon-sol.tinyastro.io/en/lp/${pairAddress})`, true)
    .addField('📜 Contract', `\`${baseToken.address}\``, false)
    .setColor('#00b0f4')
    .setTimestamp();

  try {
    await MID_TIER_WEBHOOK_CLIENT.send(embed);
    log(`✅ Non-pump token sent: ${baseToken.symbol} on ${dexId}`);
  } catch (e) {
    log("❌ Webhook error (non-pump): " + e.message);
  }
}

async function checkOtherDexTokens() {
  const profiles = await fetchLatestTokenProfiles();

  await Promise.all(
    profiles.map((profile) =>
      limit(async () => {
        const tokenAddress = profile.tokenAddress;
        if (trackedMidTier.has(tokenAddress) || trackedHighTier.has(tokenAddress)) return;

        const pairs = await fetchTokenPairs(tokenAddress);

        for (const pair of pairs) {
          const { dexId, txns, volume, fdv, pairCreatedAt } = pair;

          if (PUMP_DEXES.has(dexId)) continue;

          const ageMinutes = (Date.now() - new Date(pairCreatedAt).getTime()) / 60000;
          const buys5m = txns?.m5?.buys ?? 0;
          const volume5m = volume?.m5 ?? 0;
          const fdvValue = Number(fdv) || 0;

          if (fdvValue >= 16900 && buys5m >= 5 && volume5m >= 500 && ageMinutes <= 20) {
            await sendToDiscordAlt(pair);
            trackedMidTier.set(tokenAddress, Date.now());
            break; // only send one good non-pump pair
          } else {
            log(`⏩ Skipped non-pump ${tokenAddress} — FDV: $${fdvValue}, Buys: ${buys5m}, Volume: $${volume5m}, Age: ${ageMinutes.toFixed(1)} mins`);
          }
        }
      })
    )
  );
}

// ========== RECHECK FOR HIGH TIER BREAKOUT ==========

async function recheckForHighTier() {
  const allTokens = Array.from(trackedMidTier.keys());

  await Promise.all(
    allTokens.map((tokenAddress) =>
      limit(async () => {
        const details = await fetchDexscreenerDetails(tokenAddress);
        if (!details) return;

        const mcap = details.marketCap ?? 0;
        const tokenCreatedAt = details.pairCreatedAt ?? Date.now();
        const ageMinutes = getTokenAgeMinutes(tokenCreatedAt);

        if (mcap >= 80000 && ageMinutes <= 120 && !trackedHighTier.has(tokenAddress)) {
          await sendToDiscord(details, HIGH_TIER_WEBHOOK_CLIENT);
          trackedHighTier.set(tokenAddress, Date.now());
          log(`🔥 Re-sent ${tokenAddress} to HIGH-TIER after breakout: mcap=$${mcap}`);
        }
      })
    )
  );
}

checkTokens();
scheduleNextPoll();
