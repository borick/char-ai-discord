// index.js

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

// When true, sends a message in the text channel with the playback URL.
const play_in_channel = false;
// Announce the text in channel
const announce_in_channel = true;

dotenv.config();

let ffmpegProcess = null;
let caiClient = null;

// Global audio queue and flag to prevent simultaneous playbacks.
const audioQueue = [];
let isPlayingAudio = false;

// Global variable to store the voice channel ID being listened to (for joinall mode)
let listeningChannelId = null;

// Global variable to store the text channel so we can reply
let globalTextChannel = null;

// Map to keep track of active listeners per user
const activeListeners = new Map();

// Map to store conversation contexts per user (currently used for chat session IDs)
const userConversations = new Map();

// Global variables for accumulating transcripts
let accumulatedTranscript = "";
let accumulationTimer = null;

(async function() {
  caiClient = new (await import("cainode")).CAINode();
  console.log("Logging in...");
  await caiClient.login(process.env.CHARACTER_AI_TOKEN);
})();

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
let currentConnection;

// Import the state manager (ensure it saves and loads textChannelId as well)
const { saveState, loadState, clearState } = require('./stateManager');

/**
 * Helper function to send a reply using either message.reply (for message objects)
 * or channel.send (for channel objects).
 */
function sendReply(target, content) {
  console.log('sendReply target:', target);
  if (target && typeof target.reply === 'function') {
    console.log('Using reply() method.');
    target.reply(content).catch(console.error);
  } else if (target && typeof target.send === 'function') {
    console.log('Using send() method.');
    target.send(content).catch(console.error);
  } else if (globalTextChannel && typeof globalTextChannel.send === 'function') {
    console.log('Using globalTextChannel.send() as fallback.');
    globalTextChannel.send(content).catch(console.error);
  } else {
    console.error("No valid channel available to send message:", content);
  }
}

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  // Load state
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

      // Retrieve the saved text channel using the saved textChannelId.
      const textChannel = guild.channels.cache.get(state.textChannelId);
      if (!textChannel || textChannel.type !== ChannelType.GuildText) {
        console.error("Saved channel is not a valid text channel. Cannot rejoin using the original command channel.");
        return;
      }
      // Explicitly set globalTextChannel to this valid text channel.
      globalTextChannel = textChannel;

      // Build a proper mock message object using the saved text channel.
      const message = { member: guild.members.cache.get(state.userId), channel: textChannel };

      if (state.command === 'join') {
        await joinVoiceChannelHandler(message, true);
      } else if (state.command === 'joinall') {
        await joinAllVoiceChannelHandler(message, true);
      }
    } else {
      console.log('Voice channel not found. Clearing saved state.');
      clearState();
    }
  }
});

client.on('messageCreate', async message => {
  if (!message.content.startsWith('!') || message.author.bot) return;

  const args = message.content.slice(1).split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'join') {
    joinVoiceChannelHandler(message);
  }

  if (command === 'joinall') {
    joinAllVoiceChannelHandler(message);
  }

  if (command === 'leave') {
    leaveVoiceChannelHandler(message);
  }
});

/**
 * Handler for the original join command that listens to just the command issuer.
 */
async function joinVoiceChannelHandler(message, isRejoin = false) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    if (!isRejoin) sendReply(message, 'Join a voice channel first!');
    return;
  }

  // Store the text channel for later replies.
  globalTextChannel = message.channel;

  currentConnection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  // Clear the global channel tracker (this is single-user mode)
  listeningChannelId = null;

  // Save state (including the text channel's ID)
  saveState({
    command: 'join',
    guildId: voiceChannel.guild.id,
    channelId: voiceChannel.id,
    textChannelId: message.channel.id,
    userId: message.member.id
  });

  const receiver = currentConnection.receiver;

  // Clean up existing listener if any
  if (activeListeners.has(message.member.id)) {
    const { decoderStream } = activeListeners.get(message.member.id);
    decoderStream.removeAllListeners();
    decoderStream.destroy();
    activeListeners.delete(message.member.id);
  }

  // Subscribe only to the command issuer
  listenToUser(message.member, receiver, { message });
  if (!isRejoin) sendReply(message, `Listening to ${message.author.username}...`);
}

/**
 * New handler for the joinall command.
 * This joins the caller's voice channel and subscribes to every non-bot member's audio.
 */
async function joinAllVoiceChannelHandler(message, isRejoin = false) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    if (!isRejoin) sendReply(message, 'Join a voice channel first!');
    return;
  }

  // Store the text channel for later replies.
  globalTextChannel = message.channel;

  // Store the channel ID globally for joinall mode
  listeningChannelId = voiceChannel.id;

  currentConnection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  // Save state (including text channel ID)
  saveState({
    command: 'joinall',
    guildId: voiceChannel.guild.id,
    channelId: voiceChannel.id,
    textChannelId: message.channel.id,
    userId: message.member.id
  });

  if (!isRejoin) sendReply(message, `Listening to everyone in ${voiceChannel.name}...`);

  const receiver = currentConnection.receiver;
  // Subscribe to all current non-bot members in the channel
  voiceChannel.members.forEach(member => {
    if (member.user.bot) return;
    listenToUser(member, receiver, { voiceChannel, message });
  });
}

/**
 * Helper function to listen to a specific user in the voice channel.
 */
function listenToUser(member, receiver, context) {
  console.log(`Listening to ${member.user.username}...`);
  // Check if there's already an active listener
  if (activeListeners.has(member.id)) {
    console.log(`Already listening to ${member.user.username}, skipping.`);
    return;
  }

  const subscription = receiver.subscribe(member.id, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 2000
    }
  });

  const opusDecoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 1,
    frameSize: 960
  });

  let audioChunks = [];
  const decoderStream = subscription.pipe(opusDecoder);

  decoderStream.on('data', (chunk) => {
    audioChunks.push(chunk);
  });

  decoderStream.on('end', async () => {
    if (audioChunks.length === 0) {
      activeListeners.delete(member.id);
      resubscribeIfNecessary(member, receiver, context);
      return;
    }

    try {
      const wavBuffer = await convertToWav(Buffer.concat(audioChunks));
      const transcript = await transcribeAudio(wavBuffer);
      console.log(`Transcript from ${member.user.username}:`, transcript);

      if (!transcript) {
        console.log('Empty response retrieved, returning');
        activeListeners.delete(member.id);
        resubscribeIfNecessary(member, receiver, context);
        return;
      } else if (announce_in_channel && context.message) {
        sendReply(context.message, `${member.user.username} says "${transcript}"`);
      }

      // Append the transcript in the format "username: message"
      accumulatedTranscript += `${member.user.username}: ${transcript}\n`;

      // Reset the accumulation timer so that we combine transcripts received close together.
      if (accumulationTimer) clearTimeout(accumulationTimer);
      accumulationTimer = setTimeout(() => {
        // When no new transcript comes in within 2 seconds, send the accumulated prompt.
        // Using the last member info for logging purposes.
        getAIResponse(accumulatedTranscript, currentConnection, context.message, true, member);
        accumulatedTranscript = "";
        accumulationTimer = null;
      }, 2000);

    } catch (error) {
      console.error(`Error processing audio from ${member.user.username}:`, error);
    }

    activeListeners.delete(member.id);
    resubscribeIfNecessary(member, receiver, context);
  });

  decoderStream.on('error', (error) => {
    console.error(`Decoder stream error for ${member.user.username}:`, error);
    decoderStream.removeAllListeners();
    decoderStream.destroy();
    activeListeners.delete(member.id);
  });

  activeListeners.set(member.id, { decoderStream });
}

/**
 * Helper function to re-subscribe to a user if necessary.
 */
function resubscribeIfNecessary(member, receiver, context) {
  console.log(`Re-subscribing to ${member.user.username}...`);
  if (member.voice.channel) {
    if (listeningChannelId && member.voice.channel.id === listeningChannelId) {
      if (!activeListeners.has(member.id)) {
        listenToUser(member, receiver, context);
      }
    } else if (context && context.voiceChannel && member.voice.channel.id === context.voiceChannel.id) {
      if (!activeListeners.has(member.id)) {
        listenToUser(member, receiver, context);
      }
    } else {
      listenToUser(member, receiver, context);
    }
  } else {
    if (activeListeners.has(member.id)) {
      const { decoderStream } = activeListeners.get(member.id);
      decoderStream.removeAllListeners();
      decoderStream.destroy();
      activeListeners.delete(member.id);
    }
    if (userConversations.has(member.id)) {
      userConversations.delete(member.id);
    }
  }
}

/**
 * Listen for new members joining or leaving the voice channel in joinall mode.
 */
client.on('voiceStateUpdate', (oldState, newState) => {
  const member = newState.member;
  const receiver = currentConnection?.receiver;

  if (oldState.guild.id !== newState.guild.id) return;

  // User left the voice channel we're listening to
  if (oldState.channelId === listeningChannelId && newState.channelId !== listeningChannelId) {
    if (!member.user.bot && activeListeners.has(member.id)) {
      const { decoderStream } = activeListeners.get(member.id);
      decoderStream.removeAllListeners();
      decoderStream.destroy();
      activeListeners.delete(member.id);
      userConversations.delete(member.id);
      console.log(`Stopped listening to ${member.user.username} as they left the channel.`);
    }
  }

  // User joined the voice channel we're listening to
  if ((oldState.channelId !== listeningChannelId) && (newState.channelId === listeningChannelId)) {
    if (!member.user.bot && receiver) {
      console.log(`New member joined: ${member.user.username}`);
      // Use the stored globalTextChannel (which should be the original text channel)
      listenToUser(member, receiver, { voiceChannel: member.voice.channel, message: globalTextChannel });
    }
  }
});

/**
 * Convert PCM audio buffer to WAV using FFmpeg.
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
  console.log(`Getting AI response for combined prompt:`, prompt);
  // Note: 'member' here is the last speaker who triggered a transcript.
  try {
    let response = null;
    // Retrieve or create conversation context
    let chatId = userConversations.get(process.env.CHARACTER_ID);

    if (!chatId) {
      console.log("No chat found for conversation, starting a new one...");
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
      console.log(ai_name, ": ", ai_response);
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
      console.error(`TTS reply did not contain a replayUrl, skipping TTS playback.`);
      return;
    }
    const replayUrl = ttsReply["replayUrl"];

    console.log(`Streaming file from:`, replayUrl);
    const ttsStreamResponse = await axios.get(replayUrl, { responseType: 'stream' });

    console.log(`Queueing playback...`);
    audioQueue.push({ connection, stream: ttsStreamResponse.data, message, autoRestart });
    processAudioQueue();

    if (play_in_channel && message && typeof message.reply === 'function') {
      sendReply(message, `Now playing: ${replayUrl}`);
    }
    console.log(`TTS Reply:`, JSON.stringify(ttsReply, null, 2));

    return response;
  } catch (error) {
    console.error(`Error getting AI response:`, error);
    throw error;
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
    console.log('Creating audio resource from stream...');
    resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
  } else {
    console.log('Creating audio resource from file...');
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
    console.log('Finished playback.');
    console.log('Auto-restart:', autoRestart);
    console.log('Message:', JSON.stringify(message, null, 2));
    processAudioQueue();
  });

  player.on('error', (error) => {
    console.error("Error in audio player:", error);
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
    listeningChannelId = null;

    activeListeners.forEach(({ decoderStream }, memberId) => {
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
  console.log('Disconnecting...');
  if (currentConnection) {
    currentConnection.destroy();
  }
  await caiClient.character.disconnect(process.env.CHARACTER_ID);
  process.exit();
});

client.login(process.env.DISCORD_BOT_TOKEN);
