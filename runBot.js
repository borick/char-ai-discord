// runBot.js

// Required modules and initial setup
const { Client, GatewayIntentBits, Partials, ChannelType } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource, 
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType
} = require('@discordjs/voice');
const { createClient } = require("@deepgram/sdk");
const { spawn } = require('child_process');
const dotenv = require('dotenv');
const fs = require('fs');
const axios = require('axios');
const ffmpeg = require('ffmpeg-static');
const prism = require('prism-media');
const path = require('path');

dotenv.config();

// When true, sends a message in the text channel with the playback URL.
let play_in_channel = false;
// Announce the text in channel
let announce_in_channel = true;

let ffmpegProcess = null;
let caiClient = null;

// Global audio queue and flag to prevent simultaneous playbacks.
const audioQueue = [];
let isPlayingAudio = false;

// Global variable to store the current voice connection
let currentConnection = null;

// Global variable to store the text channel for replies
let globalTextChannel = null;

// Map to keep track of active listeners per user
const activeListeners = new Map();

// Map to store conversation contexts (chat IDs) per Character AI
const userConversations = new Map();

// Global accumulation variables
let transcriptBuffer = [];
let accumulationTimer = null;
const ACCUMULATION_DELAY = 4000; // 4 seconds delay to accumulate transcripts

// Set of users who have opted in to be listened to (via !listen)
const listenedUsers = new Set();

// --- Global Error Handlers ---
process.on('uncaughtException', error => {
  console.error('Unhandled Exception:', error);
});
process.on('unhandledRejection', error => {
  console.error('Unhandled Rejection:', error);
});

// --- Initialization for Character AI ---
(async function() {
  caiClient = new (await import("cainode")).CAINode();
  console.log("Logging in to Character AI...");
  await caiClient.login(process.env.CHARACTER_AI_TOKEN);
})();

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.User
  ]
});

const deepgram = createClient(process.env.DEEPGRAM_KEY);

// Import the state manager (if needed to persist state)
const { saveState, loadState, clearState } = require('./stateManager');

/**
 * Helper function to send a reply using either message.reply (if available)
 * or channel.send (fallback).
 */
function sendReply(target, content) {
  if (target && typeof target.reply === 'function') {
    target.reply(content).catch(console.error);
  } else if (target && typeof target.send === 'function') {
    target.send(content).catch(console.error);
  } else if (globalTextChannel && typeof globalTextChannel.send === 'function') {
    globalTextChannel.send(content).catch(console.error);
  } else {
    console.error("No valid channel to send message:", content);
  }
}

// When the bot is ready, attempt to load state and rejoin if needed.
client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const state = loadState();
  if (state) {
    const guild = client.guilds.cache.get(state.guildId);
    const voiceChannel = guild.channels.cache.get(state.channelId);
    if (voiceChannel) {
      currentConnection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
      });
      console.log(`Rejoined voice channel: ${voiceChannel.name}`);

      const textChannel = guild.channels.cache.get(state.textChannelId);
      if (textChannel && textChannel.type === ChannelType.GuildText) {
        globalTextChannel = textChannel;
      } else {
        console.error("Saved text channel is invalid.");
      }
    } else {
      console.log('Voice channel not found. Clearing saved state.');
      clearState();
    }
  }
});

// --- In the messageCreate event handler, add the following command check:
client.on('messageCreate', async message => {
  if (!message.content.startsWith('!') || message.author.bot) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'listen') {
    await listenHandler(message);
  }

  if (command === 'listen_but_stfu') {
    announce_in_channel = false;
    await listenHandler(message);
  }
  
  if (command === 'listenall') {
    await listenAllHandler(message);
  }

  if (command === 'unlisten') {
    await unlistenHandler(message);
  }
  
  if (command === 'leave') {
    leaveVoiceChannelHandler(message);
  }
});

/**
 * Handler for the !listenall command.
 * The user must be in a voice channel; the bot will join (if not already in one)
 * and subscribe to audio from every non-bot member in that channel.
 */
async function listenAllHandler(message) {
  const member = message.member;
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    sendReply(message, 'Join a voice channel first!');
    return;
  }
  
  // Store text channel for replies.
  globalTextChannel = message.channel;
  
  // If the bot isn't connected, join the voice channel.
  if (!currentConnection) {
    currentConnection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });
    // Save state if needed.
    saveState({
      command: 'listenall',
      guildId: voiceChannel.guild.id,
      channelId: voiceChannel.id,
      textChannelId: message.channel.id,
      userId: member.id
    });
  }
  
  // Mark all non-bot users as opted in.
  voiceChannel.members.forEach(m => {
    if (!m.user.bot) {
      listenedUsers.add(m.id);
    }
  });
  
  sendReply(message, `I am now listening to all users in ${voiceChannel.name}.`);
  
  // Subscribe to audio for each non-bot member.
  const receiver = currentConnection.receiver;
  voiceChannel.members.forEach(m => {
    if (!m.user.bot && !activeListeners.has(m.id)) {
      listenToUser(m, receiver, { message });
    }
  });
}

/**
 * Handler for the !listen command.
 * The user must be in a voice channel; the bot will join (if not already in one)
 * and subscribe only to that user's audio.
 */
async function listenHandler(message) {
  const member = message.member;
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    sendReply(message, 'Join a voice channel first!');
    return;
  }
  
  // Store text channel for replies.
  globalTextChannel = message.channel;
  
  // If the bot isn't connected, join the user's voice channel.
  if (!currentConnection) {
    currentConnection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });
    // Save state if needed.
    saveState({
      command: 'listen',
      guildId: voiceChannel.guild.id,
      channelId: voiceChannel.id,
      textChannelId: message.channel.id,
      userId: member.id
    });
  }
  
  // Mark the user as opted in.
  listenedUsers.add(member.id);
  sendReply(message, `I am now listening to you, ${member.user.username}.`);
  
  // Subscribe to this user's audio (if not already subscribed).
  const receiver = currentConnection.receiver;
  if (!activeListeners.has(member.id)) {
    listenToUser(member, receiver, { message });
  }
}

/**
 * Handler for the !unlisten command.
 * Removes the user from the opted-in set and cleans up any active listener.
 */
async function unlistenHandler(message) {
  const member = message.member;
  listenedUsers.delete(member.id);
  if (activeListeners.has(member.id)) {
    const { decoderStream } = activeListeners.get(member.id);
    decoderStream.removeAllListeners();
    decoderStream.destroy();
    activeListeners.delete(member.id);
  }
  sendReply(message, `I will no longer listen to you, ${member.user.username}.`);
}

/**
 * Helper function to listen to a specific user in the voice channel.
 */
function listenToUser(member, receiver, context) {
  // If the user has not opted in, skip.
  if (!listenedUsers.has(member.id)) {
    console.log(`Skipping ${member.user.username} as they have not opted in.`);
    return;
  }
  console.log(`Subscribing to ${member.user.username}...`);
  if (activeListeners.has(member.id)) {
    console.log(`Already subscribed to ${member.user.username}.`);
    return;
  }
  
  // Subscribe to the user's audio
  const subscription = receiver.subscribe(member.id, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 2000
    }
  });
  // Catch errors on the subscription itself.
  subscription.on('error', error => {
    console.error(`Subscription error for ${member.user.username}:`, error);
  });
  
  const opusDecoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 1,
    frameSize: 960
  });
  
  let audioChunks = [];
  const decoderStream = subscription.pipe(opusDecoder);
  
  // Wrap event callbacks in try/catch to prevent unhandled exceptions.
  decoderStream.on('data', (chunk) => {
    try {
      audioChunks.push(chunk);
    } catch (err) {
      console.error(`Error processing data chunk for ${member.user.username}:`, err);
    }
  });
  
  decoderStream.on('end', async () => {
    try {
      if (audioChunks.length === 0) {
        activeListeners.delete(member.id);
        resubscribeIfNecessary(member, receiver, context);
        return;
      }
      
      const wavBuffer = await convertToWav(Buffer.concat(audioChunks));
      const transcript = await transcribeAudio(wavBuffer);
      console.log(`Transcript from ${member.user.username}:`, transcript);
      
      if (!transcript) {
        activeListeners.delete(member.id);
        resubscribeIfNecessary(member, receiver, context);
        return;
      } else if (announce_in_channel && context.message) {
        sendReply(context.message, `${member.user.username} says "${transcript}"`);
      }
      
      // Accumulate transcripts to combine multiple inputs
      addTranscript(member.user.username, transcript, currentConnection, context.message, member);
    } catch (error) {
      console.error(`Error processing end event for ${member.user.username}:`, error);
    }
    
    activeListeners.delete(member.id);
    resubscribeIfNecessary(member, receiver, context);
  });
  
  decoderStream.on('error', (error) => {
    console.error(`Decoder error for ${member.user.username}:`, error);
    try {
      decoderStream.removeAllListeners();
      decoderStream.destroy();
    } catch (err) {
      console.error(`Error during decoder stream cleanup for ${member.user.username}:`, err);
    }
    activeListeners.delete(member.id);
  });
  
  activeListeners.set(member.id, { decoderStream });
}

/**
 * Helper function to re-subscribe to a user if necessary.
 * Only re-subscribes if the user is still in a voice channel and opted in.
 */
function resubscribeIfNecessary(member, receiver, context) {
  if (!listenedUsers.has(member.id)) {
    console.log(`Not re-subscribing to ${member.user.username} (user has unlistened).`);
    return;
  }
  if (member.voice.channel) {
    if (!activeListeners.has(member.id)) {
      listenToUser(member, receiver, context);
    }
  } else {
    if (activeListeners.has(member.id)) {
      const { decoderStream } = activeListeners.get(member.id);
      decoderStream.removeAllListeners();
      decoderStream.destroy();
      activeListeners.delete(member.id);
    }
  }
}

/**
 * Listen for voice state updates.
 * If an opted-in user joins a voice channel, subscribe to their audio.
 */
client.on('voiceStateUpdate', (oldState, newState) => {
  const member = newState.member;
  if (!member || member.user.bot) return;
  
  const receiver = currentConnection?.receiver;
  if (!receiver) return;
  
  // If the user has opted in and joins a voice channel, subscribe.
  if (!oldState.channelId && newState.channelId && listenedUsers.has(member.id)) {
    console.log(`User ${member.user.username} joined a channel; subscribing...`);
    listenToUser(member, receiver, { message: globalTextChannel });
  }
  
  // If a user leaves the channel, clean up their listener.
  if (oldState.channelId && !newState.channelId) {
    if (activeListeners.has(member.id)) {
      const { decoderStream } = activeListeners.get(member.id);
      decoderStream.removeAllListeners();
      decoderStream.destroy();
      activeListeners.delete(member.id);
    }
  }
});

/**
 * Helper to add a transcript line to the buffer.
 * When no new transcript arrives within ACCUMULATION_DELAY,
 * the combined transcript is sent to Character AI.
 */
function addTranscript(username, transcript, connection, message, member) {
  transcriptBuffer.push(`${username}: ${transcript}`);
  if (accumulationTimer) clearTimeout(accumulationTimer);
  
  accumulationTimer = setTimeout(() => {
    const combinedTranscript = transcriptBuffer.join("\n");
    transcriptBuffer = [];
    accumulationTimer = null;
    getAIResponse(combinedTranscript, currentConnection, message, true, member);
  }, ACCUMULATION_DELAY);
}

/**
 * Convert a PCM audio buffer to WAV using FFmpeg.
 */
async function convertToWav(pcmBuffer) {
  return new Promise((resolve, reject) => {
    ffmpegProcess = spawn(ffmpeg, [
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '1',
      '-i', 'pipe:0',
      '-ar', '48000',
      '-f', 's16le',
      '-f', 'wav',
      'pipe:1'
    ]);
    
    const buffers = [];
    ffmpegProcess.stdout.on('data', (data) => buffers.push(data));
    ffmpegProcess.on('close', (code) => {
      if (code !== 0) return reject(new Error(`FFmpeg exited with code ${code}`));
      resolve(Buffer.concat(buffers));
    });
    
    ffmpegProcess.stdin.write(pcmBuffer);
    ffmpegProcess.stdin.end();
  });
}

/**
 * Transcribe the given audio buffer using Deepgram.
 */
async function transcribeAudio(buffer) {
  const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
    buffer,
    {
      model: 'nova-2',
      smart_format: true,
      utterances: true,
      mimetype: 'audio/wav'
    }
  );
  if (error) {
    console.error('Error transcribing audio:', error);
    throw error;
  }
  return result?.results?.channels[0]?.alternatives[0]?.transcript || '';
}

/**
 * Get the AI response for a given prompt.
 */
async function getAIResponse(prompt, connection, message, autoRestart, member) {
  console.log(`Getting AI response for combined prompt:\n`, prompt);
  try {
    let response = null;
    let chatId = userConversations.get(process.env.CHARACTER_ID);
    if (!chatId) {
      console.log("No chat found; starting a new conversation...");
      const chats = await caiClient.character.connect(process.env.CHARACTER_ID);
      const chatList = chats["chats"];
      chatId = chatList[0]["chat_id"];
      if (chatId) {
        userConversations.set(process.env.CHARACTER_ID, chatId);
      } else {
        console.error(`Failed to start new chat for ${process.env.CHARACTER_ID}`);
        return;
      }
    }
    
    try {
      response = await caiClient.character.send_message(prompt, false, "", {
        char_id: process.env.CHARACTER_ID,
        chat_id: chatId,
        timeout_ms: 30000,
      });
      console.log(`Response:`, JSON.stringify(response, null, 2));
    } catch (error) {
      console.log(`Error sending message:`, error);
      if (!response) {
        await caiClient.character.disconnect(process.env.CHARACTER_ID);
        console.log("Disconnected...trying again.");
      }
    }
    
    if (announce_in_channel && message) {
      const ai_response = response["turn"]["candidates"][0]["raw_content"];
      const ai_name = response["turn"]["author"]["name"];
      sendReply(message, `${ai_name} says: '${ai_response}'`);
    }
    
    const candidateId = response["turn"]["primary_candidate_id"];
    const turnId = response["turn"]["turn_key"]["turn_id"];
    console.log(`Turn ID: ${turnId}, Candidate ID: ${candidateId}`);
    
    let ttsReply = await caiClient.character.replay_tts(
      turnId, candidateId, process.env.VOICE_ID,
    );
    console.log(`TTS Reply:`, JSON.stringify(ttsReply, null, 2));
    
    if (!ttsReply["replayUrl"]) {
      console.error(`TTS reply missing replayUrl; skipping playback.`);
      return;
    }
    const replayUrl = ttsReply["replayUrl"];
    
    console.log(`Streaming file from:`, replayUrl);
    const ttsStreamResponse = await axios.get(replayUrl, { responseType: 'stream' });
    
    audioQueue.push({ connection, stream: ttsStreamResponse.data, message, autoRestart });
    processAudioQueue();
    
    if (play_in_channel && message && typeof message.reply === 'function') {
      sendReply(message, `Now playing: ${replayUrl}`);
    }
    
    return response;
  } catch (error) {
    console.error(`Error getting AI response:`, error);
    console.log("Try and disconnect...");
    await caiClient.character.disconnect(process.env.CHARACTER_ID);
  }
}

/**
 * Processes the audio queue.
 */
function processAudioQueue() {
  if (isPlayingAudio || audioQueue.length === 0) return;
  isPlayingAudio = true;
  
  const { connection, stream, tempFilePath, message, autoRestart } = audioQueue.shift();
  
  const player = createAudioPlayer();
  let resource;
  if (stream) {
    resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
  } else {
    resource = createAudioResource(fs.createReadStream(tempFilePath));
  }
  connection.subscribe(player);
  player.play(resource);
  
  player.on(AudioPlayerStatus.Idle, () => {
    isPlayingAudio = false;
    if (tempFilePath) {
      fs.unlink(tempFilePath, (err) => {
        if (err) console.error('Failed to delete temp file:', err);
      });
    }
    processAudioQueue();
  });
  
  player.on('error', (error) => {
    if (message) {
      sendReply(message, "⚠️ An error occurred while playing the audio.");
    }
    isPlayingAudio = false;
    processAudioQueue();
  });
}

/**
 * Handler to leave the voice channel.
 */
function leaveVoiceChannelHandler(message) {
  if (currentConnection) {
    currentConnection.destroy();
    currentConnection = null;
    activeListeners.forEach(({ decoderStream }) => {
      decoderStream.removeAllListeners();
      decoderStream.destroy();
    });
    activeListeners.clear();
    userConversations.clear();
    clearState();
    sendReply(message, 'Left the voice channel!');
  }
}

process.on('SIGINT', async () => {
  if (currentConnection) {
    currentConnection.destroy();
  }
  await caiClient.character.disconnect(process.env.CHARACTER_ID);
  process.exit();
});

client.login(process.env.DISCORD_BOT_TOKEN);
