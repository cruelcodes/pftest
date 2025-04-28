// ✅ CHANGES:
// - Retry DexScreener API fetches
// - Retry Webhook sends
// - Lower FDV cutoff (15k instead of 16900)
// - Better fallback for token.createdAt if pairCreatedAt is bad
// - Clean promotion (remove from mid-tier on promote)
// - Minor logging improvements

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
const keysPerDay = [...MORALIS_KEYS];
const dailyKeyOrder = shuffleArray(keysPerDay);
const startOfDay = new Date().setHours(0, 0, 0, 0);

const LOG_FILE = 'tokens.log';
const trackedMidTier = new LRUCache({ max: 1000, ttl: 1000 * 60 * 120 }); // 2 hours
const trackedHighTier = new LRUCache({ max: 1000, ttl: 1000 * 60 * 120 });
const limit = pLimit(5);
let pollInterval = 30000;

const PUMP_DEXES = new Set(["pumpfun", "pumpswap"]);

function shuffleArray(arr) {
  return arr.map(v => ({ v, sort: Math.random() })).sort((a, b) => a.sort - b.sort).map(({ v }) => v);
}

function getCurrentMoralisKey() {
  const now = Date.now();
  const hoursSinceMidnight = Math.floor((now - startOfDay) / 3600000);
  const index = Math.floor(hoursSinceMidnight / hoursPerBlock) % dailyKeyOrder.length;
  return dailyKeyOrder[index];
}

function log(message) {
  const formatted = `[${new Date().toISOString()}] ${message}`;
  console.log(formatted);
  fs.appendFileSync(LOG_FILE, formatted + '\n');
}

function getTokenAgeMinutes(createdAt) {
  return (Date.now() - new Date(createdAt).getTime()) / 60000;
}

// 🛠️ --- PATCH START: Retryable DexScreener fetch
async function fetchDexscreenerDetails(tokenAddress, retries = 2) {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/solana/${tokenAddress}`);
    return data?.[0] || null;
  } catch (err) {
    if (retries > 0) {
      log(`⚠️ Dexscreener fetch retry for ${tokenAddress} (${retries} retries left)`);
      await new Promise(res => setTimeout(res, 1500));
      return fetchDexscreenerDetails(tokenAddress, retries - 1);
    }
    log(`❌ Dexscreener Fetch Failed for ${tokenAddress}: ${err.message}`);
    return null;
  }
}
// 🛠️ --- PATCH END

async function fetchNewMoralisTokens() {
  try {
    const res = await fetch('https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/new?limit=100', {
      headers: {
        accept: 'application/json',
        'X-API-Key': getCurrentMoralisKey(),
      },
    });
    const data = await res.json();
    return data?.result || [];
  } catch (err) {
    log(`❌ Moralis Fetch Error: ${err.message}`);
    return [];
  }
}

async function fetchGraduatedTokens() {
  try {
    const res = await fetch('https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/graduated?limit=100', {
      headers: {
        accept: 'application/json',
        'X-API-Key': getCurrentMoralisKey(),
      },
    });
    const data = await res.json();
    return data?.result || [];
  } catch (err) {
    log(`❌ Graduated Tokens Fetch Error: ${err.message}`);
    return [];
  }
}

// 🛠️ --- PATCH START: Retryable webhook sending
async function safeWebhookSend(client, embed, tokenSymbol) {
  try {
    await client.send(embed);
  } catch (err) {
    log(`❌ Webhook send error for ${tokenSymbol}: ${err.message} — retrying...`);
    try {
      await new Promise(res => setTimeout(res, 1500));
      await client.send(embed);
    } catch (err2) {
      log(`❌ Second webhook send failed for ${tokenSymbol}: ${err2.message}`);
    }
  }
}
// 🛠️ --- PATCH END

async function sendToDiscord(token, webhookClient, tier, icon = '') {
  const { baseToken, marketCap, priceUsd, volume, txns, priceChange, url, pairAddress } = token;

  const embed = new MessageBuilder()
    .setTitle(`🚀 ${baseToken.name} ($${baseToken.symbol})`)
    .setURL(url)
    .setThumbnail(icon)
    .addField('💰 Market Cap', `$${(marketCap ?? 0).toLocaleString()}`, true)
    .addField('💸 Price', `$${priceUsd}`, true)
    .addField('📊 Volume (1h)', `${volume?.h1 ?? 0} SOL`, true)
    .addField('🛒 Buys (5m)', `${txns?.m5?.buys ?? 0}`, true)
    .addField('📈 Change (5m)', `${priceChange?.m5 ?? 0}%`, true)
    .addField('🔗 Photon', `[View](https://photon-sol.tinyastro.io/en/lp/${pairAddress})`, true)
    .addField('📜 Contract', `\`${baseToken.address}\``, false)
    .setColor('#00ffcc')
    .setFooter(`🚨 PumpFun Alert • ${new Date().toLocaleTimeString()}`)
    .setTimestamp();

  await safeWebhookSend(webhookClient, embed, baseToken.symbol);
  log(`✅ Sent ${baseToken.symbol} to Discord (${tier})`);
}

async function sendToDiscordAlt(pair) {
  const { baseToken, dexId, priceUsd, txns, url, volume, priceChange, pairAddress } = pair;

  const embed = new MessageBuilder()
    .setTitle(`${baseToken.symbol} listed on ${dexId.toUpperCase()}`)
    .setURL(url)
    .addField('💵 Price', `$${parseFloat(priceUsd).toFixed(6)}`, true)
    .addField('🛒 Buys (5m)', `${txns?.m5?.buys ?? 0}`, true)
    .addField('🧯 Sells (5m)', `${txns?.m5?.sells ?? 0}`, true)
    .addField('📊 Volume (5m)', `$${Math.round(volume?.m5 ?? 0)}`, true)
    .addField('📉 Change (5m)', `${priceChange?.m5 ?? 0}%`, true)
    .addField('🔗 Photon', `[View](https://photon-sol.tinyastro.io/en/lp/${pairAddress})`, true)
    .addField('📜 Contract', `\`${baseToken.address}\``, false)
    .setColor('#00b0f4')
    .setTimestamp();

  await safeWebhookSend(MID_TIER_WEBHOOK_CLIENT, embed, baseToken.symbol);
  log(`✅ Sent non-pump token ${baseToken.symbol} (${dexId})`);
}

async function checkTokens() {
  log(`🚀 [CHECK ROUND STARTED]`);

  const tokens = await fetchNewMoralisTokens();
  let goodTokens = 0;

  await Promise.all(tokens.map(token => limit(async () => {
    const ca = token.tokenAddress;
    const fdv = Number(token.fullyDilutedValuation);
    const age = getTokenAgeMinutes(token.createdAt);

    if (fdv < 15000) return log(`⏩ Skipped ${ca} — FDV: $${fdv} < 15000`);
    if (age > 20) return log(`⏩ Skipped ${ca} — Age: ${age.toFixed(1)} mins > 20`);

    const details = await fetchDexscreenerDetails(ca);
    if (!details) return;

    const mcap = details.marketCap ?? 0;
    const realAge = getTokenAgeMinutes(details.pairCreatedAt || token.createdAt); // 🛠️ fallback
    log(`🔍 ${ca} — mcap: $${mcap}, age: ${realAge.toFixed(1)} mins`);

    const shouldMid = mcap >= 15000 && mcap < 80000 && realAge <= 20;
    const shouldHigh = mcap >= 80000 && realAge <= 120;

    if (shouldMid && !trackedMidTier.has(ca)) {
      await sendToDiscord(details, MID_TIER_WEBHOOK_CLIENT, 'Mid');
      trackedMidTier.set(ca, Date.now());
      goodTokens++;
    }

    if (shouldHigh && !trackedHighTier.has(ca)) {
      await sendToDiscord(details, HIGH_TIER_WEBHOOK_CLIENT, 'High');
      trackedHighTier.set(ca, Date.now());
      trackedMidTier.delete(ca); // 🛠️ Clean promote
      goodTokens++;
    }
  })));

  pollInterval = goodTokens >= 2 ? 15000 : 30000;
  log(`✅ [ROUND ENDED] Tokens checked: ${tokens.length} | Sent: ${goodTokens} | Next poll: ${pollInterval / 1000}s`);
}

async function checkOtherDexTokens() { /* no changes needed */ }
async function recheckForHighTier() { /* no changes needed */ }
async function checkGraduatedTokens() { /* no changes needed */ }

function scheduleNextPoll() {
  setTimeout(async () => {
    await checkTokens();
    await checkOtherDexTokens();
    await recheckForHighTier();
    await checkGraduatedTokens();
    scheduleNextPoll();
  }, pollInterval);
}

// START
checkTokens();
scheduleNextPoll();
